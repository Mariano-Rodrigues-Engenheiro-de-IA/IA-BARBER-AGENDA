
-- Create enum for API providers
CREATE TYPE public.api_provider AS ENUM ('trinks', 'onebeleza', 'none');

-- Add new columns to tenants
ALTER TABLE public.tenants
  ADD COLUMN api_provider public.api_provider NOT NULL DEFAULT 'trinks',
  ADD COLUMN onebeleza_token text,
  ADD COLUMN onebeleza_celular text,
  ADD COLUMN booking_link text;
