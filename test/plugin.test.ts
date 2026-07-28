import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pluginDir = path.join(repoRoot, "copilot-plugin");
const skillSource = path.join(repoRoot, ".github", "skills");
const skillPackaged = path.join(pluginDir, "skills");

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

const pkg = await readJson("package.json");
const plugin = await readJson("copilot-plugin", "plugin.json");
const hooks = await readJson("copilot-plugin", "hooks.json");
const marketplace = await readJson(".github", "plugin", "marketplace.json");

// --- plugin.json -----------------------------------------------------------

test("plugin.json: has the keys Copilot needs to install the plugin", () => {
  assert.equal(plugin.name, "revgate-copilot");
  assert.ok(typeof plugin.description === "string" && plugin.description.length >= 40);
  assert.equal(plugin.license, "MIT");
  // Author may be a string or an object; either way it must carry a name.
  const authorName = typeof plugin.author === "string" ? plugin.author : plugin.author?.name;
  assert.ok(authorName, "plugin.json has no author");
});

test("plugin.json: version tracks package.json", () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+/, "version is not semver-ish");
  assert.equal(plugin.version, pkg.version, "bump copilot-plugin/plugin.json alongside package.json");
});

// --- hooks.json ------------------------------------------------------------

test("hooks.json: wires only the plan gate, to the revgate bin on PATH", () => {
  assert.equal(hooks.version, 1);

  // The plan gate is revgate's ONE automatic hook — an agentStop entry
  // reappearing here would silently re-introduce the removed diff gate.
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["preToolUse"]);

  const list = hooks.hooks?.preToolUse;
  assert.ok(Array.isArray(list) && list.length === 1, "preToolUse: expected exactly one hook entry");
  const [hook] = list;
  assert.equal(hook.type, "command");
  for (const shell of ["bash", "powershell"] as const) {
    // The plugin assumes a global install, so the commands invoke the bare bin
    // name — install.ps1 is the path that pins absolute `node dist/index.js`
    // commands. The call is wrapped in a fail-open guard (see below), so it is
    // matched rather than compared.
    assert.match(hook[shell], /\brevgate copilot-plan\b/, `preToolUse.${shell}: wrong command`);
    assert.doesNotMatch(hook[shell], /dist[\\/]index\.js/, `preToolUse.${shell}: must not pin a repo path`);
  }
  assert.ok(typeof hook.comment === "string" && hook.comment.length > 0, "preToolUse: no comment");
  assert.ok(
    Number.isInteger(hook.timeoutSec) && hook.timeoutSec > 0,
    "preToolUse: timeoutSec must be a positive integer — a review is a human waiting",
  );
});

test("hooks.json: the plan gate fails open when the bin is not installed", () => {
  // `/plugin install revgate-copilot@revgate` succeeds without ever putting the
  // bin on PATH — nothing in copilot-plugin/ installs it, and plugin.json
  // promises the gate stays dormant until it is there. preToolUse fails CLOSED
  // on a non-zero exit, so unguarded it would exit 127 and deny EVERY tool call
  // for the whole session. Both shells must probe for the bin and print the
  // explicit allow in the preToolUse contract.
  const [hook] = hooks.hooks.preToolUse;
  assert.match(hook.bash, /command -v revgate/, "preToolUse.bash: no probe for the bin");
  assert.match(hook.powershell, /Get-Command revgate/, "preToolUse.powershell: no probe for the bin");
  for (const shell of ["bash", "powershell"] as const) {
    assert.match(hook[shell], /\{"permissionDecision":"allow"\}/, `preToolUse.${shell}: missing the fail-open decision`);
  }
});

test("hooks.json: never shells out to a path that only exists on the author's machine", () => {
  const text = JSON.stringify(hooks);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, "an absolute Windows path leaked into the plugin hooks");
  assert.doesNotMatch(text, /\$HOME|USERPROFILE/, "a home-relative path leaked into the plugin hooks");
});

// --- marketplace.json ------------------------------------------------------

test("marketplace.json: declares the marketplace and lists the plugin", () => {
  assert.ok(marketplace.name, "marketplace has no name");
  const owner = typeof marketplace.owner === "string" ? marketplace.owner : marketplace.owner?.name;
  assert.ok(owner, "marketplace has no owner");
  assert.ok(Array.isArray(marketplace.plugins), "marketplace.plugins is not an array");

  const entry = marketplace.plugins.find((p: any) => p.name === plugin.name);
  assert.ok(entry, `marketplace does not list ${plugin.name}`);
  assert.equal(entry.version, pkg.version, "marketplace entry version must track package.json");
  assert.ok(typeof entry.description === "string" && entry.description.length >= 40);
  assert.ok(typeof entry.source === "string" && entry.source.length > 0, "marketplace entry has no source");
});

test("marketplace.json: the plugin source path actually exists", async () => {
  const entry = marketplace.plugins.find((p: any) => p.name === plugin.name);
  const source = path.resolve(repoRoot, entry.source);
  const info = await stat(source);
  assert.ok(info.isDirectory(), `${entry.source} is not a directory`);
  // A plugin source without its manifest installs to nothing.
  await stat(path.join(source, "plugin.json"));
});

test("package.json: ships the plugin directory to npm consumers", () => {
  assert.ok(pkg.files.includes("copilot-plugin"), "copilot-plugin missing from package.json files");
  assert.equal(pkg.scripts["sync:skills"], "tsx scripts/sync-skills.ts");
});

// --- packaged skills: the sync:skills drift guard --------------------------

/** Every file under `dir`, relative and slash-separated, sorted. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(path.join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found.sort();
}

test("packaged skills: same file list as .github/skills", async () => {
  const source = await walk(skillSource);
  assert.ok(source.length > 0, ".github/skills is empty");
  assert.deepEqual(
    await walk(skillPackaged),
    source,
    "copilot-plugin/skills has drifted — run `npm run sync:skills`",
  );
});

test("packaged skills: byte-identical to .github/skills", async () => {
  for (const rel of await walk(skillSource)) {
    const expected = await readFile(path.join(skillSource, rel));
    const actual = await readFile(path.join(skillPackaged, rel));
    assert.ok(
      actual.equals(expected),
      `copilot-plugin/skills/${rel} differs from .github/skills/${rel} — run \`npm run sync:skills\``,
    );
  }
});

/**
 * Run `scripts/sync-skills.ts` with the given arguments, through the same `tsx`
 * the npm script uses.
 */
function runSync(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve("tsx/cli"), path.join(repoRoot, "scripts", "sync-skills.ts"), ...args],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

test("sync:skills --check: passes on a synced tree and fails on a stale one", async (t) => {
  // The byte-compare tests above prove the trees MATCH; they say nothing about
  // whether the script that keeps them matching works. A `--check` stuck at exit
  // 0 would let CI wave through a stale package, and the removal branch for a
  // file the source no longer has is only reachable from here.
  const fresh = await runSync(["--check"]);
  assert.equal(fresh.code, 0, `--check failed on a synced tree: ${fresh.stderr}`);
  assert.match(fresh.stderr, /up to date/);

  // A file the source does not have: `--check` must report it and must NOT
  // delete it (that is the write mode's job), so the tree is unchanged either way.
  const probe = path.join(skillPackaged, "sync-check-probe.tmp");
  await writeFile(probe, "not from .github/skills\n", "utf8");
  t.after(() => rm(probe, { force: true }));

  const stale = await runSync(["--check"]);
  assert.equal(stale.code, 1, "--check passed a tree carrying a file the source never had");
  assert.match(stale.stderr, /out of date/);
  assert.match(stale.stderr, /sync-check-probe\.tmp/);
  await stat(probe); // still there: --check reports, it does not rewrite.

  // And the write mode removes it, leaving the tree synced again.
  const written = await runSync([]);
  assert.equal(written.code, 0, `sync:skills failed: ${written.stderr}`);
  await assert.rejects(() => stat(probe), "sync:skills left a file the source does not have");
});

// --- installer -------------------------------------------------------------

test("install.ps1: supports -Skills for install and uninstall", async () => {
  const script = await readFile(path.join(repoRoot, "install.ps1"), "utf8");
  assert.match(script, /\[switch\]\$Skills/, "install.ps1 has no -Skills switch");
  assert.match(script, /\.copilot\\skills/, "install.ps1 does not target %USERPROFILE%\\.copilot\\skills");
  assert.match(script, /function Install-Skills/);
  assert.match(script, /function Uninstall-Skills/);
  // Source-text assertions only — what -Skills actually *does* is covered by the
  // behavioural install/uninstall tests below, which run the script for real.
});

/**
 * Run install.ps1 in a sandbox: a temp %USERPROFILE% so no real skill directory
 * is touched, and -Repo pointed at a temp dir so the hook lands there.
 *
 * Every caller passes -SkipBuild. Without it the installer runs `npm install`
 * and `npm run build` in this very checkout — and node:test runs test files
 * concurrently, so node_modules/ and dist/ would be rewritten underneath the
 * ~200 other tests that resolve tsx and spawn children out of them. -SkipBuild
 * still asserts dist/index.js exists, which `npm test` guarantees (`prepare`
 * builds on install).
 *
 * Windows-only, because the installer is. Elsewhere the assertions are skipped
 * rather than faked — see the `t.skip` below.
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

test("install.ps1 -Repo: writes a hook file that is valid JSON in the documented shape", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "revgate-target-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  const { code, stderr } = await runInstaller(
    ["-Repo", target, "-Timeout", "42", "-SkipBuild"],
    home,
  );
  assert.equal(code, 0, `installer failed: ${stderr}`);

  const written = JSON.parse(
    await readFile(path.join(target, ".github", "hooks", "revgate.json"), "utf8"),
  );
  assert.equal(written.version, 1);
  assert.deepEqual(Object.keys(written.hooks).sort(), ["preToolUse"]);
  const [hook] = written.hooks.preToolUse;
  assert.equal(hook.type, "command");
  // -Timeout has to survive interpolation into the here-string as a number,
  // not a quoted string: Copilot reads this as JSON.
  assert.equal(hook.timeoutSec, 42);
  assert.match(hook.bash, /dist\/index\.js/);
  assert.equal(hook.bash.includes("\\"), false, "the hook path must use forward slashes");
  assert.match(hook.bash, /copilot-plan[;\s]/);

  // The generated commands must survive this clone being moved or dist/ being
  // cleaned. preToolUse fails CLOSED, so an unguarded `node <gone>` exits
  // non-zero and denies EVERY tool call in every session until the user finds
  // and hand-edits this file. The installer verifies dist/ at install time, but
  // nothing keeps it there afterwards.
  assert.match(hook.bash, /^if \[ -f "/, "bash: no existence guard");
  assert.match(hook.powershell, /^if \(Test-Path "/, "powershell: no existence guard");
  for (const shell of ["bash", "powershell"] as const) {
    assert.match(hook[shell], /\{"permissionDecision":"allow"\}/, `${shell}: missing the fail-open decision`);
  }
}, { timeout: 120_000 });

test("install.ps1 -Global -Skills: installs the hook and the skills together", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  // -Skills is scope-limiting on its own and redundant-but-accepted alongside
  // -Global, and the two are told apart by one predicate ($SkillsOnly). Get it
  // wrong and this documented combination silently drops half the install.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { code, stderr } = await runInstaller(["-Global", "-Skills", "-SkipBuild"], home);
  assert.equal(code, 0, `installer failed: ${stderr}`);

  const written = JSON.parse(
    await readFile(path.join(home, ".copilot", "hooks", "revgate.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(written.hooks).sort(), ["preToolUse"]);
  for (const name of ["revgate-review", "revgate-plan"]) {
    await stat(path.join(home, ".copilot", "skills", name, "SKILL.md"));
  }
}, { timeout: 120_000 });

test("install.ps1 -Uninstall -Repo: removes the hook from that repository only", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  // -Uninstall defaults to the global scope, so a broken -Repo branch would
  // report success while leaving the per-repo preToolUse hook in place — and
  // that one fails closed for everyone working in that repo.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "revgate-target-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
  const hookFile = path.join(target, ".github", "hooks", "revgate.json");

  const installed = await runInstaller(["-Repo", target, "-SkipBuild"], home);
  assert.equal(installed.code, 0, `installer failed: ${installed.stderr}`);
  await stat(hookFile);

  const removed = await runInstaller(["-Uninstall", "-Repo", target], home);
  assert.equal(removed.code, 0, `uninstall failed: ${removed.stderr}`);
  await assert.rejects(stat(hookFile), "the repo hook was left behind");
  // The skills are global and another gated repo may still be using them, so a
  // repo-scoped uninstall must leave them alone unless -Skills says otherwise.
  await stat(path.join(home, ".copilot", "skills", "revgate-review", "SKILL.md"));
}, { timeout: 180_000 });

test("install.ps1 -Global then -Uninstall: writes and removes the global hook", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  // -Global is the *recommended* install and the one nothing else covers: a
  // wrong target means the gate silently never fires, and a broken -Uninstall
  // leaves a preToolUse hook the user cannot remove — which denies every tool
  // call until they hand-edit JSON.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const hookFile = path.join(home, ".copilot", "hooks", "revgate.json");

  const installed = await runInstaller(["-Global", "-SkipBuild"], home);
  assert.equal(installed.code, 0, `installer failed: ${installed.stderr}`);

  const written = JSON.parse(await readFile(hookFile, "utf8"));
  assert.deepEqual(Object.keys(written.hooks).sort(), ["preToolUse"]);
  assert.match(written.hooks.preToolUse[0].bash, /copilot-plan[;\s]/);
  // Manual-first: a default install ships the skills alongside the plan hook,
  // with no separate -Skills required.
  for (const name of ["revgate-review", "revgate-plan"]) {
    await stat(path.join(home, ".copilot", "skills", name, "SKILL.md"));
  }

  // A plain -Uninstall mirrors the plain install: hook AND skills.
  const removed = await runInstaller(["-Uninstall"], home);
  assert.equal(removed.code, 0, `uninstall failed: ${removed.stderr}`);
  await assert.rejects(stat(hookFile), "the global hook was left behind");
  await assert.rejects(
    stat(path.join(home, ".copilot", "skills", "revgate-review")),
    "the skills the default install wrote were left behind",
  );

  // Uninstalling twice is a no-op, not an error: a user who is not sure whether
  // it worked must be able to just run it again.
  const again = await runInstaller(["-Uninstall"], home);
  assert.equal(again.code, 0, `a second uninstall failed: ${again.stderr}`);
}, { timeout: 180_000 });

test("install.ps1 -Skills: installs both skills and writes no hook", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  // Nothing else runs Install-Skills: the assertions above only match source
  // text, so a broken copy loop or a wrong $SkillTarget would ship green. And
  // -Skills falling through into Write-Hook would install a `preToolUse` hook
  // pointing at a possibly-unbuilt dist/ — which fails *closed*.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { code, stderr } = await runInstaller(["-Skills", "-SkipBuild"], home);
  assert.equal(code, 0, `installer failed: ${stderr}`);

  for (const name of ["revgate-review", "revgate-plan"]) {
    const installed = path.join(home, ".copilot", "skills", name, "SKILL.md");
    assert.ok(
      (await readFile(installed)).equals(await readFile(path.join(skillSource, name, "SKILL.md"))),
      `${name}/SKILL.md was not installed byte-identically`,
    );
  }
  await assert.rejects(
    stat(path.join(home, ".copilot", "hooks", "revgate.json")),
    "-Skills on its own must not write a hook",
  );
}, { timeout: 120_000 });

test("install.ps1 -Uninstall -Skills: works even when the source tree is gone", async (t) => {
  if (process.platform !== "win32") return t.skip("install.ps1 is a Windows installer");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");

  // Someone uninstalling revgate may well have already moved the checkout, so
  // uninstall must read the INSTALLED skills, not .github/skills.
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installed = path.join(home, ".copilot", "skills", "revgate-review");
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, "SKILL.md"), "---\nname: revgate-review\n---\n", "utf8");

  const { code, stderr } = await runInstaller(["-Uninstall", "-Skills", "-SkipBuild"], home);
  assert.equal(code, 0, `uninstall failed: ${stderr}`);
  await assert.rejects(stat(installed), "the installed skill was left behind");
}, { timeout: 120_000 });

// --- installed artifacts must never be committed ---------------------------

test("no machine-specific hook file is committed to the repo", async () => {
  // `install.ps1 -Repo .` writes .github/hooks/revgate.json with an absolute
  // path to one machine. Committed, every other clone gets a preToolUse hook
  // that cannot run — and preToolUse fails CLOSED, denying every tool call.
  //
  // Ask git, not the filesystem. The README tells developers to run
  // `install.ps1 -Repo <path>` on their own clone, which leaves exactly this
  // directory behind — a working-tree check turns the documented install into a
  // permanently red suite while never testing the word "committed" at all.
  const { stdout } = await runGit(["ls-files", "--", ".github/hooks"]);
  assert.equal(
    stdout.trim(),
    "",
    ".github/hooks/ is installer output — `git rm --cached` it; .gitignore already covers it",
  );

  const gitignore = await readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.github\/hooks\/$/m, ".gitignore no longer covers .github/hooks/");
});

test("hooks/revgate.json: the hand-edited template wires the plan gate correctly", async () => {
  // The packaged manifest gets a full shape check above; this template is edited
  // by hand and only had a "no absolute paths" guard. If its preToolUse command
  // lost the `copilot-plan` argument, every tool call would run as a bare
  // `revgate`, which is a usage error — so the plan gate would silently never
  // fire. And an agentStop entry reappearing here would re-introduce the
  // removed diff gate.
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
    // The call guards on the entry point existing, so `node …` is embedded
    // rather than leading — see the fail-open assertion below.
    assert.match(hook[shell], /\bnode "[^"]*" copilot-plan\b/, `preToolUse.${shell}: wrong command or subcommand`);
    assert.match(hook[shell], /dist[\\/]index\.js/, `preToolUse.${shell}: wrong entry point`);
  }
});

test("hooks/revgate.json: the template fails open on a path that does not exist", async () => {
  const template = await readJson("hooks", "revgate.json");
  // This template is edited by hand: whoever copies it substitutes their own
  // clone path. preToolUse fails CLOSED on a non-zero exit, so a typo in that
  // substitution would make `node` exit non-zero on every tool call and deny the
  // whole session — with no hint that the path is the reason. The guard turns it
  // into a dormant gate instead.
  const [hook] = template.hooks.preToolUse;
  assert.match(hook.bash, /^if \[ -f "/, "preToolUse bash: no existence guard on the entry point");
  assert.match(hook.powershell, /^if \(Test-Path "/, "preToolUse powershell: no existence guard");
  for (const shell of ["bash", "powershell"] as const) {
    assert.match(hook[shell], /\{"permissionDecision":"allow"\}/, `preToolUse.${shell}: missing the fail-open decision`);
  }
});

test("every hook JSON in the repo is machine-independent", async () => {
  // hooks/revgate.json is a template ($HOME placeholders a human edits);
  // copilot-plugin/hooks.json assumes the bin is on PATH. Neither may carry a
  // real absolute path, and no third one may appear without being checked.
  for (const rel of ["hooks/revgate.json", "copilot-plugin/hooks.json"]) {
    const text = await readFile(path.join(repoRoot, ...rel.split("/")), "utf8");
    JSON.parse(text); // must stay parseable
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, `${rel}: an absolute Windows path leaked in`);
    assert.doesNotMatch(text, /"(bash|powershell)": "[^"]*\/(home|Users)\//, `${rel}: a real home path leaked in`);
  }
});
