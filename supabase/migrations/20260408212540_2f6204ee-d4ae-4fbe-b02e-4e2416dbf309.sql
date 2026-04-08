
CREATE TABLE public.agent_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
  phone_number text NOT NULL,
  user_message text NOT NULL,
  ai_response text,
  tool_calls jsonb DEFAULT '[]'::jsonb,
  errors jsonb DEFAULT '[]'::jsonb,
  model_used text,
  total_tokens integer,
  duration_ms integer,
  session_blocked boolean DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view agent logs"
  ON public.agent_logs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service can insert agent logs"
  ON public.agent_logs FOR INSERT
  TO public
  WITH CHECK (true);

CREATE INDEX idx_agent_logs_tenant ON public.agent_logs(tenant_id);
CREATE INDEX idx_agent_logs_created ON public.agent_logs(created_at DESC);
CREATE INDEX idx_agent_logs_phone ON public.agent_logs(phone_number);
