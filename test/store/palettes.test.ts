import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_THEMES, PALETTE_KEYS, isKnownThemeId } from "../../src/store/palettes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// --- drift guard -----------------------------------------------------------

/** Every `:root { … }` block in the stylesheet, parsed into property → value maps. */
function rootBlocks(css: string): Record<string, string>[] {
  return [...css.matchAll(/:root\s*\{/g)].map((match) => {
    const open = css.indexOf("{", match.index);
    const end = css.indexOf("}", open);
    assert.ok(end > open, ":root block is unterminated");
    const declared: Record<string, string> = {};
    for (const [, prop, value] of css.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:([^;]+);/g)) {
      declared[prop] = value.trim();
    }
    return declared;
  });
}

test("the CSS :root blocks and the palettes they hard-code have not drifted", async () => {
  const css = await readFile(path.join(repoRoot, "public", "app.css"), "utf8");
  const blocks = rootBlocks(css);
  // Both are checked, not just the first: the light one paints the default
  // (system) user's first frame, so a gap there is the more visible half.
  assert.equal(blocks.length, 2, "expected a dark :root and a prefers-color-scheme: light one");
  const [dark, light] = blocks;

  // Without this the CSS can grow a --x that no non-default theme defines, and
  // every theme but the built-in dark default silently shows the dark value.
  assert.deepEqual(
    Object.keys(dark).sort(),
    [...PALETTE_KEYS, "--mono"].sort(),
    "public/app.css :root and PALETTE_KEYS have drifted apart",
  );
  // The same set minus the font stack, which is not themeable and so is
  // declared once rather than re-stated per colour scheme.
  assert.deepEqual(
    Object.keys(light).sort(),
    [...PALETTE_KEYS].sort(),
    "the prefers-color-scheme: light block and PALETTE_KEYS have drifted apart",
  );

  // Values, not just key sets: each block is a hand-copy of a built-in, and
  // retuning that built-in in src/store/palettes.ts otherwise drifts silently —
  // every load then flashes the stale colour until /api/themes lands, and keeps
  // it for good when that fetch fails and the picker is omitted.
  for (const [id, block] of [
    ["dark-modern", dark],
    ["light-modern", light],
  ] as const) {
    const palette = BUILTIN_THEMES.find((theme) => theme.id === id);
    assert.ok(palette, `${id} is no longer a built-in`);
    for (const [prop, value] of Object.entries(palette.colors)) {
      assert.equal(block[prop], value, `public/app.css ${prop} has drifted from ${id}`);
    }
  }
});
