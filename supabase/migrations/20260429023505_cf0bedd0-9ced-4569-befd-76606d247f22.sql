-- Add 'frizzar' to api_provider enum
ALTER TYPE api_provider ADD VALUE IF NOT EXISTS 'frizzar';

-- Add Frizzar credentials to tenants
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS frizzar_token text;