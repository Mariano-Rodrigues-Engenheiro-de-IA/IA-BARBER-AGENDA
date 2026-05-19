import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";
interface Ctx { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void }

const ThemeContext = createContext<Ctx>({ theme: "dark", toggle: () => {}, setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("zaylo-theme") as Theme) || "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
    localStorage.setItem("zaylo-theme", theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState, toggle: () => setThemeState(t => t === "dark" ? "light" : "dark") }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
