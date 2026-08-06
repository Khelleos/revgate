/**
 * Built-in colour themes and the one place a choice is remembered.
 *
 * Persistence has to live on disk, not in the browser: the review server binds
 * a random port, so every run is a distinct origin with its own empty
 * `localStorage`. `~/.revgate/config.json` is the only store that survives a
 * session. `$REVGATE_CONFIG_DIR` overrides the *directory* the file lives in —
 * unlike `$REVGATE_HISTORY_DIR`, which names the history directory itself.
 *
 * Every palette is a complete map over `PALETTE_KEYS`; nothing merges over a
 * base. Reading one entry below tells you exactly what that theme looks like,
 * and a key added to the CSS can't silently fall back to the dark default
 * (test/theme.test.ts fails the build if the two drift apart).
 *
 * Nothing here throws. An unreadable config, malformed JSON or a read-only home
 * directory warns to stderr and degrades to `system` — a review gate must never
 * be wedged by a cosmetic subsystem.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { warn } from "./log.js";

export interface Theme {
  id: string;
  name: string;
  /**
   * Drives `document.documentElement.style.colorScheme`, which is what makes
   * the browser paint the theme picker's own dropdown, the scrollbars and any
   * native control in the matching mode. Without it a dark theme gets a light
   * dropdown floating over it.
   */
  type: "dark" | "light";
  colors: Record<string, string>;
}

export interface ThemeConfig {
  theme: string;
}

/**
 * The id of a fresh install, and a first-class member of the id set — it
 * carries no palette, the client resolves it through `prefers-color-scheme`.
 */
export const SYSTEM_THEME_ID = "system";

/**
 * Every custom property a theme must define. `--mono` is deliberately absent:
 * the font stack is self-hosted and not themeable.
 */
export const PALETTE_KEYS = [
  "--bg",
  "--bg2",
  "--bg3",
  "--border",
  "--text",
  "--muted",
  "--add-bg",
  "--add-line",
  "--add-gutter",
  "--del-bg",
  "--del-line",
  "--del-gutter",
  "--accent",
  "--green",
  "--amber",
  "--danger",
  "--sel",
  "--tok-com",
  "--tok-str",
  "--tok-num",
  "--tok-kw",
] as const;

/**
 * The five built-ins, in picker order.
 *
 * `--sel` carries an alpha channel: it paints over diff lines that already have
 * a background, so an opaque value would erase the add/delete tint underneath.
 * `--accent`, `--green`, `--amber` and `--danger` double as button backgrounds
 * with white text, which is why they are the mid-tone member of each theme's
 * hue family rather than its brightest.
 */
export const BUILTIN_THEMES: Theme[] = [
  {
    id: "dark-modern",
    name: "Dark Modern",
    type: "dark",
    colors: {
      "--bg": "#0d1117",
      "--bg2": "#161b22",
      "--bg3": "#21262d",
      "--border": "#30363d",
      "--text": "#e6edf3",
      "--muted": "#8b949e",
      "--add-bg": "#12261e",
      "--add-line": "#1a4d2e",
      "--add-gutter": "#163a2a",
      "--del-bg": "#25171c",
      "--del-line": "#4d1a25",
      "--del-gutter": "#3a1620",
      "--accent": "#2f81f7",
      "--green": "#238636",
      "--amber": "#9e6a03",
      "--danger": "#da3633",
      "--sel": "#388bfd44",
      "--tok-com": "#8b949e",
      "--tok-str": "#a5d6ff",
      "--tok-num": "#79c0ff",
      "--tok-kw": "#ff7b72",
    },
  },
  {
    id: "light-modern",
    name: "Light Modern",
    type: "light",
    colors: {
      "--bg": "#ffffff",
      "--bg2": "#f6f8fa",
      "--bg3": "#eaeef2",
      "--border": "#d0d7de",
      "--text": "#1f2328",
      "--muted": "#57606a",
      "--add-bg": "#e6ffec",
      "--add-line": "#ccffd8",
      "--add-gutter": "#ccffd8",
      "--del-bg": "#ffebe9",
      "--del-line": "#ffd7d5",
      "--del-gutter": "#ffd7d5",
      "--accent": "#0969da",
      "--green": "#1a7f37",
      "--amber": "#8a5d00",
      "--danger": "#cf222e",
      "--sel": "#54aeff55",
      "--tok-com": "#6e7781",
      "--tok-str": "#0a3069",
      "--tok-num": "#0550ae",
      "--tok-kw": "#cf222e",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    type: "dark",
    colors: {
      "--bg": "#272822",
      "--bg2": "#1e1f1c",
      "--bg3": "#3e3d32",
      "--border": "#49483e",
      "--text": "#f8f8f2",
      "--muted": "#90908a",
      "--add-bg": "#1f2a1c",
      "--add-line": "#33512a",
      "--add-gutter": "#284022",
      "--del-bg": "#2f1d24",
      "--del-line": "#5a2338",
      "--del-gutter": "#451c2c",
      "--accent": "#1f7f9c",
      "--green": "#5f8f1a",
      "--amber": "#97781a",
      "--danger": "#c01d54",
      "--sel": "#66d9ef33",
      "--tok-com": "#75715e",
      "--tok-str": "#e6db74",
      "--tok-num": "#ae81ff",
      "--tok-kw": "#f92672",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    type: "light",
    colors: {
      "--bg": "#fdf6e3",
      "--bg2": "#eee8d5",
      "--bg3": "#e2dcc6",
      "--border": "#d3cbb2",
      "--text": "#073642",
      "--muted": "#657b83",
      "--add-bg": "#eef5da",
      "--add-line": "#dceab8",
      "--add-gutter": "#dceab8",
      "--del-bg": "#fbe9e4",
      "--del-line": "#f5d3ca",
      "--del-gutter": "#f5d3ca",
      "--accent": "#268bd2",
      "--green": "#6b7c00",
      "--amber": "#a37a00",
      "--danger": "#dc322f",
      "--sel": "#268bd233",
      "--tok-com": "#93a1a1",
      "--tok-str": "#2aa198",
      "--tok-num": "#d33682",
      "--tok-kw": "#859900",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    type: "dark",
    colors: {
      "--bg": "#282a36",
      "--bg2": "#21222c",
      "--bg3": "#343746",
      "--border": "#44475a",
      "--text": "#f8f8f2",
      "--muted": "#7b88b8",
      "--add-bg": "#1e2b26",
      "--add-line": "#2c4a3a",
      "--add-gutter": "#243b30",
      "--del-bg": "#33212a",
      "--del-line": "#5c2b3b",
      "--del-gutter": "#482332",
      "--accent": "#7b5bbd",
      "--green": "#2e9e52",
      "--amber": "#9a7d1a",
      "--danger": "#d23b3b",
      "--sel": "#bd93f933",
      "--tok-com": "#6272a4",
      "--tok-str": "#f1fa8c",
      "--tok-num": "#bd93f9",
      "--tok-kw": "#ff79c6",
    },
  },
];

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

/**
 * True for the five built-ins and for `system`, which is a real id.
 *
 * Declared as a type predicate so the caller that validates a JSON body keeps
 * the `string` this already proved, rather than casting it back afterwards.
 */
export function isKnownThemeId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  return id === SYSTEM_THEME_ID || BUILTIN_THEMES.some((theme) => theme.id === id);
}

/**
 * The saved config, or `{ theme: "system" }` if there isn't a usable one.
 *
 * A missing file is the normal first-run case and stays quiet; anything else —
 * unreadable file, malformed JSON — warns and degrades.
 */
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
 * Save the chosen theme, returning whether it landed on disk.
 *
 * Written to a temp file next to the target and renamed into place: a crash
 * mid-write would otherwise leave a truncated `config.json`, and because the
 * read path degrades silently by design the user would never see the error,
 * they would just quietly lose their theme.
 *
 * This rewrites the whole file, which is only safe while `theme` is the sole
 * key — two review servers can easily be running at once, so the moment a
 * second field lands a read-modify-write from a stale snapshot starts
 * clobbering it. Whoever adds that field owns fixing this.
 *
 * Calls are serialized. The picker POSTs once per `change` event, and a focused
 * `<select>` fires one of those per arrow keypress, so several writes are
 * routinely in flight inside one server; unqueued they share a temp path and
 * race the same rename, which loses the *later* pick or fails it outright. The
 * read path degrades silently by design, so the user would never see it.
 * (`serializeIndexWork` in server.ts exists for the same class of reason.)
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

let writeQueue: Promise<unknown> = Promise.resolve();

async function saveThemeConfig(themeId: string): Promise<boolean> {
  const file = configFile();
  const dir = path.dirname(file);
  // Same directory as the target, so the rename stays on one filesystem and is
  // therefore atomic; the pid keeps two concurrent servers off each other, and
  // the queue above keeps this one process off itself.
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    const config: ThemeConfig = { theme: themeId };
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return true;
  } catch (err) {
    // The rename is what publishes the file, so a failure after the write left
    // the temp file sitting in the config directory with nothing to collect it.
    await rm(tmp, { force: true }).catch(() => {});
    warn(`could not save theme to ${file}: ${(err as Error).message}`);
    return false;
  }
}

export interface ThemeListing {
  /** The saved id, or `system` when it doesn't resolve to anything known. */
  selected: string;
  themes: Theme[];
}

/**
 * Everything the page needs in one response: all five palettes plus the current
 * selection, so switching themes needs no further round trip.
 *
 * A saved id that isn't known — hand-edited, or written by a future version
 * that shipped more themes — falls back to `system` rather than leaving the
 * page unstyled.
 */
export async function listThemes(): Promise<ThemeListing> {
  const { theme } = await readThemeConfig();
  return {
    selected: isKnownThemeId(theme) ? theme : SYSTEM_THEME_ID,
    themes: BUILTIN_THEMES,
  };
}
