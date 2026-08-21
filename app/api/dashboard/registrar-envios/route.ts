import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest, textoSeguro } from '@/lib/supabase-admin';

type ResultadoContadores = {
  novos_envios?: number;
  enviados_informados?: number;
  pendentes_informados?: number;
};

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();

  try {
    const corpo = await lerCorpoLimitado(request, 64 * 1024);
    const recebido = JSON.parse(new TextDecoder().decode(corpo));
    const codigos = Array.from(new Set(
      (Array.isArray(recebido?.codigos) ? recebido.codigos : [])
        .slice(0, 500)
        .map((codigo: unknown) => textoSeguro(codigo, 80))
        .filter(Boolean)
    ));

    if (!codigos.length) {
      return Response.json({ erro: 'Nenhum código enviado para contabilização.' }, { status: 400 });
    }

    const dados = await supabaseRest('rpc/registrar_envios_bling', {
      method: 'POST',
      body: JSON.stringify({ p_codigos: codigos }),
    });
    const resultado = (Array.isArray(dados) ? dados[0] : dados) as ResultadoContadores | undefined;

    return Response.json({
      novosEnvios: Number(resultado?.novos_envios) || 0,
      enviados: Number(resultado?.enviados_informados) || 0,
      pendentes: Number(resultado?.pendentes_informados) || 0,
    });
  } catch (erro) {
    return Response.json({
      erro: erro instanceof Error ? erro.message : 'Falha ao atualizar os contadores do painel.',
    }, { status: 502 });
  }
}
