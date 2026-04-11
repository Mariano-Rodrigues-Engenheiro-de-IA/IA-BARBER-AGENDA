
-- Conversation state table for persistent ID resolution
CREATE TABLE public.conversation_state (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  phone_number TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);

-- Enable RLS
ALTER TABLE public.conversation_state ENABLE ROW LEVEL SECURITY;

-- Service role (edge functions) can do everything
CREATE POLICY "Service can select conversation_state"
ON public.conversation_state FOR SELECT
TO public
USING (true);

CREATE POLICY "Service can insert conversation_state"
ON public.conversation_state FOR INSERT
TO public
WITH CHECK (true);

CREATE POLICY "Service can update conversation_state"
ON public.conversation_state FOR UPDATE
TO public
USING (true);

CREATE POLICY "Service can delete conversation_state"
ON public.conversation_state FOR DELETE
TO public
USING (true);

-- Admins can view for debugging
CREATE POLICY "Admins can view conversation_state"
ON public.conversation_state FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- Auto-update updated_at
CREATE TRIGGER update_conversation_state_updated_at
BEFORE UPDATE ON public.conversation_state
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
