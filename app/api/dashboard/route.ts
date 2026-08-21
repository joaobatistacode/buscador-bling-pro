import { BLING_API, tokenValido } from '@/app/api/bling/sessao';
import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest } from '@/lib/supabase-admin';

type ProdutoPainel = {
  status?: string;
  origem_medidas?: string;
  revisado?: boolean;
  marca?: string;
  curta?: string;
  imagens?: unknown;
};

const quantidadeImagens = (imagens: unknown) => Array.isArray(imagens)
  ? Math.min(4, imagens.filter(item => typeof item === 'string' && item.trim()).length)
  : 0;

const preenchido = (valor: unknown) => {
  const texto = String(valor ?? '').trim().toLocaleLowerCase('pt-BR');
  return Boolean(texto) && !texto.includes('não informado') && !texto.includes('nao informado') && !texto.startsWith('erro ia:');
};

async function verificarBling() {
  const configurado = Boolean(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET);
  if (!configurado) return { configurado: false, conectado: false, api: 'NAO_CONFIGURADA' };

  try {
    const token = await tokenValido();
    if (!token) return { configurado: true, conectado: false, api: 'DESCONECTADA' };
    const resposta = await fetch(`${BLING_API}/produtos?pagina=1&limite=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
      cache: 'no-store',
    });
    if (resposta.ok) return { configurado: true, conectado: true, api: 'ONLINE' };
    if (resposta.status === 429) return { configurado: true, conectado: true, api: 'LIMITADA' };
    return { configurado: true, conectado: resposta.status !== 401, api: resposta.status === 401 ? 'DESCONECTADA' : 'INDISPONIVEL' };
  } catch {
    return { configurado: true, conectado: true, api: 'INDISPONIVEL' };
  }
}

export async function GET() {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    const [produtos, tarefas, configuracoes, bling] = await Promise.all([
      supabaseRest('bling_produtos?select=status,origem_medidas,revisado,marca,curta,imagens&limit=10000', { method: 'GET' }),
      supabaseRest('bling_tarefas?select=status&limit=2000', { method: 'GET' }),
      supabaseRest('bling_painel_configuracao?id=eq.1&select=enviados_informados,pendentes_informados,updated_at&limit=1', { method: 'GET' }),
      verificarBling(),
    ]);

    const linhasProdutos = produtos as ProdutoPainel[];
    const linhasTarefas = tarefas as Array<{ status?: string }>;
    const enviadosHistorico = linhasProdutos.filter(produto => produto.status === 'ENVIADO');
    const revisados = linhasProdutos.filter(produto => produto.revisado).length;
    const aguardandoRevisao = linhasProdutos.filter(produto => produto.status !== 'ENVIADO' && !produto.revisado).length;
    const reais = linhasProdutos.filter(produto => produto.origem_medidas === 'REAL').length;
    const tarefasPendentes = linhasTarefas.filter(tarefa => tarefa.status !== 'CONCLUIDA').length;
    const fotos = { 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 } as Record<0 | 1 | 2 | 3 | 4, number>;
    enviadosHistorico.forEach(produto => { fotos[quantidadeImagens(produto.imagens) as 0 | 1 | 2 | 3 | 4] += 1; });
    const comMarca = enviadosHistorico.filter(produto => preenchido(produto.marca)).length;
    const comDescricao = enviadosHistorico.filter(produto => preenchido(produto.curta)).length;
    const configuracao = (configuracoes as Array<{ enviados_informados?: number; pendentes_informados?: number; updated_at?: string }>)[0];
    const enviadosInformados = Math.max(0, Number(configuracao?.enviados_informados) || 0);
    const pendentesInformados = Math.max(0, Number(configuracao?.pendentes_informados) || 0);

    return Response.json({
      operacao: {
        enviados: enviadosInformados,
        pendentes: pendentesInformados,
        total: enviadosInformados + pendentesInformados,
        atualizadoEm: configuracao?.updated_at || null,
      },
      historico: {
        total: linhasProdutos.length,
        enviados: enviadosHistorico.length,
        revisados,
        aguardandoRevisao,
        medidasReais: reais,
        medidasEstimadas: linhasProdutos.length - reais,
      },
      qualidade: {
        baseEnviados: enviadosHistorico.length,
        fotos,
        marca: { com: comMarca, sem: enviadosHistorico.length - comMarca },
        descricao: { com: comDescricao, sem: enviadosHistorico.length - comDescricao },
      },
      tarefas: { pendentes: tarefasPendentes, concluidas: linhasTarefas.length - tarefasPendentes },
      integracoes: {
        bling,
        supabase: { configurado: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), online: true },
        telegram: { configurado: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) },
      },
    });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha no dashboard.' }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const corpo = await lerCorpoLimitado(request, 8 * 1024);
    const dados = JSON.parse(new TextDecoder().decode(corpo));
    const enviados = Number(dados?.enviados);
    const pendentes = Number(dados?.pendentes);
    if (![enviados, pendentes].every(valor => Number.isInteger(valor) && valor >= 0 && valor <= 10_000_000)) {
      return Response.json({ erro: 'Informe quantidades inteiras e positivas.' }, { status: 400 });
    }
    const [salvo] = await supabaseRest('bling_painel_configuracao?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ id: 1, enviados_informados: enviados, pendentes_informados: pendentes, updated_at: new Date().toISOString() }),
    });
    return Response.json({ configuracao: salvo });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao salvar os totais.' }, { status: 502 });
  }
}
