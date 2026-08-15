/**
 * The built-in colour themes. Every palette is a complete map over
 * `PALETTE_KEYS`; nothing merges over a base, and `test/store/palettes.test.ts`
 * fails the build if the palettes and the page CSS drift apart.
 */

/** One built-in palette. */
export interface Theme {
  id: string;
  name: string;
  /** Drives `colorScheme`, so the browser paints native controls to match. */
  type: "dark" | "light";
  colors: Record<string, string>;
}

/** A first-class id that carries no palette: the client resolves it through
 * `prefers-color-scheme`. */
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
 * The five built-ins, in picker order. `--sel` needs an alpha channel, because
 * it paints over diff lines that already carry a background; `--accent`,
 * `--green`, `--amber` and `--danger` double as button backgrounds under white
 * text, so each is a mid-tone rather than its family's brightest.
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

/**
 * True for the five built-ins and for `system`. A type predicate, so the caller
 * validating a JSON body keeps the `string` this already proved.
 */
export function isKnownThemeId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  return id === SYSTEM_THEME_ID || BUILTIN_THEMES.some((theme) => theme.id === id);
}
