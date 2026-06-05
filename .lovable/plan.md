## Diagnóstico

Verifiquei o banco: **só 4 de 687 leads têm `ai_summary` preenchido**. O código já está todo no lugar (migração, tool `atualizar_resumo_cliente`, auto-persist, leitura no prompt, card no CRM). O problema é que o **extrator automático está sendo conservador demais** e quase nunca decide salvar.

Logs reais do extrator hoje:
- "Informação é pontual sobre indisponibilidade… (efêmera)" → não salvou
- "Apenas cumprimento e pergunta do atendente… não é confirmação" → não salvou

Resultado: o painel do cliente fica vazio porque o resumo só nasce em casos raríssimos.

## O que vou mudar

### 1. Tornar o extrator automático muito mais inclusivo (`whatsapp-webhook/index.ts`)

**Critério de disparo** (hoje exige regex de palavra-chave OU tool call OU resumo já existente):
- Passar a rodar **sempre que a conversa tiver ≥ 2 mensagens do cliente** (ou já existir resumo), independente de regex. Continua pulando saudação isolada ("oi", "bom dia") sem nada mais.

**Prompt do extrator** (hoje rejeita "informação pontual"):
- Passar a capturar qualquer um destes, mesmo que isolado:
  - Nome do cliente (quando descoberto)
  - Serviço(s) que o cliente já demonstrou interesse / agendou
  - Profissional mencionado/preferido
  - Janela de horário típica (manhã/tarde/sábado)
  - Plano/clube/assinatura
  - Restrições, alergias, observações úteis
  - Status da última interação (agendou, desistiu, pediu preço, primeiro contato)
- Regra de **merge incremental**: receber `currentSummary` e devolver uma versão **expandida** (não apagar o que já existe se a info nova for compatível). Manter ≤ 600 chars.
- `should_update = true` por padrão; só `false` se a mensagem for puramente social ("ok", "obrigado", "tchau") sem nada novo.

**Custo**: 1 chamada extra de IA por mensagem processada. Uso modelo barato (mantém o `modelUsed` atual com `reasoning_effort: "low"`). Se ficar caro, depois trocamos para um modelo dedicado mais leve.

### 2. Mostrar o resumo também na tela de **Conversas** do painel do cliente

Hoje o resumo só aparece nos cards do CRM. Vou adicionar um bloco discreto **"🤖 Resumo da IA"** no cabeçalho da conversa selecionada em `src/pages/client/Conversations.tsx` (logo abaixo do nome/telefone do contato), lendo `crm_leads.ai_summary` pelo `tenant_id + phone_number`. Read-only. Se vazio, não renderiza nada.

### 3. Backfill opcional dos leads existentes

Adicionar um botão pequeno **"Gerar resumos faltantes"** no topo do CRM (visível só para quem tem permissão de edição do módulo `crm`) que dispara uma edge function nova `backfill-client-summaries` rodando o mesmo extrator sobre as últimas N mensagens de cada lead sem resumo do tenant atual. Processamento em lote pequeno (ex: 20 por clique) para não estourar custo/limite. Mostra progresso e ignora leads que não têm histórico suficiente.

> Se preferir não gastar tokens fazendo backfill, podemos pular o item 3 e deixar só os resumos crescerem organicamente daqui pra frente. Me diz na hora de implementar.

## Detalhes técnicos

**Arquivos alterados**
- `supabase/functions/whatsapp-webhook/index.ts` — afrouxar `maybeAutoPersistClientSummary` (gating + prompt do extrator + merge).
- `src/pages/client/Conversations.tsx` — buscar `ai_summary` do lead selecionado e renderizar bloco resumo.
- `src/hooks/useCrmLeads.ts` — (talvez) helper para buscar 1 lead por phone.
- (opcional) nova edge function `supabase/functions/backfill-client-summaries/index.ts` + botão no `src/pages/client/Crm.tsx`.

**Não muda**
- Schema do banco (colunas `ai_summary` e `ai_summary_updated_at` já existem).
- RLS, prompt principal, providers, simulador, fluxo do WhatsApp real.
- Tool `atualizar_resumo_cliente` continua disponível para a IA chamar explicitamente.

## Critério de "100% funcionando"

- Depois de 2-3 mensagens trocadas com qualquer cliente, o resumo aparece preenchido no card do CRM **e** no topo da conversa.
- Resumo evolui conforme a conversa (merge incremental, não reescreve do zero).
- Painel não fica mais "vazio" para a grande maioria dos contatos.
