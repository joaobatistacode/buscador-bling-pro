import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest, textoSeguro } from '@/lib/supabase-admin';

type Objeto = Record<string, unknown>;

const STATUS_LOTE = new Set(['PRONTO', 'EM_ANDAMENTO', 'PAUSADO', 'FINALIZADO', 'REVISAO', 'CANCELADO']);
const STATUS_ITEM = new Set(['PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'IGNORADO', 'FALHA', 'REVISAO']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function idValido(valor: unknown, nome: string) {
  const id = String(valor || '').trim();
  if (!UUID.test(id)) throw new Error(`${nome} inválido.`);
  return id;
}

async function recalcularLote(loteId: string) {
  const itens = await supabaseRest(
    `bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&select=status&limit=500`,
    { method: 'GET' },
  ) as Array<{ status: string }>;
  const contagem = {
    total: itens.length,
    pendentes: itens.filter(item => item.status === 'PENDENTE').length,
    processando: itens.filter(item => item.status === 'PROCESSANDO').length,
    concluidos: itens.filter(item => item.status === 'CONCLUIDO').length,
    ignorados: itens.filter(item => item.status === 'IGNORADO').length,
    falhas: itens.filter(item => item.status === 'FALHA' || item.status === 'REVISAO').length,
  };
  const [atual] = await supabaseRest(
    `bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&select=status&limit=1`,
    { method: 'GET' },
  ) as Array<{ status: string }>;
  let status = STATUS_LOTE.has(atual?.status) ? atual.status : 'PRONTO';
  const terminou = contagem.pendentes === 0 && contagem.processando === 0;
  if (terminou && !['CANCELADO'].includes(status)) status = contagem.falhas ? 'REVISAO' : 'FINALIZADO';
  const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...contagem,
      status,
      updated_at: new Date().toISOString(),
      concluido_em: terminou ? new Date().toISOString() : null,
    }),
  });
  return lote;
}

export async function GET(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    const loteId = new URL(request.url).searchParams.get('id');
    if (!loteId) {
      const lotes = await supabaseRest('bling_imagens_lotes?select=*&order=created_at.desc&limit=10', { method: 'GET' });
      return Response.json({ lotes });
    }
    const id = idValido(loteId, 'Lote');
    const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { method: 'GET' });
    if (!lote) return Response.json({ erro: 'Lote não encontrado.' }, { status: 404 });
    const itens = await supabaseRest(
      `bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(id)}&select=*&order=posicao.asc&limit=500`,
      { method: 'GET' },
    );
    return Response.json({ lote, itens });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao consultar o lote.' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const corpo = await lerCorpoLimitado(request, 512 * 1024);
    const pedido = JSON.parse(new TextDecoder().decode(corpo)) as Objeto;
    const acao = String(pedido.acao || '');

    if (acao === 'criar') {
      const recebidos = Array.isArray(pedido.produtos) ? pedido.produtos.slice(0, 501) : [];
      if (!recebidos.length || recebidos.length > 500) throw new Error('Selecione entre 1 e 500 produtos.');
      const ids = new Set<number>();
      const produtos = recebidos.map((entrada, indice) => {
        const item = entrada && typeof entrada === 'object' ? entrada as Objeto : {};
        const idProduto = Number(item.id);
        const codigo = textoSeguro(item.codigo, 120);
        const produto = textoSeguro(item.nome, 300);
        if (!Number.isSafeInteger(idProduto) || idProduto <= 0 || !codigo || !produto || ids.has(idProduto)) {
          throw new Error(`Produto inválido ou repetido na posição ${indice + 1}.`);
        }
        ids.add(idProduto);
        return { idProduto, codigo, produto };
      });
      const [lote] = await supabaseRest('bling_imagens_lotes', {
        method: 'POST',
        body: JSON.stringify({ status: 'PRONTO', total: produtos.length, pendentes: produtos.length }),
      });
      if (!lote?.id) throw new Error('Não foi possível criar o lote.');
      await supabaseRest('bling_imagens_lote_itens', {
        method: 'POST',
        body: JSON.stringify(produtos.map((item, indice) => ({
          lote_id: lote.id,
          posicao: indice + 1,
          id_produto_bling: item.idProduto,
          codigo: item.codigo,
          produto: item.produto,
          status: 'PENDENTE',
        }))),
      });
      return Response.json({ lote: await recalcularLote(String(lote.id)) });
    }

    const loteId = idValido(pedido.loteId, 'Lote');

    if (acao === 'iniciar') {
      await supabaseRest(
        `bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=eq.PROCESSANDO`,
        { method: 'PATCH', body: JSON.stringify({ status: 'PENDENTE', etapa: 'RETOMADO', updated_at: new Date().toISOString() }) },
      );
      const [lote] = await supabaseRest(
        `bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&status=in.(PRONTO,PAUSADO,REVISAO)`,
        { method: 'PATCH', body: JSON.stringify({ status: 'EM_ANDAMENTO', updated_at: new Date().toISOString(), concluido_em: null }) },
      );
      if (!lote) throw new Error('Este lote não pode ser iniciado ou já foi finalizado.');
      return Response.json({ lote: await recalcularLote(loteId) });
    }

    if (acao === 'pausar') {
      const [lote] = await supabaseRest(
        `bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&status=eq.EM_ANDAMENTO`,
        { method: 'PATCH', body: JSON.stringify({ status: 'PAUSADO', updated_at: new Date().toISOString() }) },
      );
      if (!lote) throw new Error('O lote não está em andamento.');
      return Response.json({ lote });
    }

    if (acao === 'reivindicar') {
      const [lote] = await supabaseRest(
        `bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&select=status&limit=1`,
        { method: 'GET' },
      );
      if (lote?.status !== 'EM_ANDAMENTO') return Response.json({ pausado: true, lote });
      const [proximo] = await supabaseRest(
        `bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=eq.PENDENTE&select=*&order=posicao.asc&limit=1`,
        { method: 'GET' },
      );
      if (!proximo) return Response.json({ finalizado: true, lote: await recalcularLote(loteId) });
      const [item] = await supabaseRest(
        `bling_imagens_lote_itens?id=eq.${encodeURIComponent(String(proximo.id))}&status=eq.PENDENTE`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'PROCESSANDO',
            etapa: 'CONSULTANDO',
            tentativas: Number(proximo.tentativas || 0) + 1,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!item) return Response.json({ concorrencia: true });
      await recalcularLote(loteId);
      return Response.json({ item });
    }

    if (acao === 'atualizar-item') {
      const itemId = idValido(pedido.itemId, 'Item');
      const status = String(pedido.status || '');
      if (!STATUS_ITEM.has(status)) throw new Error('Status do item inválido.');
      const etapa = textoSeguro(pedido.etapa, 80) || status;
      const motivo = textoSeguro(pedido.motivo, 1000) || null;
      const urls = Array.isArray(pedido.urls)
        ? [...new Set(pedido.urls.map(item => String(item || '').trim()).filter(item => /^https:\/\//i.test(item)))].slice(0, 10)
        : undefined;
      const final = ['CONCLUIDO', 'IGNORADO', 'FALHA', 'REVISAO'].includes(status);
      const [item] = await supabaseRest(
        `bling_imagens_lote_itens?id=eq.${encodeURIComponent(itemId)}&lote_id=eq.${encodeURIComponent(loteId)}&status=eq.PROCESSANDO`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status,
            etapa,
            motivo,
            ...(urls ? { urls_marketplace: urls } : {}),
            updated_at: new Date().toISOString(),
            concluido_em: final ? new Date().toISOString() : null,
          }),
        },
      );
      if (!item) throw new Error('O item mudou de estado. Atualize o lote antes de continuar.');
      return Response.json({ item, lote: await recalcularLote(loteId) });
    }

    if (acao === 'tentar-novamente') {
      await supabaseRest(
        `bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=in.(FALHA,REVISAO)`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'PENDENTE', etapa: 'NOVA_TENTATIVA', motivo: null, concluido_em: null, updated_at: new Date().toISOString() }),
        },
      );
      await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'PAUSADO', concluido_em: null, updated_at: new Date().toISOString() }),
      });
      return Response.json({ lote: await recalcularLote(loteId) });
    }

    return Response.json({ erro: 'Ação desconhecida.' }, { status: 400 });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao administrar o lote.' }, { status: 400 });
  }
}
