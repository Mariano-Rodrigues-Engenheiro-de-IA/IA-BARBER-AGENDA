ALTER TYPE public.api_provider ADD VALUE IF NOT EXISTS 'zaylo';
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS zaylo_barbershop_id text,
  ADD COLUMN IF NOT EXISTS zaylo_base_url text,
  ADD COLUMN IF NOT EXISTS zaylo_publishable_key text;