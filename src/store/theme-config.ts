// The one place a theme choice is remembered. The random port makes every run a
// new browser origin, so `~/.revgate/config.json` is the only store that
// survives a session. Nothing here throws — see the theme rule in agents.md.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { warn } from "../shared/log.js";
import { BUILTIN_THEMES, SYSTEM_THEME_ID, type Theme, isKnownThemeId } from "./palettes.js";

/** The whole config file — one key, for now. */
export interface ThemeConfig {
  theme: string;
}

/** Where `config.json` lives: `$REVGATE_CONFIG_DIR`, else `~/.revgate`. */
export function configDir(): string {
  const dir = process.env.REVGATE_CONFIG_DIR?.trim();
  if (dir) return path.resolve(dir);
  return path.join(os.homedir(), ".revgate");
}

/** The config file itself — always `config.json` inside `configDir()`. */
export function configFile(): string {
  return path.join(configDir(), "config.json");
}

/** The saved config, or `system`. A missing file is the normal first run and stays quiet. */
export async function readThemeConfig(): Promise<ThemeConfig> {
  const file = configFile();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`could not read ${file}: ${(err as Error).message}`);
    }
    return { theme: SYSTEM_THEME_ID };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    const theme = (parsed as { theme?: unknown }).theme;
    return { theme: typeof theme === "string" ? theme : SYSTEM_THEME_ID };
  } catch (err) {
    warn(`ignoring malformed ${file}: ${(err as Error).message}`);
    return { theme: SYSTEM_THEME_ID };
  }
}

/**
 * Save the chosen theme, returning whether it landed on disk. Serialized through
 * the queue below: the picker POSTs once per `change`, and unqueued writes race.
 */
export function writeThemeConfig(themeId: string): Promise<boolean> {
  // Chained off a swallowed copy, so one rejection cannot poison the queue.
  const run = writeQueue.then(
    () => saveThemeConfig(themeId),
    () => saveThemeConfig(themeId),
  );
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One queue per process: a per-call queue would serialize nothing. */
let writeQueue: Promise<unknown> = Promise.resolve();

async function saveThemeConfig(themeId: string): Promise<boolean> {
  const file = configFile();
  const dir = path.dirname(file);
  // Beside the target, so the rename is atomic; the pid separates two servers.
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    const config: ThemeConfig = { theme: themeId };
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return true;
  } catch (err) {
    // The rename publishes the file, so a failure after the write leaves litter.
    await rm(tmp, { force: true }).catch(() => {});
    warn(`could not save theme to ${file}: ${(err as Error).message}`);
    return false;
  }
}

/** Every built-in palette plus the current selection. */
export interface ThemeListing {
  /** The saved id, or `system` when it doesn't resolve to anything known. */
  selected: string;
  themes: Theme[];
}

/**
 * Every palette plus the selection, so switching needs no further round trip. An
 * unknown id falls back to `system` rather than leaving the page unstyled.
 */
export async function listThemes(): Promise<ThemeListing> {
  const { theme } = await readThemeConfig();
  return {
    selected: isKnownThemeId(theme) ? theme : SYSTEM_THEME_ID,
    themes: BUILTIN_THEMES,
  };
}
