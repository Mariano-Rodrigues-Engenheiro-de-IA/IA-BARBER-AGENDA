import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import AdminLayout from "@/components/AdminLayout";
import LoginPage from "@/pages/Login";
import DashboardPage from "@/pages/Dashboard";
import TenantsPage from "@/pages/Tenants";
import TenantFormPage from "@/pages/TenantForm";
import SettingsPage from "@/pages/Settings";
import AgentLogsPage from "@/pages/AgentLogs";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isAdmin, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="glass-card p-8 text-center max-w-md">
          <h2 className="text-xl font-bold text-foreground mb-2">Acesso negado</h2>
          <p className="text-muted-foreground">Você não tem permissão de administrador.</p>
        </div>
      </div>
    );
  }

  return <AdminLayout>{children}</AdminLayout>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
      <Route path="/tenants" element={<ProtectedRoute><TenantsPage /></ProtectedRoute>} />
      <Route path="/tenants/new" element={<ProtectedRoute><TenantFormPage /></ProtectedRoute>} />
      <Route path="/tenants/:id" element={<ProtectedRoute><TenantFormPage /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
      <Route path="/agent-logs" element={<ProtectedRoute><AgentLogsPage /></ProtectedRoute>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
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
);

export default App;
