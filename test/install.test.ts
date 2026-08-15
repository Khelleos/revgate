import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const skillSource = path.join(repoRoot, ".github", "skills");

/** Run git in the repo root and return its stdout. Rejects on a non-zero exit. */
function runGit(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`)),
    );
  });
}

async function readJson(...segments: string[]): Promise<any> {
  const file = path.join(repoRoot, ...segments);
  const rel = segments.join("/");
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    assert.fail(`${rel}: invalid JSON — ${(err as Error).message}`);
  }
}

// --- installer -------------------------------------------------------------

test("install.ps1: installs the revgate bin globally, guarded by -SkipBuild", async () => {
  const script = await readFile(path.join(repoRoot, "install.ps1"), "utf8");
  // The skills shell out to `revgate`, so an install that leaves the bin off
  // PATH ships skills that fail on first use.
  assert.match(script, /& npm install -g \./, "install.ps1 never runs `npm install -g .`");
  // -SkipBuild must bail out BEFORE that npm call: the tests below run this
  // script for real, but `npm install -g` writes to the real npm prefix. A
  // source-text check, since a probe would trigger the escape it guards.
  assert.match(
    script,
    /function Install-Bin[\s\S]*?if \(\$SkipBuild\)[\s\S]*?return[\s\S]*?& npm install -g \./,
    "Install-Bin does not return on -SkipBuild before the global npm install",
  );
});

/**
 * Run install.ps1 against a temp %USERPROFILE%, so no real hook or skill
 * directory is touched. Every caller passes -SkipBuild: without it the installer
 * rewrites node_modules/ and dist/ under the rest of the suite. Windows-only.
 */
async function runInstaller(args: string[], home: string): Promise<{ code: number; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        path.join(repoRoot, "install.ps1"), ...args],
      { cwd: repoRoot, windowsHide: true, env: { ...process.env, USERPROFILE: home } },
    );
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

test("install.ps1: a plain run writes the global hook in the documented shape and installs both skills", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  // A plain run must deliver everything: the global plan hook AND the skills. A
  // wrong hook target means the gate silently never fires.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { code, stderr } = await runInstaller(["-SkipBuild", "-Timeout", "42"], home);
  assert.equal(code, 0, `installer failed: ${stderr}`);

  const written = JSON.parse(
    await readFile(path.join(home, ".copilot", "hooks", "revgate.json"), "utf8"),
  );
  assert.equal(written.version, 1);
  assert.deepEqual(Object.keys(written.hooks).sort(), ["preToolUse"]);
  const [hook] = written.hooks.preToolUse;
  assert.equal(hook.type, "command");
  // -Timeout must interpolate as a number, not a quoted string: this is JSON.
  assert.equal(hook.timeoutSec, 42);
  assert.match(hook.bash, /dist\/index\.js/);
  assert.equal(hook.bash.includes("\\"), false, "the hook path must use forward slashes");
  assert.match(hook.bash, /copilot-plan[;\s]/);

  // The commands must survive this clone moving or dist/ being cleaned:
  // preToolUse fails CLOSED, so an unguarded `node <gone>` denies every tool call.
  assert.match(hook.bash, /^if \[ -f "/, "bash: no existence guard");
  assert.match(hook.powershell, /^if \(Test-Path "/, "powershell: no existence guard");
  for (const shell of ["bash", "powershell"] as const) {
    assert.match(hook[shell], /\{"permissionDecision":"allow"\}/, `${shell}: missing the fail-open decision`);
  }

  // Byte-identically, or an edited SKILL.md would drift on install.
  for (const name of ["revgate-review", "revgate-plan"]) {
    const installed = path.join(home, ".copilot", "skills", name, "SKILL.md");
    assert.ok(
      (await readFile(installed)).equals(await readFile(path.join(skillSource, name, "SKILL.md"))),
      `${name}/SKILL.md was not installed byte-identically`,
    );
  }
}, { timeout: 120_000 });

test("install.ps1: a clone path containing $ still yields a working hook", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");

  // `$` is legal in a Windows directory name and both hook shells expand it at
  // RUN time, so an unescaped path resolves elsewhere and the gate silently
  // allows everything. Run the real script from a clone whose path carries one.
  const base = await mkdtemp(path.join(os.tmpdir(), "revgate-src-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const src = path.join(base, "has$dollar");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "install.ps1"), await readFile(path.join(repoRoot, "install.ps1")));
  await writeFile(path.join(src, "dist", "index.js"), "// stub entry\n", "utf8");
  for (const name of ["revgate-review", "revgate-plan"]) {
    await mkdir(path.join(src, ".github", "skills", name), { recursive: true });
    await writeFile(
      path.join(src, ".github", "skills", name, "SKILL.md"),
      `---\nname: ${name}\n---\n`,
      "utf8",
    );
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { spawn } = await import("node:child_process");
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
          path.join(src, "install.ps1"), "-SkipBuild"],
        { cwd: src, windowsHide: true, env: { ...process.env, USERPROFILE: home } },
      );
      let err = "";
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.stdout.resume();
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c ?? -1, stderr: err }));
    },
  );
  assert.equal(code, 0, `installer failed: ${stderr}`);

  const written = JSON.parse(
    await readFile(path.join(home, ".copilot", "hooks", "revgate.json"), "utf8"),
  );
  const [hook] = written.hooks.preToolUse;
  // After JSON decoding: bash must see `\$` (escaped for its double quotes),
  // PowerShell must see `` `$ `` — both render the literal directory name.
  assert.ok(
    hook.bash.includes("has\\$dollar/dist/index.js"),
    `bash path not escaped for run-time expansion: ${hook.bash}`,
  );
  assert.ok(
    hook.powershell.includes("has`$dollar/dist/index.js"),
    `powershell path not escaped for run-time expansion: ${hook.powershell}`,
  );
}, { timeout: 120_000 });

test("install.ps1 -Uninstall: removes the hook and the skills; twice is a no-op", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  // A broken -Uninstall leaves a hook that denies every tool call.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const hookFile = path.join(home, ".copilot", "hooks", "revgate.json");

  const installed = await runInstaller(["-SkipBuild"], home);
  assert.equal(installed.code, 0, `installer failed: ${installed.stderr}`);
  await stat(hookFile);
  await stat(path.join(home, ".copilot", "skills", "revgate-review", "SKILL.md"));

  // -Uninstall mirrors the install: hook AND skills.
  const removed = await runInstaller(["-Uninstall"], home);
  assert.equal(removed.code, 0, `uninstall failed: ${removed.stderr}`);
  await assert.rejects(stat(hookFile), "the global hook was left behind");
  await assert.rejects(
    stat(path.join(home, ".copilot", "skills", "revgate-review")),
    "the skills the install wrote were left behind",
  );

  // Twice is a no-op: a user unsure whether it worked must be able to re-run it.
  const again = await runInstaller(["-Uninstall"], home);
  assert.equal(again.code, 0, `a second uninstall failed: ${again.stderr}`);
}, { timeout: 180_000 });

test("install.ps1 -Uninstall: works even when the source tree is gone", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");

  // The checkout may already be gone, so uninstall reads the INSTALLED skills.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installed = path.join(home, ".copilot", "skills", "revgate-review");
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, "SKILL.md"), "---\nname: revgate-review\n---\n", "utf8");

  const { code, stderr } = await runInstaller(["-Uninstall", "-SkipBuild"], home);
  assert.equal(code, 0, `uninstall failed: ${stderr}`);
  await assert.rejects(stat(installed), "the installed skill was left behind");
}, { timeout: 120_000 });

// --- installed artifacts must never be committed ---------------------------

test("no machine-specific hook file is committed to the repo", async () => {
  // A hand-copied .github/hooks/revgate.json carries an absolute path to one
  // machine; committed, every other clone gets a hook that cannot run. Ask git,
  // not the filesystem: a leftover working-tree copy is not a committed one.
  const { stdout } = await runGit(["ls-files", "--", ".github/hooks"]);
  assert.equal(
    stdout.trim(),
    "",
    ".github/hooks/ is machine-specific — `git rm --cached` it; .gitignore already covers it",
  );

  const gitignore = await readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.github\/hooks\/$/m, ".gitignore no longer covers .github/hooks/");
});

test("hooks/revgate.json: the hand-edited template wires the plan gate correctly", async () => {
  // Hand-edited: without `copilot-plan` every tool call runs bare `revgate`, a
  // usage error, so the gate silently never fires.
  const template = await readJson("hooks", "revgate.json");
  assert.equal(template.version, 1);
  assert.deepEqual(Object.keys(template.hooks).sort(), ["preToolUse"]);

  const list = template.hooks.preToolUse;
  assert.ok(Array.isArray(list) && list.length === 1, "preToolUse: expected exactly one entry");
  const [hook] = list;
  assert.equal(hook.type, "command");
  assert.ok(typeof hook.comment === "string" && hook.comment.length > 0, "preToolUse: no comment");
  assert.ok(
    Number.isInteger(hook.timeoutSec) && hook.timeoutSec > 0,
    "preToolUse: timeoutSec must be a positive integer — a review is a human waiting",
  );
  for (const shell of ["bash", "powershell"] as const) {
    // Guarded on the entry point existing, so `node` is embedded, not leading.
    assert.match(hook[shell], /\bnode "[^"]*" copilot-plan\b/, `preToolUse.${shell}: wrong command or subcommand`);
    assert.match(hook[shell], /dist[\\/]index\.js/, `preToolUse.${shell}: wrong entry point`);
  }
});

test("hooks/revgate.json: the template fails open on a path that does not exist", async () => {
  const template = await readJson("hooks", "revgate.json");
  // Whoever copies this substitutes their own clone path, and preToolUse fails
  // CLOSED: a typo would deny the whole session. The guard makes it dormant instead.
  const [hook] = template.hooks.preToolUse;
  assert.match(hook.bash, /^if \[ -f "/, "preToolUse bash: no existence guard on the entry point");
  assert.match(hook.powershell, /^if \(Test-Path "/, "preToolUse powershell: no existence guard");
  for (const shell of ["bash", "powershell"] as const) {
    assert.match(hook[shell], /\{"permissionDecision":"allow"\}/, `preToolUse.${shell}: missing the fail-open decision`);
  }
});

test("hooks/revgate.json: the committed template is machine-independent", async () => {
  // $HOME placeholders only: a real absolute path breaks every other clone.
  const rel = "hooks/revgate.json";
  const text = await readFile(path.join(repoRoot, ...rel.split("/")), "utf8");
  JSON.parse(text); // must stay parseable
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, `${rel}: an absolute Windows path leaked in`);
  assert.doesNotMatch(text, /"(bash|powershell)": "[^"]*\/(home|Users)\//, `${rel}: a real home path leaked in`);
});
