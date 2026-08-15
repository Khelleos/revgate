import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs, type ParsedArgs } from "../src/cli/args.js";
import { commandLines, toArgv } from "./helpers/docs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Skill trees to validate. `.github/skills/` is the only one: install.ps1 copies it verbatim. */
const SKILL_ROOTS = [path.join(repoRoot, ".github", "skills")];

interface Skill {
  /** Directory name, e.g. `revgate-review`. */
  dir: string;
  /** Path relative to the repo root, for readable assertion messages. */
  rel: string;
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Minimal YAML frontmatter reader — deliberately strict.
 *
 * revgate has zero runtime dependencies and no YAML parser, and a SKILL.md
 * frontmatter is a flat block of `key: value` lines. Anything richer (nesting,
 * block scalars, lists) is rejected rather than silently half-parsed, because a
 * skill Copilot cannot read is a skill that does not exist.
 */
function parseFrontmatter(text: string, rel: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  assert.ok(normalized.startsWith("---\n"), `${rel}: must open with a --- frontmatter fence`);

  const end = normalized.indexOf("\n---\n", 3);
  assert.notEqual(end, -1, `${rel}: frontmatter fence is never closed`);

  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    assert.ok(match, `${rel}: frontmatter line is not a flat key: value pair — ${JSON.stringify(line)}`);
    const [, key, rawValue] = match;
    assert.ok(!(key in frontmatter), `${rel}: duplicate frontmatter key ${key}`);
    // Strip a matching pair of surrounding quotes, the way YAML would.
    frontmatter[key] = rawValue.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  }

  return { frontmatter, body: normalized.slice(end + 5) };
}

/** Every SKILL.md under the roots that exist. */
async function loadSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const root of SKILL_ROOTS) {
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      // Skipping a missing root would silently retire every assertion below
      // it — a deleted skill tree would read as a green suite.
      assert.fail(
        `${path.relative(repoRoot, root)}: skill root is missing — ${(err as Error).message}`,
      );
    }
    for (const dir of entries) {
      const file = path.join(root, dir, "SKILL.md");
      try {
        await stat(file);
      } catch {
        assert.fail(`${path.relative(repoRoot, path.join(root, dir))}: no SKILL.md in skill directory`);
      }
      const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
      const text = await readFile(file, "utf8");
      skills.push({ dir, rel, ...parseFrontmatter(text, rel) });
    }
  }
  return skills;
}

const skills = await loadSkills();

test("skills: the review and plan skills both exist", () => {
  const names = skills.filter((s) => s.rel.startsWith(".github/")).map((s) => s.dir).sort();
  assert.deepEqual(names, ["revgate-plan", "revgate-review"]);
});

for (const skill of skills) {
  test(`${skill.rel}: frontmatter is complete and matches its directory`, () => {
    const { name, description } = skill.frontmatter;
    assert.ok(name, "frontmatter has no name");
    assert.ok(description, "frontmatter has no description");
    // Copilot matches a skill by description, so an empty-ish one is useless.
    assert.ok(description.length >= 40, `description is too short to match on: ${description}`);
    assert.equal(name, skill.dir, "frontmatter name must equal the skill directory name");
    assert.ok(skill.frontmatter["argument-hint"], "frontmatter has no argument-hint");
    assert.ok(skill.body.trim().length > 0, "skill body is empty");
  });
}

// --- docs/CLI drift guard --------------------------------------------------

for (const skill of skills) {
  test(`${skill.rel}: every documented revgate command parses`, () => {
    const commands = commandLines(skill.body);
    assert.ok(commands.length > 0, "skill documents no revgate command at all");

    for (const command of commands) {
      const argv = toArgv(command);
      const parsed: ParsedArgs = parseArgs(argv);
      assert.equal(parsed.command, "review", `not a review invocation: ${command}`);
      assert.equal(
        parsed.command === "review" ? parsed.error : undefined,
        undefined,
        `documented command does not parse: ${command}`,
      );
    }
  });
}

test(".github/skills/revgate-review: documents the exit-code contract", () => {
  const skill = skills.find((s) => s.rel === ".github/skills/revgate-review/SKILL.md");
  assert.ok(skill, "revgate-review skill not found");
  // The whole point of the skill is the annotation feedback loop; if these drop
  // out of the body the agent has no way to act on a review.
  assert.match(skill.body, /--exit-code-on-comments/);
  assert.match(skill.body, /\bexit\b/i);
  assert.match(skill.body, /`10`/);
  assert.match(skill.body, /## path:LINE/);
});

test(".github/skills/revgate-plan: drives the plan path, not the diff path", () => {
  const skill = skills.find((s) => s.rel === ".github/skills/revgate-plan/SKILL.md");
  assert.ok(skill, "revgate-plan skill not found");
  assert.match(skill.body, /--plan/);
  assert.match(skill.body, /exit_plan_mode/);
  for (const command of commandLines(skill.body)) {
    assert.match(command, /--plan\b/, `plan skill documents a non-plan command: ${command}`);
  }
});
