import { cookies } from 'next/headers';

// Endereços do Bling. A autorização fica em www e a API em api — são hosts
// diferentes, e trocá-los dá 404 silencioso.
export const BLING_AUTORIZAR = 'https://www.bling.com.br/Api/v3/oauth/authorize';
export const BLING_TOKEN = 'https://www.bling.com.br/Api/v3/oauth/token';
export const BLING_API = 'https://api.bling.com.br/Api/v3';

const COOKIE = 'bling_sessao';

export interface SessaoBling {
  access_token: string;
  refresh_token: string;
  // Momento (epoch em ms) em que o access_token perde a validade.
  expira_em: number;
}

export function credenciais() {
  const id = process.env.BLING_CLIENT_ID;
  const segredo = process.env.BLING_CLIENT_SECRET;
  if (!id || !segredo) {
    throw new Error('Faltam BLING_CLIENT_ID e BLING_CLIENT_SECRET nas variáveis da Vercel.');
  }
  return { id, segredo };
}

// O Bling autentica o app por Basic auth, não por campos no corpo.
function cabecalhoBasico() {
  const { id, segredo } = credenciais();
  return `Basic ${Buffer.from(`${id}:${segredo}`).toString('base64')}`;
}

export async function guardarSessao(sessao: SessaoBling) {
  const jarro = await cookies();
  jarro.set(COOKIE, JSON.stringify(sessao), {
    httpOnly: true,   // fora do alcance de JavaScript no navegador
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 29, // o refresh_token do Bling dura ~30 dias
  });
}

export async function lerSessao(): Promise<SessaoBling | null> {
  const jarro = await cookies();
  const bruto = jarro.get(COOKIE)?.value;
  if (!bruto) return null;

  try {
    const sessao = JSON.parse(bruto);
    if (!sessao?.access_token) return null;
    return sessao;
  } catch {
    return null;
  }
}

export async function apagarSessao() {
  const jarro = await cookies();
  jarro.delete(COOKIE);
}

// Troca o código de autorização (ou o refresh_token) por um access_token.
export async function pedirToken(campos: Record<string, string>): Promise<SessaoBling> {
  const res = await fetch(BLING_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: cabecalhoBasico(),
    },
    body: new URLSearchParams(campos).toString(),
  });

  const dados = await res.json().catch(() => ({}));

  if (!res.ok || !dados.access_token) {
    const motivo = dados.error_description || dados.error || `HTTP ${res.status}`;
    throw new Error(`O Bling recusou a autenticação: ${motivo}`);
  }

  return {
    access_token: dados.access_token,
    refresh_token: dados.refresh_token,
    // Uma margem de 60s evita usar um token que expira no meio da requisição.
    expira_em: Date.now() + ((Number(dados.expires_in) || 3600) - 60) * 1000,
  };
}

// Devolve um access_token válido, renovando por baixo dos panos se preciso.
export async function tokenValido(): Promise<string | null> {
  const sessao = await lerSessao();
  if (!sessao) return null;

  if (Date.now() < sessao.expira_em) {
    return sessao.access_token;
  }

  if (!sessao.refresh_token) return null;

  const renovada = await pedirToken({
    grant_type: 'refresh_token',
    refresh_token: sessao.refresh_token,
  });

  await guardarSessao(renovada);
  return renovada.access_token;
}
