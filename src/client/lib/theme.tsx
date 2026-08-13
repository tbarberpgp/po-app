import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
export type Accent = "orange" | "navy";

type ThemeCtx = {
  theme: Theme;
  accent: Accent;
  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

const STORAGE_KEY = "pgp-theme";

// The public cabin QITP page (opened by operatives via QR, no login) is a
// light-first QA document — pin it to light regardless of the device's
// prefers-color-scheme, and don't persist (so a logged-in user's saved theme
// is never clobbered by opening a cabin link).
function forceLight(): boolean {
  return typeof location !== "undefined" && location.pathname.startsWith("/cabin/");
}

function readStored(): { theme: Theme; accent: Accent } {
  if (forceLight()) return { theme: "light", accent: "orange" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        theme: parsed.theme === "dark" ? "dark" : "light",
        accent: parsed.accent === "navy" ? "navy" : "orange",
      };
    }
  } catch {/* ignore */}
  // First load — pick from system preference
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return { theme: prefersDark ? "dark" : "light", accent: "orange" };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(readStored, []);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [accent, setAccent] = useState<Accent>(initial.accent);

  useEffect(() => {
    const pinned = forceLight();
    document.documentElement.setAttribute("data-theme", pinned ? "light" : theme);
    document.documentElement.setAttribute("data-accent", accent);
    if (!pinned) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, accent })); } catch {/* ignore */} }
  }, [theme, accent]);

  const value = useMemo(() => ({ theme, accent, setTheme, setAccent }), [theme, accent]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("ThemeProvider missing");
  return v;
}
