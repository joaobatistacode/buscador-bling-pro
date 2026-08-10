import { apagarSessao, lerSessao } from '../sessao';
import { naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';

// Diz à página se já existe conexão com o Bling, sem nunca expor o token.
export async function GET() {
  if (!(await temAcesso())) return naoAutorizado();
  const sessao = await lerSessao();
  const configurado = !!(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET);

  return Response.json({
    conectado: !!sessao,
    configurado,
  });
}

// Desconectar: joga a sessão fora.
export async function DELETE(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  await apagarSessao();
  return Response.json({ conectado: false });
}
