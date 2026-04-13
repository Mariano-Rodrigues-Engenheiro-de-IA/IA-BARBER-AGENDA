

# CRM Kanban por Etiquetas

## Visão Geral
Criar um sistema de CRM com Kanban board dentro do painel, onde cada coluna representa uma etiqueta (label) do WhatsApp. Quando a IA aplica uma etiqueta via UAZAPI, o lead é automaticamente registrado/movido no Kanban.

## Sugestões Extras
- **Histórico de movimentação**: registrar quando o lead mudou de coluna (auditoria)
- **Detalhes do lead no card**: mostrar nome, telefone, última mensagem, e tempo na etapa atual
- **Filtro por tenant**: cada tenant tem suas próprias colunas/etiquetas
- **Drag & drop manual**: permitir mover leads entre colunas manualmente (sincronizando a etiqueta no UAZAPI)
- **Contadores por coluna**: mostrar quantos leads há em cada etapa
- **Card com link direto para conversa**: clicar no lead abre os logs da conversa

## Arquitetura

### 1. Nova tabela: `crm_leads`
```sql
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
-- RLS policies for admin select + public insert/update
```

### 2. Nova tabela: `crm_lead_history`
```sql
CREATE TABLE public.crm_lead_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  from_label text,
  to_label text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
```

### 3. Configuração de colunas por tenant
Adicionar campo `kanban_columns` (jsonb) na tabela `tenants` para definir as colunas/etiquetas do Kanban de cada tenant. Formato:
```json
[
  { "label_id": "7", "name": "Interessado", "color": "#3B82F6", "order": 0 },
  { "label_id": "29", "name": "IA OFF", "color": "#EF4444", "order": 1 }
]
```

### 4. Webhook: registrar lead ao aplicar etiqueta
No `whatsapp-webhook/index.ts`, após a chamada bem-sucedida ao `/chat/labels`, fazer upsert na tabela `crm_leads` com o tenant_id, phone_number e label_id. Também inserir registro em `crm_lead_history`.

### 5. Nova página: `/tenants/:id/kanban`
- Kanban board com drag & drop (usando `@dnd-kit/core` ou HTML5 nativo)
- Cada coluna = uma etiqueta configurada no tenant
- Cards mostram: telefone, nome (se disponível), tempo na etapa, preview da última mensagem
- Arrastar card entre colunas → chama UAZAPI para trocar etiqueta + atualiza DB

### 6. UI do Kanban
- Rota nova em `App.tsx`
- Link no dashboard do tenant para acessar o Kanban
- Configuração das colunas no `TenantForm.tsx` (aba de configurações)

## Arquivos Afetados
- **Nova migração SQL**: criar `crm_leads` e `crm_lead_history`, adicionar `kanban_columns` ao `tenants`
- **`supabase/functions/whatsapp-webhook/index.ts`**: upsert lead após aplicar etiqueta
- **`src/pages/TenantKanban.tsx`**: nova página do Kanban
- **`src/App.tsx`**: nova rota
- **`src/pages/TenantForm.tsx`**: configuração das colunas do Kanban
- **`src/pages/TenantDashboard.tsx`**: link para o Kanban
- **`src/hooks/useCrmLeads.ts`**: hook para CRUD de leads
- **`src/integrations/supabase/types.ts`**: atualizado automaticamente

