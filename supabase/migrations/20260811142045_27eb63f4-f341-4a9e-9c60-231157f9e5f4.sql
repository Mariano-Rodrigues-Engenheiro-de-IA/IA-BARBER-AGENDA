GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_permissions TO authenticated;
GRANT ALL ON public.tenant_permissions TO service_role;