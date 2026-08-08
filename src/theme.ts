export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "podtool-theme";
const ORDER: ThemePref[] = ["system", "light", "dark"];

let current: ThemePref = "system";

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref;
}

function apply(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolve(pref);
}

export function initTheme(): ThemePref {
  const stored = localStorage.getItem(STORAGE_KEY);
  current = stored && (ORDER as string[]).includes(stored) ? (stored as ThemePref) : "system";
  apply(current);

  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (current === "system") apply(current);
  });

  return current;
}

export function cycleTheme(): ThemePref {
  current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  localStorage.setItem(STORAGE_KEY, current);
  apply(current);
  return current;
}

export function getThemePref(): ThemePref {
  return current;
}
