import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { ThemeProvider } from "@/hooks/useTheme";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import AdminLayout from "@/components/AdminLayout";
import ClientLayout from "@/components/ClientLayout";
import LoginPage from "@/pages/Login";
import DashboardPage from "@/pages/Dashboard";
import TenantsPage from "@/pages/Tenants";
import TenantFormPage from "@/pages/TenantForm";
import TenantAccessPage from "@/pages/TenantAccess";
import SettingsPage from "@/pages/Settings";
import AgentLogsPage from "@/pages/AgentLogs";
import FollowUpsDashboardPage from "@/pages/FollowUpsDashboard";
import TenantDashboardPage from "@/pages/TenantDashboard";
import TenantKanbanPage from "@/pages/TenantKanban";
import AuditPage from "@/pages/Audit";
import PromptsPage from "@/pages/Prompts";
import StaffPage from "@/pages/Staff";
import ClientOverview from "@/pages/client/Overview";
import ClientConversations from "@/pages/client/Conversations";
import ClientFollowUps from "@/pages/client/FollowUps";
import ClientCrm from "@/pages/client/Crm";
import ClientAi from "@/pages/client/Ai";
import ClientConnection from "@/pages/client/Connection";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <p className="text-muted-foreground">Carregando...</p>
    </div>
  );
}

function AdminRoute({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, isAdmin, isStaff, role, authReady } = useAuth();
  if (!authReady) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly) {
    if (!isAdmin) return <Navigate to="/" replace />;
  } else if (!isAdmin && !isStaff) {
    return <Navigate to={role === "client" ? "/app" : "/login"} replace />;
  }
  return <AdminLayout>{children}</AdminLayout>;
}

function ClientRoute({ children }: { children: React.ReactNode }) {
  const { user, role, tenantId, authReady } = useAuth();
  if (!authReady) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (role === "admin") return <Navigate to="/" replace />;
  if (role !== "client" || !tenantId) return <Navigate to="/login" replace />;
  return <ClientLayout>{children}</ClientLayout>;
}

function AppRoutes() {
  const { user, role, authReady } = useAuth();
  if (!authReady) return <Loading />;

  const home = role === "client" ? "/app" : "/";

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={home} replace /> : <LoginPage />} />


      {/* Admin */}
      <Route path="/" element={<AdminRoute><DashboardPage /></AdminRoute>} />
      <Route path="/tenants" element={<AdminRoute><TenantsPage /></AdminRoute>} />
      <Route path="/tenants/new" element={<AdminRoute><TenantFormPage /></AdminRoute>} />
      <Route path="/tenants/:id" element={<AdminRoute><TenantFormPage /></AdminRoute>} />
      <Route path="/tenants/:id/access" element={<AdminRoute adminOnly><TenantAccessPage /></AdminRoute>} />
      <Route path="/tenants/:id/dashboard" element={<AdminRoute><TenantDashboardPage /></AdminRoute>} />
      <Route path="/tenants/:id/kanban" element={<AdminRoute><TenantKanbanPage /></AdminRoute>} />
      <Route path="/follow-ups" element={<AdminRoute><FollowUpsDashboardPage /></AdminRoute>} />
      <Route path="/audit" element={<AdminRoute adminOnly><AuditPage /></AdminRoute>} />
      <Route path="/settings" element={<AdminRoute adminOnly><SettingsPage /></AdminRoute>} />
      <Route path="/prompts" element={<AdminRoute adminOnly><PromptsPage /></AdminRoute>} />
      <Route path="/staff" element={<AdminRoute adminOnly><StaffPage /></AdminRoute>} />
      <Route path="/agent-logs" element={<AdminRoute><AgentLogsPage /></AdminRoute>} />

      {/* Client */}
      <Route path="/app" element={<ClientRoute><ClientOverview /></ClientRoute>} />
      <Route path="/app/conversations" element={<ClientRoute><ClientConversations /></ClientRoute>} />
      <Route path="/app/followups" element={<ClientRoute><ClientFollowUps /></ClientRoute>} />
      <Route path="/app/crm" element={<ClientRoute><ClientCrm /></ClientRoute>} />
      <Route path="/app/ai" element={<ClientRoute><ClientAi /></ClientRoute>} />
      <Route path="/app/connection" element={<ClientRoute><ClientConnection /></ClientRoute>} />
      

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <AuthProvider>
              <AppRoutes />
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
