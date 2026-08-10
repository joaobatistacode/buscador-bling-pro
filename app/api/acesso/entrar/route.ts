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
    return Response.json(
      { erro: 'O acesso ainda não foi configurado no ambiente.' },
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
