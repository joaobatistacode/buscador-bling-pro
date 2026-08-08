import { apagarSessao, lerSessao } from '../sessao';

// Diz à página se já existe conexão com o Bling, sem nunca expor o token.
export async function GET() {
  const sessao = await lerSessao();
  const configurado = !!(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET);

  return Response.json({
    conectado: !!sessao,
    configurado,
  });
}

// Desconectar: joga a sessão fora.
export async function DELETE() {
  await apagarSessao();
  return Response.json({ conectado: false });
}
