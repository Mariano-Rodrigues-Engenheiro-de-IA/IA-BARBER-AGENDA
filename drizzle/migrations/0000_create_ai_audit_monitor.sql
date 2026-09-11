-- Monitor 24h: auditoria de atendimentos por IA (somente leitura do fluxo real)
CREATE TABLE public.ai_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_log_id uuid NOT NULL UNIQUE,
  provider text,
  phone_number text,
  status text NOT NULL DEFAULT 'audited',
  issues_count integer NOT NULL DEFAULT 0,
  discarded_count integer NOT NULL DEFAULT 0,
  model_used text,
  error_message text,
  turn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_log_id uuid NOT NULL,
  provider text,
  phone_number text,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'media',
  summary text NOT NULL,
  evidence_conversation text NOT NULL,
  evidence_tool text NOT NULL,
  tool_names text[] NOT NULL DEFAULT '{}',
  review_status text NOT NULL DEFAULT 'open',
  reviewed_by uuid,
  reviewed_at timestamptz,
  model_used text,
  turn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_audit_runs_tenant_created ON public.ai_audit_runs (tenant_id, created_at DESC);
CREATE INDEX idx_ai_audit_runs_turn_at ON public.ai_audit_runs (turn_at DESC);
CREATE INDEX idx_ai_audit_findings_tenant_created ON public.ai_audit_findings (tenant_id, created_at DESC);
CREATE INDEX idx_ai_audit_findings_category ON public.ai_audit_findings (category);
CREATE INDEX idx_ai_audit_findings_log ON public.ai_audit_findings (agent_log_id);

GRANT SELECT ON public.ai_audit_runs TO authenticated;
GRANT ALL ON public.ai_audit_runs TO service_role;
GRANT SELECT, UPDATE ON public.ai_audit_findings TO authenticated;
GRANT ALL ON public.ai_audit_findings TO service_role;

ALTER TABLE public.ai_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_audit_findings ENABLE ROW LEVEL SECURITY;

-- Leitura: admin sempre; staff com o módulo ai-monitor e acesso ao tenant
CREATE POLICY "Admin/staff podem ver execucoes da auditoria"
ON public.ai_audit_runs FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR (public.staff_has_module(auth.uid(), 'ai-monitor') AND public.can_access_tenant(auth.uid(), tenant_id))
);

CREATE POLICY "Admin/staff podem ver achados da auditoria"
ON public.ai_audit_findings FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR (public.staff_has_module(auth.uid(), 'ai-monitor') AND public.can_access_tenant(auth.uid(), tenant_id))
);

-- Revisão humana (procede / falso alarme / resolvido)
CREATE POLICY "Admin/staff podem revisar achados"
ON public.ai_audit_findings FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR (public.staff_has_module(auth.uid(), 'ai-monitor') AND public.can_access_tenant(auth.uid(), tenant_id))
)
WITH CHECK (
  public.has_role(auth.uid(), 'admin')
  OR (public.staff_has_module(auth.uid(), 'ai-monitor') AND public.can_access_tenant(auth.uid(), tenant_id))
);