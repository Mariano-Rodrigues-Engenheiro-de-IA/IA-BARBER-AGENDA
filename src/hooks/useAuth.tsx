import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";

export type Role = "admin" | "client" | null;
export type ModuleVisibility = "hidden" | "read_only" | "editable";
export type AppModule =
  | "overview" | "conversations" | "followups" | "crm"
  | "ai_prompt" | "ai_knowledge" | "integrations" | "company_data"
  | "connection" | "tools";

export type PermissionsMap = Partial<Record<AppModule, ModuleVisibility>>;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  role: Role;
  tenantId: string | null;
  permissions: PermissionsMap;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function loadProfile(userId: string) {
  const [adminRes, clientRes, tenantRes] = await Promise.all([
    supabase.rpc("has_role", { _user_id: userId, _role: "admin" as any }),
    supabase.rpc("has_role", { _user_id: userId, _role: "client" as any }),
    supabase.from("tenant_users").select("tenant_id").eq("user_id", userId).maybeSingle(),
  ]);
  const isAdmin = !!adminRes.data;
  const isClient = !!clientRes.data;
  const role: Role = isAdmin ? "admin" : isClient ? "client" : null;
  const tenantId = (tenantRes.data?.tenant_id as string | undefined) ?? null;

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

  return { isAdmin, role, tenantId, permissions };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState<Role>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionsMap>({});
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const apply = (p: { isAdmin: boolean; role: Role; tenantId: string | null; permissions: PermissionsMap }) => {
    setIsAdmin(p.isAdmin); setRole(p.role); setTenantId(p.tenantId); setPermissions(p.permissions);
  };

  useEffect(() => {
    let lastUserId: string | null = null;

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session); setUser(session?.user ?? null);
      if (session?.user) {
        lastUserId = session.user.id;
        setProfileLoading(true);
        try {
          apply(await loadProfile(session.user.id));
        } finally {
          setProfileLoading(false);
        }
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s); setUser(s?.user ?? null);
      const newUserId = s?.user?.id ?? null;
      if (newUserId === lastUserId) return; // ignore TOKEN_REFRESHED etc.
      lastUserId = newUserId;
      if (s?.user) {
        setProfileLoading(true);
        loadProfile(s.user.id)
          .then(apply)
          .finally(() => setProfileLoading(false));
      } else {
        apply({ isAdmin: false, role: null, tenantId: null, permissions: {} });
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
    apply({ isAdmin: false, role: null, tenantId: null, permissions: {} });
  };

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, role, tenantId, permissions, loading: loading || profileLoading, signIn, signOut, refreshPermissions }}>
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
