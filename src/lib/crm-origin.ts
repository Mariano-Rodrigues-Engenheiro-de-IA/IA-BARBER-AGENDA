// Detecta quando o cliente chegou aqui através do link mágico disparado
// pelo CRM Zaylo (?from=crm na URL) — usado pra decidir pra onde mandar
// o usuário quando ele clicar em "Sair": de volta pro CRM, não pra tela
// de login própria (que confundiria, já que esse usuário nunca teve
// senha nessa conta — só acessa via link mágico).

const STORAGE_KEY = "zaylo_access_origin";
const CRM_URL = "https://crm.zayloia.com/painel";

/** Chama isso uma vez, o mais cedo possível na inicialização do app —
 * marca a origem se o parâmetro estiver presente na URL atual. */
export function markCrmOriginIfPresent() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") === "crm") {
      sessionStorage.setItem(STORAGE_KEY, "crm");
    }
  } catch {
    // sessionStorage indisponível (modo privado restrito, etc.) — sem
    // marcação, o botão "Sair" só segue o comportamento padrão.
  }
}

export function cameFromCrm(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "crm";
  } catch {
    return false;
  }
}

/** Pra onde mandar o usuário depois de sair — CRM se ele veio de lá,
 * senão undefined (segue o comportamento padrão de sempre). */
export function postLogoutRedirect(): string | undefined {
  return cameFromCrm() ? CRM_URL : undefined;
}
