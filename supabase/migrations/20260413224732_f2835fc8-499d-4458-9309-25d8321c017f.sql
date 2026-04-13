
-- Create crm_leads table
CREATE TABLE public.crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  phone_number text NOT NULL,
  name text,
  label_id text NOT NULL,
  label_name text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);

ALTER TABLE public.crm_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view crm_leads" ON public.crm_leads
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update crm_leads" ON public.crm_leads
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete crm_leads" ON public.crm_leads
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service can insert crm_leads" ON public.crm_leads
  FOR INSERT TO public
  WITH CHECK (true);

CREATE POLICY "Service can update crm_leads" ON public.crm_leads
  FOR UPDATE TO public
  USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_crm_leads_updated_at
  BEFORE UPDATE ON public.crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create crm_lead_history table
CREATE TABLE public.crm_lead_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  from_label text,
  to_label text NOT NULL,
  changed_by text DEFAULT 'ai',
  changed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_lead_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view crm_lead_history" ON public.crm_lead_history
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service can insert crm_lead_history" ON public.crm_lead_history
  FOR INSERT TO public
  WITH CHECK (true);

-- Add kanban_columns to tenants
ALTER TABLE public.tenants ADD COLUMN kanban_columns jsonb DEFAULT '[]'::jsonb;
