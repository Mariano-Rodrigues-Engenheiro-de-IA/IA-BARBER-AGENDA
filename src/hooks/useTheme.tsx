import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type Theme = "dark" | "light";
interface Ctx { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void }

const ThemeContext = createContext<Ctx>({ theme: "dark", toggle: () => {}, setTheme: () => {} });

const keyFor = (userId: string | null) => userId ? `zaylo-theme:${userId}` : null;

function loadTheme(userId: string | null): Theme {
  if (typeof window === "undefined") return "dark";
  if (!userId) return "dark"; // login/guest sempre dark
  const k = keyFor(userId)!;
  return (localStorage.getItem(k) as Theme) || "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [theme, setThemeState] = useState<Theme>("dark");

  // Track auth user
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id ?? null;
      setUserId(uid);
      setThemeState(loadTheme(uid));
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user?.id ?? null;
      setUserId(uid);
      setThemeState(loadTheme(uid));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Apply theme to <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Persist only when there's an authenticated user
  useEffect(() => {
    if (!ready || !userId) return;
    const k = keyFor(userId);
    if (k) localStorage.setItem(k, theme);
  }, [theme, userId, ready]);

  const setTheme = (t: Theme) => setThemeState(t);
  const toggle = () => setThemeState((t) => (t === "dark" ? "light" : "dark"));

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
