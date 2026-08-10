import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const COOKIE_ACESSO = 'app_acesso';
export const DURACAO_SESSAO = 60 * 60 * 12;

function segredoSessao() {
  return process.env.APP_SESSION_SECRET || '';
}

export function acessoConfigurado() {
  return Boolean(
    process.env.APP_ACCESS_PASSWORD &&
    process.env.APP_ACCESS_PASSWORD.length >= 10 &&
    segredoSessao().length >= 32
  );
}

function assinatura(conteudo: string) {
  return createHmac('sha256', segredoSessao()).update(conteudo).digest('base64url');
}

function iguais(a: string, b: string) {
  const aa = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(aa, bb);
}

export function senhaCorreta(senha: string) {
  const esperada = process.env.APP_ACCESS_PASSWORD || '';
  return acessoConfigurado() && iguais(senha, esperada);
}

export function criarTokenSessao() {
  const expira = Math.floor(Date.now() / 1000) + DURACAO_SESSAO;
  const conteudo = `v1.${expira}`;
  return `${conteudo}.${assinatura(conteudo)}`;
}

export function validarTokenSessao(token?: string) {
  if (!token || !acessoConfigurado()) return false;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return false;

  const expira = Number(partes[1]);
  if (!Number.isInteger(expira) || expira <= Math.floor(Date.now() / 1000)) return false;

  const conteudo = `${partes[0]}.${partes[1]}`;
  return iguais(partes[2], assinatura(conteudo));
}

export async function temAcesso() {
  const jarro = await cookies();
  return validarTokenSessao(jarro.get(COOKIE_ACESSO)?.value);
}

export function naoAutorizado() {
  return Response.json({ erro: 'Acesso não autorizado.' }, { status: 401 });
}

export function origemPermitida(request: Request) {
  const origem = request.headers.get('origin');
  if (!origem) return false;

  try {
    const urlOrigem = new URL(origem);
    const urlPedido = new URL(request.url);
    const hostEsperado = request.headers.get('x-forwarded-host') || request.headers.get('host') || urlPedido.host;
    const protocoloEsperado = request.headers.get('x-forwarded-proto') || urlPedido.protocol.replace(':', '');
    return urlOrigem.protocol === `${protocoloEsperado}:` && urlOrigem.host === hostEsperado;
  } catch {
    return false;
  }
}

export function origemInvalida() {
  return Response.json({ erro: 'Origem da requisição não permitida.' }, { status: 403 });
}

export async function lerCorpoLimitado(request: Request, limite: number): Promise<Uint8Array<ArrayBuffer>> {
  const tamanho = Number(request.headers.get('content-length') || 0);
  if (tamanho > limite) throw new Error('CORPO_GRANDE');
  if (!request.body) return new Uint8Array();

  const leitor = request.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel();
      throw new Error('CORPO_GRANDE');
    }
    partes.push(value);
  }

  const corpo: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    corpo.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return corpo;
}
