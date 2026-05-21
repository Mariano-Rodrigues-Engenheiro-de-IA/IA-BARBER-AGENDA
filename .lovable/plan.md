## Diagnóstico
Encontrei um caso recente exatamente com o erro que você descreveu.

- Às 11:45, no tenant da Barbearia Marquez, a IA recebeu: `Bom dia! Está precisando de produtos?`
- Ela executou `buscar_cliente` e, em seguida, chamou `cadastrar_cliente` com `nome: "Bom dia Está precisando de produtos"`.
- Ou seja: o bloqueio atual não segurou esse caso em produção.
- Também vi outra resposta hoje ainda usando `nome completo`, então a instrução nova não está suficientemente amarrada no fluxo real.

## O que vou ajustar

### 1. Travar o cadastro por estado de conversa
Vou criar uma trava explícita para One Beleza:
- Se `buscar_cliente` não encontrar o cliente, a conversa entra em estado `aguardando_nome_cadastro`.
- Enquanto esse estado estiver ativo, `cadastrar_cliente` só poderá rodar depois de uma NOVA mensagem do cliente que passe no validador de nome.
- A IA não poderá buscar e cadastrar “tudo no mesmo turno” quando a primeira mensagem for só uma abordagem comercial, saudação, áudio transcrito ou qualquer frase solta.

### 2. Endurecer a validação do nome no ponto final do cadastro
Além do prompt, vou reforçar a barreira no backend:
- Validar novamente o `nome` imediatamente antes de enviar para a API da One Beleza.
- Bloquear qualquer texto com cara de frase comercial, saudação, pergunta, oferta, transcrição ou frase com verbos.
- Se bloquear, devolver uma instrução rígida para a IA perguntar apenas: `Qual seu nome e sobrenome?` e aguardar.
- Essa proteção vai valer mesmo se a IA insistir em passar um nome inválido manualmente.

### 3. Proibir reaproveitamento indevido da mensagem inicial como nome
Vou revisar a lógica que extrai/guarda nome explícito para garantir que:
- a primeira mensagem do cliente nunca seja reaproveitada como nome por engano;
- frases como `Bom dia`, `Está precisando de produtos?`, `Quero agendar`, `Tem horário?` nunca virem nome;
- áudio transcrito só possa virar nome quando houver contexto claro de que a IA acabou de pedir o nome.

### 4. Corrigir a etapa de pergunta do cadastro
Vou padronizar o fluxo One Beleza para sempre seguir esta ordem:
- `buscar_cliente`
- se não existir: perguntar `Qual seu nome e sobrenome?`
- aguardar resposta válida
- só então `cadastrar_cliente`

Também vou eliminar o texto `nome completo` dessa etapa e forçar `nome e sobrenome` nas mensagens de bloqueio e nas instruções do provider.

### 5. Adicionar rastreabilidade para auditoria
Vou registrar melhor quando o sistema bloquear nome inválido, incluindo:
- texto bruto recebido;
- motivo do bloqueio;
- quantidade de tentativas;
- tenant e telefone.

Assim fica fácil localizar futuros gargalos sem depender só da agenda.

## Resultado esperado
Depois disso, casos como estes serão bloqueados automaticamente:
- `Bom dia, está precisando de produtos?`
- `Quero agendar um corte`
- `Tem horário hoje?`
- transcrições longas de áudio

E só passarão nomes realmente válidos, como:
- `João Silva`
- `Ana Beatriz`
- `Guilherme de Melo`

## Arquivo principal
- `supabase/functions/whatsapp-webhook/index.ts`

## Observação técnica
A falha não está só no prompt; ela precisa ser resolvida com trava de estado + validação final obrigatória no backend. Isso evita que a IA cadastre alguém sem antes coletar um nome válido, mesmo quando o modelo tentar “adiantar” o fluxo.