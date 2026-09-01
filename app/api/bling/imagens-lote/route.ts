import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest, textoSeguro } from '@/lib/supabase-admin';

type Objeto = Record<string, unknown>;
type ItemFila = {
  id: string;
  lote_id: string;
  id_produto_bling: number;
  codigo: string;
  produto: string;
  status: string;
  etapa: string;
  tentativas: number;
  preco_status: string;
  preco_tentativas: number;
};

const STATUS_LOTE = new Set(['PRONTO', 'EM_ANDAMENTO', 'PAUSADO', 'FINALIZADO', 'REVISAO', 'CANCELADO']);
const STATUS_ITEM = new Set(['PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'IGNORADO', 'FALHA', 'REVISAO']);
const STATUS_PRECO = new Set(['CONCLUIDO', 'PRONTO', 'REVISAO']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function idValido(valor: unknown, nome: string) {
  const id = String(valor || '').trim();
  if (!UUID.test(id)) throw new Error(`${nome} inválido.`);
  return id;
}

function inteiro(valor: unknown, nome: string) {
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero <= 0) throw new Error(`${nome} inválido.`);
  return numero;
}

async function registrarErro(item: ItemFila, origem: 'IMAGENS' | 'PRECO_PROMOCIONAL', etapa: string, mensagem: string, tentativas: number) {
  await supabaseRest('bling_erros_operacionais?on_conflict=origem,item_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      origem,
      lote_id: item.lote_id,
      item_id: item.id,
      id_produto_bling: item.id_produto_bling,
      codigo: item.codigo,
      produto: item.produto,
      etapa,
      mensagem,
      status: 'PENDENTE',
      tentativas,
      updated_at: new Date().toISOString(),
      resolvido_em: null,
    }),
  });
}

async function resolverErro(itemId: string, origem: 'IMAGENS' | 'PRECO_PROMOCIONAL') {
  await supabaseRest(
    `bling_erros_operacionais?item_id=eq.${encodeURIComponent(itemId)}&origem=eq.${origem}&status=eq.PENDENTE`,
    { method: 'PATCH', body: JSON.stringify({ status: 'RESOLVIDO', updated_at: new Date().toISOString(), resolvido_em: new Date().toISOString() }) },
  );
}

async function recalcularLote(loteId: string) {
  const itens = await supabaseRest(
    `bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&select=status,preco_status&limit=500`,
    { method: 'GET' },
  ) as Array<{ status: string; preco_status: string }>;
  const [atual] = await supabaseRest(
    `bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&select=status,atualizar_preco_promocional&limit=1`,
    { method: 'GET' },
  ) as Array<{ status: string; atualizar_preco_promocional: boolean }>;
  const elegiveisPreco = itens.filter(item => ['CONCLUIDO', 'IGNORADO'].includes(item.status));
  const contagem = {
    total: itens.length,
    pendentes: itens.filter(item => item.status === 'PENDENTE').length,
    processando: itens.filter(item => item.status === 'PROCESSANDO').length,
    concluidos: itens.filter(item => item.status === 'CONCLUIDO').length,
    ignorados: itens.filter(item => item.status === 'IGNORADO').length,
    falhas: itens.filter(item => item.status === 'FALHA' || item.status === 'REVISAO').length,
    precos_pendentes: elegiveisPreco.filter(item => item.preco_status === 'PENDENTE').length,
    precos_processando: elegiveisPreco.filter(item => item.preco_status === 'PROCESSANDO').length,
    precos_concluidos: elegiveisPreco.filter(item => item.preco_status === 'CONCLUIDO').length,
    precos_prontos: elegiveisPreco.filter(item => item.preco_status === 'PRONTO').length,
    precos_falhas: elegiveisPreco.filter(item => item.preco_status === 'REVISAO').length,
  };
  let status = STATUS_LOTE.has(atual?.status) ? atual.status : 'PRONTO';
  const imagensAbertas = contagem.pendentes + contagem.processando;
  const precosAbertos = atual?.atualizar_preco_promocional ? contagem.precos_pendentes + contagem.precos_processando : 0;
  const terminou = imagensAbertas === 0 && precosAbertos === 0;
  if (terminou && status !== 'CANCELADO') status = contagem.falhas || contagem.precos_falhas ? 'REVISAO' : 'FINALIZADO';
  const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...contagem, status, updated_at: new Date().toISOString(), concluido_em: terminou ? new Date().toISOString() : null }),
  });
  return lote;
}

export async function GET(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('recurso') === 'erros') {
      const status = url.searchParams.get('status') === 'RESOLVIDO' ? 'RESOLVIDO' : 'PENDENTE';
      const erros = await supabaseRest(`bling_erros_operacionais?status=eq.${status}&select=*&order=updated_at.desc&limit=2000`, { method: 'GET' });
      return Response.json({ erros, status });
    }
    const loteId = url.searchParams.get('id');
    if (!loteId) {
      const lotes = await supabaseRest('bling_imagens_lotes?select=*&order=created_at.desc&limit=10', { method: 'GET' });
      return Response.json({ lotes });
    }
    const id = idValido(loteId, 'Lote');
    const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { method: 'GET' });
    if (!lote) return Response.json({ erro: 'Lote não encontrado.' }, { status: 404 });
    const itens = await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(id)}&select=*&order=posicao.asc&limit=500`, { method: 'GET' });
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
        if (!Number.isSafeInteger(idProduto) || idProduto <= 0 || !codigo || !produto || ids.has(idProduto)) throw new Error(`Produto inválido ou repetido na posição ${indice + 1}.`);
        ids.add(idProduto);
        return { idProduto, codigo, produto };
      });
      const [lote] = await supabaseRest('bling_imagens_lotes', { method: 'POST', body: JSON.stringify({ status: 'PRONTO', total: produtos.length, pendentes: produtos.length }) });
      if (!lote?.id) throw new Error('Não foi possível criar o lote.');
      await supabaseRest('bling_imagens_lote_itens', {
        method: 'POST',
        body: JSON.stringify(produtos.map((item, indice) => ({ lote_id: lote.id, posicao: indice + 1, id_produto_bling: item.idProduto, codigo: item.codigo, produto: item.produto, status: 'PENDENTE' }))),
      });
      return Response.json({ lote: await recalcularLote(String(lote.id)) });
    }

    const loteId = idValido(pedido.loteId, 'Lote');

    if (acao === 'configurar-preco') {
      const idLoja = inteiro(pedido.idLoja, 'Loja');
      const loja = textoSeguro(pedido.loja, 200);
      if (!loja) throw new Error('Nome da loja inválido.');
      const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&status=neq.CANCELADO`, {
        method: 'PATCH',
        body: JSON.stringify({ atualizar_preco_promocional: true, id_loja_bling: idLoja, loja, status: 'PAUSADO', concluido_em: null, updated_at: new Date().toISOString() }),
      });
      if (!lote) throw new Error('O lote não pode receber a configuração de preço.');
      await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&preco_status=eq.DESATIVADO`, {
        method: 'PATCH',
        body: JSON.stringify({ preco_status: 'PENDENTE', preco_motivo: null, preco_concluido_em: null, updated_at: new Date().toISOString() }),
      });
      return Response.json({ lote: await recalcularLote(loteId) });
    }

    if (acao === 'iniciar') {
      await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=eq.PROCESSANDO`, { method: 'PATCH', body: JSON.stringify({ status: 'PENDENTE', etapa: 'RETOMADO', updated_at: new Date().toISOString() }) });
      await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&preco_status=eq.PROCESSANDO`, { method: 'PATCH', body: JSON.stringify({ preco_status: 'PENDENTE', updated_at: new Date().toISOString() }) });
      const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&status=in.(PRONTO,PAUSADO,REVISAO,FINALIZADO)`, { method: 'PATCH', body: JSON.stringify({ status: 'EM_ANDAMENTO', updated_at: new Date().toISOString(), concluido_em: null }) });
      if (!lote) throw new Error('Este lote não pode ser iniciado.');
      return Response.json({ lote: await recalcularLote(loteId) });
    }

    if (acao === 'pausar') {
      const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&status=eq.EM_ANDAMENTO`, { method: 'PATCH', body: JSON.stringify({ status: 'PAUSADO', updated_at: new Date().toISOString() }) });
      if (!lote) throw new Error('O lote não está em andamento.');
      return Response.json({ lote });
    }

    if (acao === 'reivindicar-teste-preco') {
      const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&atualizar_preco_promocional=eq.true&select=*&limit=1`, { method: 'GET' });
      if (!lote) throw new Error('A etapa de preço promocional não está configurada.');
      if (lote.preco_teste_confirmado === true) return Response.json({ confirmado: true, lote });
      const [proximo] = await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=in.(CONCLUIDO,IGNORADO)&preco_status=eq.PENDENTE&select=*&order=posicao.asc&limit=1`, { method: 'GET' }) as ItemFila[];
      if (!proximo) throw new Error('Nenhum produto concluído está disponível para o teste de preço.');
      const [item] = await supabaseRest(`bling_imagens_lote_itens?id=eq.${encodeURIComponent(proximo.id)}&preco_status=eq.PENDENTE`, { method: 'PATCH', body: JSON.stringify({ preco_status: 'PROCESSANDO', preco_tentativas: Number(proximo.preco_tentativas || 0) + 1, updated_at: new Date().toISOString() }) });
      if (!item) return Response.json({ concorrencia: true });
      return Response.json({ item, idLoja: lote.id_loja_bling, loja: lote.loja });
    }

    if (acao === 'reivindicar') {
      const [lote] = await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&select=*&limit=1`, { method: 'GET' });
      if (lote?.status !== 'EM_ANDAMENTO') return Response.json({ pausado: true, lote });
      const [proximo] = await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=eq.PENDENTE&select=*&order=posicao.asc&limit=1`, { method: 'GET' }) as ItemFila[];
      if (proximo) {
        const [item] = await supabaseRest(`bling_imagens_lote_itens?id=eq.${encodeURIComponent(proximo.id)}&status=eq.PENDENTE`, { method: 'PATCH', body: JSON.stringify({ status: 'PROCESSANDO', etapa: 'CONSULTANDO', tentativas: Number(proximo.tentativas || 0) + 1, updated_at: new Date().toISOString() }) });
        if (!item) return Response.json({ concorrencia: true });
        await recalcularLote(loteId);
        return Response.json({ tipo: 'IMAGENS', item });
      }
      if (lote.atualizar_preco_promocional === true) {
        if (lote.preco_teste_confirmado !== true) {
          await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}&status=eq.EM_ANDAMENTO`, { method: 'PATCH', body: JSON.stringify({ status: 'PAUSADO', updated_at: new Date().toISOString() }) });
          return Response.json({ aguardandoTestePreco: true, lote: await recalcularLote(loteId) });
        }
        const [proximoPreco] = await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=in.(CONCLUIDO,IGNORADO)&preco_status=eq.PENDENTE&select=*&order=posicao.asc&limit=1`, { method: 'GET' }) as ItemFila[];
        if (proximoPreco) {
          const [item] = await supabaseRest(`bling_imagens_lote_itens?id=eq.${encodeURIComponent(proximoPreco.id)}&preco_status=eq.PENDENTE`, { method: 'PATCH', body: JSON.stringify({ preco_status: 'PROCESSANDO', preco_tentativas: Number(proximoPreco.preco_tentativas || 0) + 1, updated_at: new Date().toISOString() }) });
          if (!item) return Response.json({ concorrencia: true });
          await recalcularLote(loteId);
          return Response.json({ tipo: 'PRECO', item, idLoja: lote.id_loja_bling, loja: lote.loja });
        }
      }
      return Response.json({ finalizado: true, lote: await recalcularLote(loteId) });
    }

    if (acao === 'atualizar-item') {
      const itemId = idValido(pedido.itemId, 'Item');
      const status = String(pedido.status || '');
      if (!STATUS_ITEM.has(status)) throw new Error('Status do item inválido.');
      const etapa = textoSeguro(pedido.etapa, 80) || status;
      const motivo = textoSeguro(pedido.motivo, 1000) || null;
      const urls = Array.isArray(pedido.urls) ? [...new Set(pedido.urls.map(item => String(item || '').trim()).filter(item => /^https:\/\//i.test(item)))].slice(0, 10) : undefined;
      const final = ['CONCLUIDO', 'IGNORADO', 'FALHA', 'REVISAO'].includes(status);
      const [item] = await supabaseRest(`bling_imagens_lote_itens?id=eq.${encodeURIComponent(itemId)}&lote_id=eq.${encodeURIComponent(loteId)}&status=eq.PROCESSANDO`, {
        method: 'PATCH',
        body: JSON.stringify({ status, etapa, motivo, ...(urls ? { urls_marketplace: urls } : {}), updated_at: new Date().toISOString(), concluido_em: final ? new Date().toISOString() : null }),
      }) as ItemFila[];
      if (!item) throw new Error('O item mudou de estado. Atualize o lote antes de continuar.');
      if (status === 'FALHA' || status === 'REVISAO') await registrarErro(item, 'IMAGENS', etapa, motivo || 'Falha de imagens sem mensagem.', Number(item.tentativas || 0));
      else if (status === 'CONCLUIDO' || status === 'IGNORADO') await resolverErro(item.id, 'IMAGENS');
      return Response.json({ item, lote: await recalcularLote(loteId) });
    }

    if (acao === 'atualizar-preco-item') {
      const itemId = idValido(pedido.itemId, 'Item');
      const status = String(pedido.status || '');
      if (!STATUS_PRECO.has(status)) throw new Error('Status do preço inválido.');
      const motivo = textoSeguro(pedido.motivo, 1000) || null;
      const numeroOuNulo = (valor: unknown) => Number.isFinite(Number(valor)) ? Number(valor) : null;
      const [item] = await supabaseRest(`bling_imagens_lote_itens?id=eq.${encodeURIComponent(itemId)}&lote_id=eq.${encodeURIComponent(loteId)}&preco_status=eq.PROCESSANDO`, {
        method: 'PATCH',
        body: JSON.stringify({ preco_status: status, preco: numeroOuNulo(pedido.preco), preco_promocional_antes: numeroOuNulo(pedido.precoPromocionalAntes), preco_promocional_depois: numeroOuNulo(pedido.precoPromocionalDepois), preco_motivo: motivo, preco_concluido_em: new Date().toISOString(), updated_at: new Date().toISOString() }),
      }) as ItemFila[];
      if (!item) throw new Error('O preço mudou de estado. Atualize o lote antes de continuar.');
      if (pedido.teste === true && status === 'CONCLUIDO') {
        await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}`, { method: 'PATCH', body: JSON.stringify({ preco_teste_confirmado: true, status: 'PAUSADO', updated_at: new Date().toISOString() }) });
      }
      if (status === 'REVISAO') await registrarErro(item, 'PRECO_PROMOCIONAL', 'ATUALIZAR_PRECO_PROMOCIONAL', motivo || 'Falha de preço sem mensagem.', Number(item.preco_tentativas || 0));
      else await resolverErro(item.id, 'PRECO_PROMOCIONAL');
      return Response.json({ item, lote: await recalcularLote(loteId) });
    }

    if (acao === 'tentar-novamente') {
      await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&status=in.(FALHA,REVISAO)`, { method: 'PATCH', body: JSON.stringify({ status: 'PENDENTE', etapa: 'NOVA_TENTATIVA', motivo: null, concluido_em: null, updated_at: new Date().toISOString() }) });
      await supabaseRest(`bling_imagens_lote_itens?lote_id=eq.${encodeURIComponent(loteId)}&preco_status=eq.REVISAO`, { method: 'PATCH', body: JSON.stringify({ preco_status: 'PENDENTE', preco_motivo: null, preco_concluido_em: null, updated_at: new Date().toISOString() }) });
      await supabaseRest(`bling_imagens_lotes?id=eq.${encodeURIComponent(loteId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'PAUSADO', concluido_em: null, updated_at: new Date().toISOString() }) });
      return Response.json({ lote: await recalcularLote(loteId) });
    }

    return Response.json({ erro: 'Ação desconhecida.' }, { status: 400 });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao administrar o lote.' }, { status: 400 });
  }
}
