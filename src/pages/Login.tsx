import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Brand = "zaylo" | "frizzar";

const BRAND = {
  zaylo: {
    themeClass: "theme-zaylo-login",
    logo: "/brand/zaylo-ia-logo-login.png",
    alt: "Zaylo IA",
    // Um pouco menor que antes, a pedido do Mariano.
    logoClass: "h-10 w-auto max-w-[58%] object-contain",
    tagline: "Painel de controle da sua IA",
  },
  frizzar: {
    themeClass: "theme-frizzar-login",
    logo: "/frizzar/frizzar-logo-horizontal-white.png",
    alt: "Frizzar",
    logoClass: "h-12 w-auto max-w-[64%] object-contain",
    tagline: "Painel de atendimento inteligente",
  },
} as const;

/** A tela de login usa o mesmo tom escuro da barra lateral da identidade
 *  correspondente (geral = Zaylo, parceria = Frizzar), com a logo branca. */
function useForceLoginTheme(themeClass: string) {
  useEffect(() => {
    const root = document.documentElement;
    const hadLight = root.classList.contains("light");
    const hadDark = root.classList.contains("dark");
    root.classList.remove("light", "dark");
    root.classList.add(themeClass);
    return () => {
      root.classList.remove(themeClass);
      if (hadLight) root.classList.add("light");
      if (hadDark) root.classList.add("dark");
    };
  }, [themeClass]);
}

export default function LoginPage({ brand = "zaylo" }: { brand?: Brand }) {
  const b = BRAND[brand];
  useForceLoginTheme(b.themeClass);
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
                src={b.logo}
                alt={b.alt}
                className={b.logoClass}
                width={958}
                height={230}
                fetchPriority="high"
                decoding="sync"
                loading="eager"
                draggable={false}
              />
            </div>
            <p className="text-sm text-muted-foreground">{b.tagline}</p>
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
                placeholder="Digite seu e-mail"
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
                placeholder="Digite sua senha"
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
