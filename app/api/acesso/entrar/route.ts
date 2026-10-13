import { cookies } from 'next/headers';
import {
  acessoConfigurado,
  COOKIE_ACESSO,
  criarTokenSessao,
  DURACAO_SESSAO,
  lerCorpoLimitado,
  origemInvalida,
  origemPermitida,
  senhaCorreta,
} from '@/lib/acesso';

const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function POST(request: Request) {
  if (!origemPermitida(request)) return origemInvalida();

  if (!acessoConfigurado()) {
    const pendencias: string[] = [];
    if (!process.env.APP_ACCESS_PASSWORD || process.env.APP_ACCESS_PASSWORD.length < 10) {
      pendencias.push('APP_ACCESS_PASSWORD (mínimo de 10 caracteres)');
    }
    if (!process.env.APP_SESSION_SECRET || process.env.APP_SESSION_SECRET.length < 32) {
      pendencias.push('APP_SESSION_SECRET (mínimo de 32 caracteres)');
    }
    return Response.json(
      { erro: `Configuração pendente na Vercel: ${pendencias.join(' e ')}.` },
      { status: 503 }
    );
  }

  let corpo: Uint8Array<ArrayBuffer>;
  try {
    corpo = await lerCorpoLimitado(request, 2048);
  } catch {
    return Response.json({ erro: 'Requisição inválida.' }, { status: 413 });
  }
  const dados = (() => {
    try { return JSON.parse(new TextDecoder().decode(corpo)); } catch { return null; }
  })();
  const senha = typeof dados?.senha === 'string' ? dados.senha : '';
  if (!senha || senha.length > 256 || !senhaCorreta(senha)) {
    await esperar(750);
    return Response.json({ erro: 'Senha inválida.' }, { status: 401 });
  }

  const jarro = await cookies();
  jarro.set(COOKIE_ACESSO, criarTokenSessao(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DURACAO_SESSAO,
  });

  return Response.json({ ok: true });
}
