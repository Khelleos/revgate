// Guards on `package.json` a refactor can break silently. A glob the shell
// expands instead of the runner is the dangerous case: a green run over a
// fraction of the suite looks exactly like a green run over all of it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repoRoot, walk } from "./helpers/tree.js";

const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  scripts: Record<string, string>;
};

const files = await walk(path.join(repoRoot, "test"), ".test.ts");

test("the test suite lives at more than one directory depth", () => {
  // Without both depths the quoting check below proves nothing: a shell that
  // expands `**` as a single `*` gives the same answer as the runner does.
  const depths = new Set(files.map((f) => f.split("/").length));
  assert.ok(depths.has(2), "no test file sits directly in test/");
  assert.ok(depths.has(3), "no test file sits in a test/ subdirectory");
});

test("the test script quotes its glob, so the runner expands it and not the shell", () => {
  const script = pkg.scripts.test;
  assert.match(script, /"test\/\*\*\/\*\.test\.ts"/, `test script must quote its glob: ${script}`);
});

test("the bin entry point stays at the root of dist/", () => {
  // `install.ps1` and the installed hook both spell this path out.
  assert.equal(pkg.bin.revgate, "dist/index.js");
});
