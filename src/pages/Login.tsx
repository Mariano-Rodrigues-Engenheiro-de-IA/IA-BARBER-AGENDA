import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import zayloLogo from "@/assets/zaylo-ia-logo-light.png";


/** Identidade geral (Zaylo): a tela de login usa o mesmo cinza-azulado
 *  escuro da barra lateral, com a logo branca por cima. */
function useForceZayloTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const hadLight = root.classList.contains("light");
    const hadDark = root.classList.contains("dark");
    root.classList.remove("light", "dark");
    root.classList.add("theme-zaylo-login");
    return () => {
      root.classList.remove("theme-zaylo-login");
      if (hadLight) root.classList.add("light");
      if (hadDark) root.classList.add("dark");
    };
  }, []);
}

export default function LoginPage() {
  useForceZayloTheme();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await signIn(email, password);
      toast.success("Login realizado com sucesso!");
    } catch (error: any) {
      toast.error(error.message || "Erro ao fazer login");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md animate-fade-in">
        <div className="glass-card p-8 space-y-6">
          <div className="text-center space-y-3">
            <div className="flex justify-center">
              <img
                src={zayloLogo}
                alt="Zaylo IA"
                className="h-14 w-auto max-w-[70%] object-contain"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Painel de controle da sua IA
            </p>
          </div>


          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on" method="post">
            <div className="space-y-2">
              <Label htmlFor="username">E-mail</Label>
              <Input
                id="username"
                name="username"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="admin@zaylo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Entrando..." : "Entrar"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
