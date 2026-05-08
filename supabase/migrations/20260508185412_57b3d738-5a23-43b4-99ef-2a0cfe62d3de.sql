ALTER TYPE api_provider ADD VALUE IF NOT EXISTS 'bemp';
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bemp_domain text;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bemp_token text;