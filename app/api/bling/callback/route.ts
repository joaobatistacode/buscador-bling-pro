import { cookies } from 'next/headers';
import { guardarSessao, pedirToken } from '../sessao';

// Volta do Bling com o código de autorização. Troca por token e devolve o
// usuário para a página inicial.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const codigo = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const erro = url.searchParams.get('error');

  const voltar = (situacao: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/?bling=${encodeURIComponent(situacao)}` },
    });

  if (erro) return voltar(`erro: ${erro}`);
  if (!codigo) return voltar('erro: o Bling não devolveu o código');

  // Confere o state que gravamos antes de redirecionar.
  const jarro = await cookies();
  const esperado = jarro.get('bling_state')?.value;
  jarro.delete('bling_state');

  if (!esperado || esperado !== state) {
    return voltar('erro: a resposta do Bling não confere com o pedido');
  }

  try {
    const sessao = await pedirToken({
      grant_type: 'authorization_code',
      code: codigo,
    });
    await guardarSessao(sessao);
    return voltar('conectado');
  } catch (e: any) {
    return voltar(`erro: ${e.message}`);
  }
}
