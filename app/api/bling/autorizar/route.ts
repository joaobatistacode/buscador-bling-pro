import { BLING_AUTORIZAR, credenciais } from '../sessao';

// Manda o usuário para a tela de autorização do Bling. O Bling volta para
// /api/bling/callback com o código.
export async function GET(request: Request) {
  let id: string;
  try {
    ({ id } = credenciais());
  } catch (e: any) {
    return new Response(e.message, { status: 500 });
  }

  const origem = new URL(request.url).origin;
  const retorno = `${origem}/api/bling/callback`;

  // O state protege contra alguém forjar o retorno; conferimos no callback.
  const state = crypto.randomUUID();

  const destino = new URL(BLING_AUTORIZAR);
  destino.searchParams.set('response_type', 'code');
  destino.searchParams.set('client_id', id);
  destino.searchParams.set('state', state);
  destino.searchParams.set('redirect_uri', retorno);

  return new Response(null, {
    status: 302,
    headers: {
      Location: destino.toString(),
      'Set-Cookie': `bling_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}
