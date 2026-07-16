CREATE POLICY "Staff view own created tenants"
ON public.tenants FOR SELECT
USING (public.has_role(auth.uid(), 'staff') AND created_by = auth.uid());