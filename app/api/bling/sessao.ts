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

type ErroOAuth = Error & { statusOAuth?: number };

function objeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === 'object' ? valor as Record<string, unknown> : {};
}

function textoDoErro(valor: unknown) {
  if (typeof valor === 'string') return valor.trim();
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  return '';
}

function motivoOAuth(valor: unknown, status: number) {
  const dados = objeto(valor);
  const erro = objeto(dados.error);
  const partes = [
    textoDoErro(dados.error_description),
    textoDoErro(erro.description),
    textoDoErro(erro.message),
    textoDoErro(erro.type),
    textoDoErro(dados.description),
    textoDoErro(dados.message),
    textoDoErro(dados.error),
  ].filter((item, indice, todos) => item && todos.indexOf(item) === indice);
  return (partes.join(' — ') || `HTTP ${status}`).slice(0, 600);
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
    secure: process.env.NODE_ENV === 'production',
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
    const motivo = motivoOAuth(dados, res.status);
    const falha = new Error(`O Bling recusou a autenticação: ${motivo}`) as ErroOAuth;
    falha.statusOAuth = res.ok ? 502 : res.status;
    throw falha;
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

  try {
    const renovada = await pedirToken({
      grant_type: 'refresh_token',
      refresh_token: sessao.refresh_token,
    });

    await guardarSessao(renovada);
    return renovada.access_token;
  } catch (erro) {
    const status = Number((erro as ErroOAuth)?.statusOAuth);
    if ([400, 401, 403].includes(status)) {
      await apagarSessao();
      const mensagem = erro instanceof Error ? erro.message : 'O Bling recusou a renovação do token.';
      throw new Error(`${mensagem} A sessão inválida foi encerrada; conecte novamente ao Bling em Configurações.`);
    }
    throw erro;
  }
}
