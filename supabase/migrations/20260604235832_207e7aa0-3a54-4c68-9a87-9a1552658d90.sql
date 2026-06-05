ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS ai_summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_summary_updated_at timestamptz;