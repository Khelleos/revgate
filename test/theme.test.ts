import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_THEMES,
  PALETTE_KEYS,
  configDir,
  configFile,
  isKnownThemeId,
  listThemes,
  readThemeConfig,
  writeThemeConfig,
} from "../src/theme.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Throwaway directories to point `$REVGATE_CONFIG_DIR` at, removed at exit. */
const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revgate-theme-"));
  temps.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/**
 * Run `fn` with `$REVGATE_CONFIG_DIR` pointed at `dir` and stderr captured, so
 * a degraded path can be asserted on without polluting the test output.
 */
async function withConfigDir<T>(
  dir: string | undefined,
  fn: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
  const savedEnv = process.env.REVGATE_CONFIG_DIR;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  if (dir === undefined) delete process.env.REVGATE_CONFIG_DIR;
  else process.env.REVGATE_CONFIG_DIR = dir;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = originalWrite;
    if (savedEnv === undefined) delete process.env.REVGATE_CONFIG_DIR;
    else process.env.REVGATE_CONFIG_DIR = savedEnv;
  }
}

// --- directory resolution --------------------------------------------------

test("configDir: $REVGATE_CONFIG_DIR beats ~/.revgate, and names the directory", () => {
  const saved = process.env.REVGATE_CONFIG_DIR;
  try {
    delete process.env.REVGATE_CONFIG_DIR;
    assert.equal(configDir(), path.join(os.homedir(), ".revgate"));
    assert.equal(configFile(), path.join(os.homedir(), ".revgate", "config.json"));

    process.env.REVGATE_CONFIG_DIR = "   ";
    assert.equal(configDir(), path.join(os.homedir(), ".revgate"));

    const custom = path.join(os.tmpdir(), "from-env");
    process.env.REVGATE_CONFIG_DIR = custom;
    assert.equal(configDir(), custom);
    // The file name is never the caller's to choose.
    assert.equal(configFile(), path.join(custom, "config.json"));

    process.env.REVGATE_CONFIG_DIR = "cfg";
    assert.equal(configDir(), path.resolve("cfg"));
  } finally {
    if (saved === undefined) delete process.env.REVGATE_CONFIG_DIR;
    else process.env.REVGATE_CONFIG_DIR = saved;
  }
});

// --- the built-in palettes -------------------------------------------------

test("five built-ins ship, each with a unique id and both types represented", () => {
  assert.equal(BUILTIN_THEMES.length, 5);
  assert.deepEqual(
    BUILTIN_THEMES.map((t) => t.id),
    ["dark-modern", "light-modern", "monokai", "solarized-light", "dracula"],
  );
  assert.equal(new Set(BUILTIN_THEMES.map((t) => t.id)).size, 5);
  for (const theme of BUILTIN_THEMES) {
    assert.ok(theme.name.length > 0, `${theme.id} has no display name`);
    assert.ok(theme.type === "dark" || theme.type === "light", `${theme.id} has a bad type`);
  }
  assert.ok(BUILTIN_THEMES.some((t) => t.type === "light"));
  assert.ok(BUILTIN_THEMES.some((t) => t.type === "dark"));
});

test("every built-in defines exactly PALETTE_KEYS — nothing merges over a base", () => {
  const expected = [...PALETTE_KEYS].sort();
  for (const theme of BUILTIN_THEMES) {
    assert.deepEqual(
      Object.keys(theme.colors).sort(),
      expected,
      `${theme.id} does not define exactly the palette keys`,
    );
    for (const [key, value] of Object.entries(theme.colors)) {
      assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/, `${theme.id} ${key} is not a hex colour`);
    }
  }
  // --mono is the font stack, which is not themeable.
  assert.ok(!PALETTE_KEYS.includes("--mono" as (typeof PALETTE_KEYS)[number]));
});

test("every selection colour is translucent, so the diff tint shows through", () => {
  for (const theme of BUILTIN_THEMES) {
    assert.equal(theme.colors["--sel"].length, 9, `${theme.id} --sel has no alpha channel`);
  }
});

test("isKnownThemeId covers the built-ins and system, and nothing else", () => {
  assert.equal(isKnownThemeId("system"), true);
  for (const theme of BUILTIN_THEMES) assert.equal(isKnownThemeId(theme.id), true);
  assert.equal(isKnownThemeId("nope"), false);
  assert.equal(isKnownThemeId(""), false);
  assert.equal(isKnownThemeId(undefined), false);
  assert.equal(isKnownThemeId(42), false);
});

// --- config persistence ----------------------------------------------------

test("config round-trip: what writeThemeConfig saves, readThemeConfig returns", async () => {
  const dir = await tempDir();
  const { result } = await withConfigDir(dir, async () => {
    const ok = await writeThemeConfig("dracula");
    const config = await readThemeConfig();
    const onDisk = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")) as unknown;
    return { ok, config, onDisk };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { theme: "dracula" });
  assert.deepEqual(result.onDisk, { theme: "dracula" });
});

test("writeThemeConfig creates the config directory when it does not exist", async () => {
  const dir = path.join(await tempDir(), "nested", "deeper");
  const { result } = await withConfigDir(dir, async () => {
    const ok = await writeThemeConfig("monokai");
    return { ok, config: await readThemeConfig() };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { theme: "monokai" });
});

test("overlapping writes serialize — the last pick wins and every one reports success", async () => {
  const dir = await tempDir();
  const { result } = await withConfigDir(dir, async () => {
    // The picker POSTs once per `change`, and a focused <select> fires one per
    // arrow keypress, so this is the ordinary case rather than a stress test.
    const oks = await Promise.all([
      writeThemeConfig("monokai"),
      writeThemeConfig("dracula"),
      writeThemeConfig("solarized-light"),
    ]);
    return { oks, config: await readThemeConfig(), entries: await readdir(dir) };
  });
  // Unqueued these share one temp path: a rename can land between another
  // call's write and its own rename, so one fails with ENOENT and the id left
  // on disk is whichever won the race — an earlier pick, silently.
  assert.deepEqual(result.oks, [true, true, true], "a concurrent write reported failure");
  assert.deepEqual(result.config, { theme: "solarized-light" });
  assert.deepEqual(result.entries, ["config.json"], "a temp file survived the race");
});

test("writeThemeConfig leaves no temp file behind", async () => {
  const dir = await tempDir();
  const { result } = await withConfigDir(dir, async () => {
    await writeThemeConfig("monokai");
    await writeThemeConfig("dracula");
    return readdir(dir);
  });
  assert.deepEqual(result.sort(), ["config.json"]);
});

test("a missing config defaults to system, silently — that is the first run", async () => {
  const dir = await tempDir();
  const { result, stderr } = await withConfigDir(dir, () => readThemeConfig());
  assert.deepEqual(result, { theme: "system" });
  assert.equal(stderr, "");
});

test("a config that exists but cannot be read warns, unlike a missing one", async () => {
  const dir = await tempDir();
  // A directory where the file belongs: readFile fails with something that is
  // not ENOENT, on any platform. This is the branch that separates "first run"
  // from "something is wrong" — invert the check and every first run warns.
  await mkdir(path.join(dir, "config.json"), { recursive: true });
  const { result, stderr } = await withConfigDir(dir, () => readThemeConfig());
  assert.deepEqual(result, { theme: "system" });
  assert.match(stderr, /could not read/);
});

test("a malformed config degrades to system without throwing", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "config.json"), "{ not json at all", "utf8");
  const { result, stderr } = await withConfigDir(dir, async () => ({
    config: await readThemeConfig(),
    listing: await listThemes(),
  }));
  assert.deepEqual(result.config, { theme: "system" });
  assert.equal(result.listing.selected, "system");
  assert.match(stderr, /malformed/);
});

test("a config that is valid JSON but the wrong shape degrades to system", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "config.json"), '["dracula"]', "utf8");
  const { result } = await withConfigDir(dir, () => readThemeConfig());
  assert.deepEqual(result, { theme: "system" });

  await writeFile(path.join(dir, "config.json"), '{"theme":7}', "utf8");
  const second = await withConfigDir(dir, () => readThemeConfig());
  assert.deepEqual(second.result, { theme: "system" });
});

test("a stale saved id falls back to system rather than leaving the page unstyled", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "config.json"), '{"theme":"from-a-future-version"}', "utf8");
  const { result } = await withConfigDir(dir, () => listThemes());
  // readThemeConfig reports what is on disk; listThemes is where it is resolved.
  assert.equal(result.selected, "system");
  assert.equal(result.themes.length, 5);
});

test("an unwritable config directory warns and returns false, it never throws", async () => {
  const parent = await tempDir();
  const blocker = path.join(parent, "blocker");
  // A file where a directory needs to be: mkdir cannot succeed, on any platform.
  await writeFile(blocker, "not a directory", "utf8");
  const { result, stderr } = await withConfigDir(path.join(blocker, "revgate"), async () => ({
    ok: await writeThemeConfig("dracula"),
    // The read path has to survive the same directory.
    config: await readThemeConfig(),
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.config, { theme: "system" });
  assert.match(stderr, /could not save theme/);
});

test("listThemes: a saved built-in comes back selected, with every palette", async () => {
  const dir = await tempDir();
  const { result } = await withConfigDir(dir, async () => {
    await writeThemeConfig("solarized-light");
    return listThemes();
  });
  assert.equal(result.selected, "solarized-light");
  assert.deepEqual(
    result.themes.map((t) => t.id),
    BUILTIN_THEMES.map((t) => t.id),
  );
});

test("listThemes: system is a real saved value, not just the missing-config default", async () => {
  const dir = await tempDir();
  const { result } = await withConfigDir(dir, async () => {
    await writeThemeConfig("dracula");
    await writeThemeConfig("system");
    return listThemes();
  });
  assert.equal(result.selected, "system");
});

// --- drift guard -----------------------------------------------------------

/** Every `:root { … }` block in the page, parsed into property → value maps. */
function rootBlocks(html: string): Record<string, string>[] {
  return [...html.matchAll(/:root\s*\{/g)].map((match) => {
    const open = html.indexOf("{", match.index);
    const end = html.indexOf("}", open);
    assert.ok(end > open, ":root block is unterminated");
    const declared: Record<string, string> = {};
    for (const [, prop, value] of html.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:([^;]+);/g)) {
      declared[prop] = value.trim();
    }
    return declared;
  });
}

test("the CSS :root blocks and the palettes they hard-code have not drifted", async () => {
  const html = await readFile(path.join(repoRoot, "public", "index.html"), "utf8");
  const blocks = rootBlocks(html);
  // Both are checked, not just the first: the light one paints the default
  // (system) user's first frame, so a gap there is the more visible half.
  assert.equal(blocks.length, 2, "expected a dark :root and a prefers-color-scheme: light one");
  const [dark, light] = blocks;

  // Without this the CSS can grow a --x that no non-default theme defines, and
  // every theme but the built-in dark default silently shows the dark value.
  assert.deepEqual(
    Object.keys(dark).sort(),
    [...PALETTE_KEYS, "--mono"].sort(),
    "public/index.html :root and PALETTE_KEYS have drifted apart",
  );
  // The same set minus the font stack, which is not themeable and so is
  // declared once rather than re-stated per colour scheme.
  assert.deepEqual(
    Object.keys(light).sort(),
    [...PALETTE_KEYS].sort(),
    "the prefers-color-scheme: light block and PALETTE_KEYS have drifted apart",
  );

  // Values, not just key sets: each block is a hand-copy of a built-in, and
  // retuning that built-in in src/theme.ts otherwise drifts silently — every
  // load then flashes the stale colour until /api/themes lands, and keeps it
  // for good when that fetch fails and the picker is omitted.
  for (const [id, block] of [
    ["dark-modern", dark],
    ["light-modern", light],
  ] as const) {
    const palette = BUILTIN_THEMES.find((theme) => theme.id === id);
    assert.ok(palette, `${id} is no longer a built-in`);
    for (const [prop, value] of Object.entries(palette.colors)) {
      assert.equal(block[prop], value, `public/index.html ${prop} has drifted from ${id}`);
    }
  }
});
