

## Plano: Corrigir Echo de Áudio + Cancelamento para Datas Futuras + Exportar Prompt

### Problemas Identificados

**1. Echo de áudio** — Quando o cliente envia um áudio, a IA transcreve e REPETE a transcrição como primeira parte da resposta. Exemplo nos logs:
- Parte 1/2: `"Houve um imprevisto, cara, vou ter que cancelar meu corte da segunda-feira, valeu."` (repetição da transcrição)
- Parte 2/2: `"Entendi! Sem problemas. Não quer agendar para outro dia?"` (resposta real)

**Causa**: O prompt de áudio diz "Transcreva o que foi dito e responda". A IA interpreta literalmente e escreve a transcrição + resposta. Precisa mudar a instrução para "Entenda o áudio e responda ao conteúdo, SEM repetir/transcrever o que foi dito".

**2. Auto-fetch de cancelamento usa data errada** — Linha 1489: quando `desmarcar_agendamento` é chamado sem `validAgendasIds`, o sistema busca agendamentos de `today`. Se o agendamento é para outro dia (ex: 13/04), não encontra e falha.

**Causa**: `const today = ...` hardcoded. Precisa extrair a data do `sessionState.selectedDate`, dos args da tool, ou do contexto da conversa.

**3. Exportar prompt** — Vou gerar o prompt completo do código e salvar como arquivo para você revisar.

---

### Mudanças

**Arquivo**: `supabase/functions/whatsapp-webhook/index.ts`

**Correção 1 — Parar echo de áudio (linhas ~1326-1329)**
- Mudar instrução de áudio de "Transcreva o que foi dito em pt-BR e responda" para "Entenda o conteúdo do áudio e responda diretamente. NÃO transcreva nem repita o que o cliente disse."
- Adicionar regra no prompt base: "Quando receber áudio, NUNCA repita o que o cliente disse entre aspas."

**Correção 2 — Auto-fetch de cancelamento para data correta (linhas ~1487-1498)**
- Ao invés de usar `today`, extrair a data:
  1. Do `sessionState.selectedDate` (se já foi definida na conversa)
  2. Dos `parsedArgs` da tool (se a IA passou uma data)
  3. Das mensagens recentes (regex para "segunda", "dia 13", datas YYYY-MM-DD)
  4. Fallback: buscar nos últimos 7 dias (today + próximos 7 dias) em paralelo

**Correção 3 — Gerar arquivo com prompt completo**
- Script que monta o prompt como aparece para o modelo e salva em `/mnt/documents/prompt_completo.md`

---

### Detalhes Técnicos

Instrução de áudio atual:
```
"O cliente enviou um áudio. Transcreva o que foi dito em pt-BR e responda ao conteúdo."
```

Nova instrução:
```
"O cliente enviou um áudio. Entenda o conteúdo e responda diretamente. NÃO repita, transcreva ou cite entre aspas o que o cliente disse."
```

Auto-fetch de cancelamento atual:
```typescript
const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
```

Novo: tentar extrair data do contexto:
```typescript
const targetDate = sessionState.selectedDate 
  || extractDateFromArgs(parsedArgs) 
  || extractDateFromMessages(messages) 
  || todayBrasilia;
```

Também adicionar ao prompt base na seção "O QUE NUNCA FAZER":
```
- Repetir, transcrever ou citar entre aspas o que o cliente disse em áudio
```

