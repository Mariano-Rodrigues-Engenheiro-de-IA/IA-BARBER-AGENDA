import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <Button variant="ghost" size="sm" onClick={toggle}
      className={`w-full justify-start gap-2 text-sidebar-foreground/70 hover:text-sidebar-foreground ${className ?? ""}`}>
      {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      {theme === "dark" ? "Modo claro" : "Modo escuro"}
    </Button>
  );
}
