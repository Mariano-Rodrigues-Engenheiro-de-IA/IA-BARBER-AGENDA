ALTER PUBLICATION supabase_realtime ADD TABLE public.tenants;
ALTER TABLE public.tenants REPLICA IDENTITY FULL;