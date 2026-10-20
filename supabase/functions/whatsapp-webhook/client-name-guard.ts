// Trava de nome do cadastrar_cliente — apoio para provedores que NÃO são One Beleza.
//
// Bug real 20/10/2026 (Thallys Barber e Bendita Barber Club, Trinks): a trava só
// aceitava o nome quando a ÚLTIMA mensagem do cliente, inteira, parecia um nome.
// Dois cenários legítimos eram barrados e a IA acabava escalando (IA OFF):
//  1) a IA usava o nome do perfil do WhatsApp (ex.: "Vini Bocchi") e o cliente não
//     tinha acabado de digitar nome nenhum;
//  2) o cliente digitava o nome junto com outras linhas no mesmo bloco de mensagens
//     ("Que estava disponível\nVilmar Boeira"), e o bloco inteiro não parece nome.
// Aqui o nome só passa quando é comprovável: igual ao nome do perfil ou formado por
// palavras que o próprio cliente escreveu. A IA continua sem poder inventar nome.

const normalize = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** O nome que a IA passou é comprovável pela conversa (perfil do WhatsApp ou palavras do cliente)? */
export function isNameBackedByConversation(
  argNome: unknown,
  senderName: unknown,
  userMessage: unknown,
): boolean {
  const arg = normalize(argNome);
  if (!arg) return false;

  const sender = normalize(senderName);
  if (sender && arg === sender) return true;

  const tokens = arg.split(" ").filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  const words = new Set(normalize(userMessage).split(" ").filter(Boolean));
  return tokens.every((t) => words.has(t));
}
