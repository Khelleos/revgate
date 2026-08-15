"""Running the real entry point as a real process.

`revgate` owns two mutually exclusive output contracts (annotations on stdout
for `review`, preToolUse JSON for `plan`), so it is exercised as a
subprocess — that is the only way to observe exit codes and stream discipline
honestly.

Everything here keeps **bytes**. A string comparison passes on a build that
writes CRLF or cp1252, which is exactly the class of fault these tests exist to
catch on Windows.
"""

import contextlib
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0

#: Nothing here should ever take this long.
TIMEOUT = 60


@dataclass(slots=True)
class RunResult:
    """One finished run, kept as bytes."""

    code: int
    stdout: bytes
    stderr: bytes

    @property
    def out(self) -> str:
        return self.stdout.decode("utf-8", errors="replace")

    @property
    def err(self) -> str:
        return self.stderr.decode("utf-8", errors="replace")


def _env(overrides: dict[str, str] | None) -> dict[str, str]:
    env = dict(os.environ)
    # Never let a test touch the developer's real review history.
    env.setdefault("REVGATE_HISTORY_DIR", str(Path(env.get("TEMP", ".")) / "revgate-test-unused"))
    env.update(overrides or {})
    return env


def launch(
    args: list[str], cwd: str | Path | None = None, env: dict[str, str] | None = None
) -> subprocess.Popen[bytes]:
    """Start the entry point without waiting for it."""
    return subprocess.Popen(
        [sys.executable, "-m", "revgate", *args],
        cwd=cwd,
        env=_env(env),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
    )


def run(
    args: list[str],
    cwd: str | Path | None = None,
    stdin: str | None = None,
    env: dict[str, str] | None = None,
) -> RunResult:
    """Run to completion. Only for invocations that never open the review page."""
    process = launch(args, cwd=cwd, env=env)
    try:
        stdout, stderr = process.communicate((stdin or "").encode("utf-8"), timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        raise
    return RunResult(code=process.returncode, stdout=stdout, stderr=stderr)


class Streamer:
    """Collects a running child's output without blocking on it."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self.process = process
        self.stdout = bytearray()
        self.stderr = bytearray()

        def pump(source: object, sink: bytearray) -> None:
            read = getattr(source, "readline", None)
            if read is None:
                return
            for line in iter(read, b""):
                sink += line

        self._threads = [
            threading.Thread(target=pump, args=(process.stdout, self.stdout), daemon=True),
            threading.Thread(target=pump, args=(process.stderr, self.stderr), daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def err(self) -> str:
        return bytes(self.stderr).decode("utf-8", errors="replace")

    def out(self) -> str:
        return bytes(self.stdout).decode("utf-8", errors="replace")

    def wait_for_url(self, deadline: float = 30.0) -> str:
        """Wait for the review server's URL to show up on stderr."""
        end = time.monotonic() + deadline
        while time.monotonic() < end:
            match = re.search(r"http://127\.0\.0\.1:\d+/", self.err())
            if match:
                return match.group(0)
            if self.process.poll() is not None:
                raise AssertionError(f"process exited before serving; stderr:\n{self.err()}")
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for the UI url; stderr:\n{self.err()}")

    def finish(self, deadline: float = TIMEOUT) -> RunResult:
        code = self.process.wait(timeout=deadline)
        for thread in self._threads:
            thread.join(timeout=5)
        self._close()
        return RunResult(code=code, stdout=bytes(self.stdout), stderr=bytes(self.stderr))

    def kill(self) -> RunResult:
        self.process.kill()
        return self.finish()

    def _close(self) -> None:
        """Close the pipes the child left behind.

        `filterwarnings = ["error"]` turns an unclosed one into a test failure,
        which is the point: a leaked handle on Windows keeps the child's working
        directory locked and the temp-repo cleanup then fails.
        """
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            if pipe is not None and not pipe.closed:
                with contextlib.suppress(OSError, ValueError):
                    pipe.close()
