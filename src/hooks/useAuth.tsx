import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";

export type Role = "admin" | "staff" | "client" | null;
export type ModuleVisibility = "hidden" | "read_only" | "editable";
export type AppModule =
  | "overview" | "conversations"
  | "ai_prompt" | "ai_knowledge" | "integrations" | "company_data"
  | "connection" | "tools" | "simulator" | "billing";

export type PermissionsMap = Partial<Record<AppModule, ModuleVisibility>>;

export type StaffModule =
  | "follow-ups" | "agent-logs" | "ai-monitor" | "prompts" | "staff" | "audit" | "settings"
  // Capacidades antes exclusivas do admin, agora liberáveis manualmente
  | "tenant-credentials" | "tenant-manage" | "tenant-access";

interface AuthContextType {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isStaff: boolean;
  role: Role;
  tenantId: string | null;
  permissions: PermissionsMap;
  staffModules: Set<StaffModule>;
  /** Admin tem tudo; colaborador tem o que estiver marcado no painel. */
  can: (module: StaffModule) => boolean;
  loading: boolean;
  authReady: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function loadProfile(userId: string) {
  const [adminRes, staffRes, clientRes, tenantRes, modulesRes] = await Promise.all([
    supabase.rpc("has_role", { _user_id: userId, _role: "admin" as any }),
    supabase.rpc("has_role", { _user_id: userId, _role: "staff" as any }),
    supabase.rpc("has_role", { _user_id: userId, _role: "client" as any }),
    supabase.from("tenant_users").select("tenant_id").eq("user_id", userId).maybeSingle(),
    supabase.from("staff_module_access").select("module").eq("user_id", userId),
  ]);
  const isAdmin = !!adminRes.data;
  const isStaff = !!staffRes.data;
  const isClient = !!clientRes.data;
  const role: Role = isAdmin ? "admin" : isStaff ? "staff" : isClient ? "client" : null;
  const tenantId = (tenantRes.data?.tenant_id as string | undefined) ?? null;
  const staffModules = new Set<StaffModule>(((modulesRes.data ?? []) as any[]).map((r) => r.module as StaffModule));

  let permissions: PermissionsMap = {};
  if (tenantId) {
    const { data: perms } = await supabase
      .from("tenant_permissions")
      .select("module,visibility")
      .eq("tenant_id", tenantId);
    permissions = (perms ?? []).reduce<PermissionsMap>((acc, p: any) => {
      acc[p.module as AppModule] = p.visibility as ModuleVisibility;
      return acc;
    }, {});
  }

  return { isAdmin, isStaff, role, tenantId, permissions, staffModules };
}

type Profile = Awaited<ReturnType<typeof loadProfile>>;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isStaff, setIsStaff] = useState(false);
  const [role, setRole] = useState<Role>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionsMap>({});
  const [staffModules, setStaffModules] = useState<Set<StaffModule>>(new Set());
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const profileRequestId = useRef(0);

  const apply = (p: Profile) => {
    setIsAdmin(p.isAdmin); setIsStaff(p.isStaff); setRole(p.role);
    setTenantId(p.tenantId); setPermissions(p.permissions); setStaffModules(p.staffModules);
  };

  const resetProfile = () => apply({ isAdmin: false, isStaff: false, role: null, tenantId: null, permissions: {}, staffModules: new Set() });

  const loadAndApplyProfile = async (userId: string) => {
    const requestId = ++profileRequestId.current;
    setProfileLoading(true);
    try {
      const profile = await loadProfile(userId);
      if (profileRequestId.current === requestId) apply(profile);
    } catch (error) {
      if (profileRequestId.current === requestId) resetProfile();
      console.error("Erro ao carregar permissões do usuário", error);
    } finally {
      if (profileRequestId.current === requestId) setProfileLoading(false);
    }
  };

  useEffect(() => {
    let lastUserId: string | null = null;

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session); setUser(session?.user ?? null);
      if (session?.user) {
        lastUserId = session.user.id;
        await loadAndApplyProfile(session.user.id);
      } else {
        profileRequestId.current += 1;
        resetProfile();
        setProfileLoading(false);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s); setUser(s?.user ?? null);
      const newUserId = s?.user?.id ?? null;
      if (newUserId === lastUserId) return;
      lastUserId = newUserId;
      if (s?.user) {
        void loadAndApplyProfile(s.user.id);
      } else {
        profileRequestId.current += 1;
        resetProfile();
        setProfileLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const refreshPermissions = async () => {
    if (user) apply(await loadProfile(user.id));
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    profileRequestId.current += 1;
    resetProfile();
  };

  // ACHADO DE BUG REAL: antes, exigia role !== null pra considerar
  // "pronto" - se o usuário logado não tem NENHUM papel atribuído
  // (admin/staff/client), profileLoading termina mas role continua null
  // pra sempre, e authReady nunca vira true. As três telas que checam
  // authReady (App.tsx) ficam mostrando "Carregando..." pra sempre,
  // mesmo com o login funcionando certinho. Agora authReady só depende
  // de ter TERMINADO de carregar, não de ter encontrado um papel
  // específico - usuário sem papel é um resultado válido (mesmo que
  // precise de tela de acesso negado depois), não "ainda carregando".
  const authReady = !loading && (!user || !profileLoading);

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isStaff, role, tenantId, permissions, staffModules, loading: loading || profileLoading, authReady, signIn, signOut, refreshPermissions }}>
      {children}
    </AuthContext.Provider>
  );
}


export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export function useModulePermission(module: AppModule) {
  const { permissions, role } = useAuth();
  if (role === "admin") return { visible: true, editable: true } as const;
  const v = permissions[module] ?? "editable";
  return { visible: v !== "hidden", editable: v === "editable" } as const;
}
