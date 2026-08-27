import { BLING_API, tokenValido } from '../sessao';
import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest, textoSeguro } from '@/lib/supabase-admin';

type Objeto = Record<string, unknown>;
type Categoria = { id: number; descricao: string; categoriaPai?: { id?: number } };
type Produto = { id: number; codigo: string; nome: string; categoria?: { id?: number } };
type ItemFila = {
  id: string;
  id_produto_bling: number;
  codigo: string;
  produto: string;
  id_categoria_produto: number;
  id_vinculo_loja?: number | null;
  acao: 'CRIAR' | 'ATUALIZAR';
};

const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const INTERVALO_BLING_MS = 750;
let proximaChamadaBling = 0;
let filaDoLimitador = Promise.resolve();

async function aguardarLimiteBling() {
  let liberar = () => {};
  const chamadaAnterior = filaDoLimitador;
  filaDoLimitador = new Promise<void>(resolve => { liberar = resolve; });
  await chamadaAnterior;
  const espera = Math.max(0, proximaChamadaBling - Date.now());
  if (espera > 0) await pausa(espera);
  proximaChamadaBling = Date.now() + INTERVALO_BLING_MS;
  liberar();
}

function esperaDoBling(cabecalho: string | null, tentativa: number) {
  const segundos = Number(cabecalho);
  const informado = Number.isFinite(segundos)
    ? segundos * 1_000
    : cabecalho ? Date.parse(cabecalho) - Date.now() : 0;
  const espera = informado > 0 ? informado : 5_000 * (tentativa + 1);
  return Math.min(30_000, Math.max(5_000, espera));
}

function inteiro(valor: unknown, nome: string) {
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero <= 0) throw new Error(`${nome} inválido.`);
  return numero;
}

async function tokenDaSessao() {
  const token = await tokenValido();
  if (!token) throw new Error('Não está conectado ao Bling.');
  return token;
}

async function chamarBling(caminho: string, token: string, init: RequestInit = {}) {
  const metodo = String(init.method || 'GET').toUpperCase();
  const maximoTentativas = metodo === 'GET' ? 3 : 1;
  for (let tentativa = 0; tentativa < maximoTentativas; tentativa++) {
    await aguardarLimiteBling();
    const resposta = await fetch(`${BLING_API}${caminho}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const corpo = await resposta.json().catch(() => null);
    if (resposta.ok) return corpo;
    if (resposta.status === 429 && metodo === 'GET' && tentativa + 1 < maximoTentativas) {
      const espera = esperaDoBling(resposta.headers.get('retry-after'), tentativa);
      console.warn('[bling/publicacao] limite temporário em leitura', { caminho, tentativa: tentativa + 1, espera });
      await pausa(espera);
      continue;
    }
    const erro = corpo?.error;
    const campos = Array.isArray(erro?.fields)
      ? erro.fields.map((campo: Objeto) => `${campo.element || campo.field || '?'}: ${campo.msg || campo.message || 'inválido'}`).join(' | ')
      : '';
    const falha = new Error([erro?.description || erro?.message || `HTTP ${resposta.status}`, campos].filter(Boolean).join(' — ')) as Error & { status?: number };
    falha.status = resposta.status;
    throw falha;
  }
  throw new Error('O limite de leitura do Bling permaneceu ativo após as tentativas seguras.');
}

async function listarTudo(caminho: string, token: string, maximoPaginas = 100) {
  const itens: Objeto[] = [];
  for (let pagina = 1; pagina <= maximoPaginas; pagina++) {
    if (pagina > 1) await pausa(380);
    const separador = caminho.includes('?') ? '&' : '?';
    const retorno = await chamarBling(`${caminho}${separador}pagina=${pagina}&limite=100`, token);
    const lote = Array.isArray(retorno?.data) ? retorno.data as Objeto[] : [];
    itens.push(...lote);
    if (lote.length < 100) return itens;
  }
  throw new Error('A consulta ultrapassou o limite seguro de 10.000 registros.');
}

function idsDaArvore(raiz: number, categorias: Categoria[]) {
  const ids = new Set<number>();
  const fila = [raiz];
  while (fila.length) {
    const atual = fila.shift();
    if (!atual || ids.has(atual)) continue;
    ids.add(atual);
    categorias.filter(item => Number(item.categoriaPai?.id || 0) === atual).forEach(item => fila.push(item.id));
  }
  return [...ids];
}

async function produtosDasCategorias(ids: number[], token: string) {
  const mapa = new Map<number, Produto>();
  for (const idCategoria of ids) {
    for (let pagina = 1; pagina <= 20; pagina++) {
      if (mapa.size || pagina > 1) await pausa(380);
      const parametros = new URLSearchParams({ pagina: String(pagina), limite: '100', criterio: '5', tipo: 'T', idCategoria: String(idCategoria) });
      const retorno = await chamarBling(`/produtos?${parametros}`, token);
      const lote = Array.isArray(retorno?.data) ? retorno.data : [];
      for (const produto of lote) {
        mapa.set(Number(produto.id), {
          id: Number(produto.id),
          codigo: String(produto.codigo || ''),
          nome: String(produto.nome || ''),
          categoria: produto.categoria && typeof produto.categoria === 'object' && Number(produto.categoria.id || 0) > 0
            ? produto.categoria
            : { id: idCategoria },
        });
      }
      if (lote.length < 100) break;
      if (mapa.size >= 5_000) throw new Error('O segmento ultrapassou o limite seguro de 5.000 produtos. Divida a execução.');
    }
  }
  return [...mapa.values()];
}

function idsCategoriasDoVinculo(vinculo: Objeto) {
  return (Array.isArray(vinculo.categoriasProdutos) ? vinculo.categoriasProdutos : [])
    .map(item => Number((item as Objeto)?.id || 0)).filter(Boolean);
}

function corpoVinculo(atual: Objeto, idCategoria: number) {
  const categorias = [...new Set([...idsCategoriasDoVinculo(atual), idCategoria])].map(id => ({ id }));
  const corpo: Objeto = {
    codigo: textoSeguro(atual.codigo, 120),
    produto: { id: inteiro((atual.produto as Objeto | undefined)?.id, 'Produto do vínculo') },
    loja: { id: inteiro((atual.loja as Objeto | undefined)?.id, 'Loja do vínculo') },
    categoriasProdutos: categorias,
  };
  for (const campo of ['preco', 'precoPromocional', 'fornecedorLoja', 'marcaLoja'] as const) {
    if (atual[campo] !== undefined && atual[campo] !== null) corpo[campo] = atual[campo];
  }
  if (!corpo.codigo) throw new Error('O vínculo atual não devolveu o código obrigatório do produto.');
  return corpo;
}

async function execucao(id: string) {
  const linhas = await supabaseRest(`bling_publicacao_segmentos?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { method: 'GET' });
  const registro = Array.isArray(linhas) ? linhas[0] as Objeto | undefined : undefined;
  if (!registro) throw new Error('Execução não encontrada.');
  return registro;
}

async function atualizarAuditoria(id: string, status: string, detalhe?: string) {
  await supabaseRest(`bling_catalogo_operacoes?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, detalhe: detalhe?.slice(0, 1000) || null, concluido_em: new Date().toISOString() }),
  });
}

function respostaErro(erro: unknown) {
  const statusBling = Number((erro as { status?: number })?.status);
  const status = statusBling === 429 ? 429 : statusBling === 401 || statusBling === 403 ? 403 : 400;
  return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha na publicação por segmento.' }, { status });
}

export async function GET(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    const url = new URL(request.url);
    const recurso = url.searchParams.get('recurso') || 'execucoes';
    if (recurso === 'execucoes') {
      const execucoes = await supabaseRest('bling_publicacao_segmentos?select=*&order=created_at.desc&limit=20', { method: 'GET' });
      return Response.json({ execucoes });
    }
    if (recurso === 'execucao') {
      const id = String(url.searchParams.get('id') || '');
      const registro = await execucao(id);
      const itens = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&select=*&order=posicao.asc&limit=5000`, { method: 'GET' });
      return Response.json({ execucao: registro, itens });
    }
    return Response.json({ erro: 'Consulta desconhecida.' }, { status: 400 });
  } catch (erro) {
    return respostaErro(erro);
  }
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const bruto = await lerCorpoLimitado(request, 64 * 1024);
    const pedido = JSON.parse(new TextDecoder().decode(bruto)) as Objeto;
    const acao = String(pedido.acao || '');

    if (acao === 'simular') {
      const token = await tokenDaSessao();
      const idSegmento = inteiro(pedido.idSegmento, 'Segmento');
      const idLoja = inteiro(pedido.idLoja, 'Loja');
      const categorias = await listarTudo('/categorias/produtos', token) as unknown as Categoria[];
      const segmento = categorias.find(item => item.id === idSegmento);
      if (!segmento) throw new Error('O segmento não foi encontrado no Bling.');
      const idsCategorias = idsDaArvore(idSegmento, categorias);
      await pausa(380);
      const produtos = await produtosDasCategorias(idsCategorias, token);
      await pausa(380);
      const mapeamentos = await listarTudo(`/categorias/lojas?idLoja=${idLoja}`, token);
      await pausa(380);
      const vinculos = await listarTudo(`/produtos/lojas?idLoja=${idLoja}`, token);
      const categoriasMapeadas = new Set(mapeamentos.map(item => Number((item.categoriaProduto as Objeto | undefined)?.id || 0)).filter(Boolean));
      const vinculosPorProduto = new Map(vinculos.map(item => [Number((item.produto as Objeto | undefined)?.id || 0), item]));
      const nomesCategorias = new Map(categorias.map(item => [item.id, item.descricao]));

      const itens = produtos.map((produto, indice) => {
        const idCategoria = Number(produto.categoria?.id || 0);
        const vinculo = vinculosPorProduto.get(produto.id);
        const categoriasVinculadas = vinculo ? idsCategoriasDoVinculo(vinculo) : [];
        const semCategoria = !idCategoria;
        const semMapeamento = idCategoria > 0 && !categoriasMapeadas.has(idCategoria);
        const correto = Boolean(vinculo && categoriasVinculadas.includes(idCategoria));
        const status = semCategoria || semMapeamento ? 'BLOQUEADO' : correto ? 'CORRETO' : 'PENDENTE';
        const acaoItem = status === 'BLOQUEADO' ? 'BLOQUEAR' : status === 'CORRETO' ? 'IGNORAR' : vinculo ? 'ATUALIZAR' : 'CRIAR';
        return {
          posicao: indice + 1,
          id_produto_bling: produto.id,
          codigo: textoSeguro(produto.codigo, 120) || `ID-${produto.id}`,
          produto: textoSeguro(produto.nome, 500) || `Produto ${produto.id}`,
          id_categoria_produto: idCategoria || null,
          categoria: nomesCategorias.get(idCategoria) || null,
          id_vinculo_loja: Number(vinculo?.id || 0) || null,
          acao: acaoItem,
          status,
          motivo: semCategoria ? 'Produto sem categoria interna.' : semMapeamento ? 'A categoria interna ainda não possui vínculo confirmado com esta loja.' : null,
        };
      });
      const resumo = {
        total: itens.length,
        pendentes: itens.filter(item => item.status === 'PENDENTE').length,
        corretos: itens.filter(item => item.status === 'CORRETO').length,
        bloqueados: itens.filter(item => item.status === 'BLOQUEADO').length,
      };
      const [registro] = await supabaseRest('bling_publicacao_segmentos', {
        method: 'POST',
        body: JSON.stringify({
          id_segmento_bling: idSegmento,
          segmento: segmento.descricao,
          id_loja_bling: idLoja,
          loja: textoSeguro(pedido.loja, 200) || `Loja ${idLoja}`,
          status: 'SIMULADO',
          ...resumo,
        }),
      });
      if (!registro?.id) throw new Error('Não foi possível salvar a simulação. Nenhum vínculo foi alterado.');
      for (let inicio = 0; inicio < itens.length; inicio += 300) {
        await supabaseRest('bling_publicacao_segmento_itens', {
          method: 'POST',
          body: JSON.stringify(itens.slice(inicio, inicio + 300).map(item => ({ ...item, execucao_id: registro.id }))),
        }, 20_000);
      }
      return Response.json({ execucao: registro, resumo, itens: itens.slice(0, 100), somenteLeitura: true });
    }

    if (acao === 'pausar') {
      const id = textoSeguro(pedido.id, 80);
      await supabaseRest(`bling_publicacao_segmentos?id=eq.${encodeURIComponent(id)}&status=in.(SIMULADO,EM_ANDAMENTO)`, {
        method: 'PATCH', body: JSON.stringify({ status: 'PAUSADO', updated_at: new Date().toISOString() }),
      });
      return Response.json({ pausado: true });
    }

    if (acao === 'aplicar-lote') {
      const id = textoSeguro(pedido.id, 80);
      const registro = await execucao(id);
      const segmento = String(registro.segmento || '');
      if (String(pedido.confirmacao || '').trim() !== segmento) throw new Error(`Digite exatamente ${segmento} para iniciar.`);
      if (registro.status === 'FINALIZADO' || registro.status === 'CANCELADO') throw new Error('Esta execução já foi encerrada.');
      const token = await tokenDaSessao();
      const idLoja = inteiro(registro.id_loja_bling, 'Loja');
      await supabaseRest(`bling_publicacao_segmentos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'EM_ANDAMENTO', updated_at: new Date().toISOString() }),
      });
      const fila = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=eq.PENDENTE&select=id,id_produto_bling,codigo,produto,id_categoria_produto,id_vinculo_loja,acao&order=posicao.asc&limit=10`, { method: 'GET' }) as ItemFila[];
      let concluidos = 0;
      let corretos = 0;
      let falhas = 0;
      let interrompido = '';

      for (const item of fila) {
        const reivindicado = await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}&status=eq.PENDENTE`, {
          method: 'PATCH', body: JSON.stringify({ status: 'PROCESSANDO', updated_at: new Date().toISOString() }),
        });
        if (!Array.isArray(reivindicado) || !reivindicado.length) continue;
        let auditoria = '';
        let requisicaoEnviada = false;
        try {
          const idProduto = inteiro(item.id_produto_bling, 'Produto');
          const idCategoria = inteiro(item.id_categoria_produto, 'Categoria');
          const atuais = await listarTudo(`/produtos/lojas?idProduto=${idProduto}&idLoja=${idLoja}`, token, 5);
          const atual = atuais[0];
          if (atual && idsCategoriasDoVinculo(atual).includes(idCategoria)) {
            await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
              method: 'PATCH', body: JSON.stringify({ status: 'CORRETO', acao: 'IGNORAR', id_vinculo_loja: atual.id, motivo: 'O vínculo já estava correto na conferência final.', updated_at: new Date().toISOString() }),
            });
            corretos += 1;
            continue;
          }
          const [registroAuditoria] = await supabaseRest('bling_catalogo_operacoes', {
            method: 'POST', body: JSON.stringify({
              tipo: 'VINCULAR_LOJA', status: 'PENDENTE', id_produto_bling: idProduto, codigo: item.codigo,
              antes: atual || null, solicitado: { loja: { id: idLoja }, categoriasProdutos: [{ id: idCategoria }] },
            }),
          });
          if (!registroAuditoria?.id) throw new Error('A auditoria não pôde ser aberta. Nenhum vínculo foi alterado.');
          auditoria = String(registroAuditoria.id);
          await pausa(380);
          requisicaoEnviada = true;
          if (!atual) {
            await chamarBling('/produtos/lojas', token, {
              method: 'POST',
              body: JSON.stringify({ codigo: item.codigo, produto: { id: idProduto }, loja: { id: idLoja }, categoriasProdutos: [{ id: idCategoria }] }),
            });
          } else {
            const idVinculo = inteiro(atual.id, 'Vínculo produto–loja');
            const detalhe = (await chamarBling(`/produtos/lojas/${idVinculo}`, token))?.data as Objeto;
            await pausa(380);
            await chamarBling(`/produtos/lojas/${idVinculo}`, token, { method: 'PUT', body: JSON.stringify(corpoVinculo(detalhe, idCategoria)) });
          }
          await pausa(380);
          const depois = await listarTudo(`/produtos/lojas?idProduto=${idProduto}&idLoja=${idLoja}`, token, 5);
          const conferido = depois.find(vinculo => idsCategoriasDoVinculo(vinculo).includes(idCategoria));
          if (!conferido) throw new Error('O Bling respondeu, mas a categoria não apareceu na conferência posterior.');
          await atualizarAuditoria(auditoria, 'SUCESSO');
          await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
            method: 'PATCH', body: JSON.stringify({ status: 'CONCLUIDO', id_vinculo_loja: conferido.id, motivo: null, updated_at: new Date().toISOString() }),
          });
          concluidos += 1;
        } catch (erro) {
          const statusBling = Number((erro as { status?: number })?.status);
          const mensagem = erro instanceof Error ? erro.message : 'Falha não identificada';
          const statusItem = requisicaoEnviada ? 'REVISAO' : 'FALHA';
          if (auditoria) await atualizarAuditoria(auditoria, statusItem, mensagem).catch(() => null);
          await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
            method: 'PATCH', body: JSON.stringify({ status: statusItem, motivo: mensagem.slice(0, 1000), updated_at: new Date().toISOString() }),
          }).catch(() => null);
          falhas += 1;
          if ([401, 403, 429].includes(statusBling)) { interrompido = mensagem; break; }
        }
      }

      const aindaAbertos = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=in.(PENDENTE,PROCESSANDO)&select=id,status&limit=1`, { method: 'GET' });
      const itensEmRevisao = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=in.(FALHA,REVISAO)&select=id&limit=1`, { method: 'GET' });
      const terminou = Array.isArray(aindaAbertos) && aindaAbertos.length === 0;
      if (!interrompido && fila.length === 0 && !terminou) interrompido = 'Há um item cuja execução foi interrompida. Aguarde dois minutos e retome o segmento.';
      const exigeRevisao = Array.isArray(itensEmRevisao) && itensEmRevisao.length > 0;
      const statusExecucao = interrompido ? 'PAUSADO' : terminou ? (exigeRevisao ? 'REVISAO' : 'FINALIZADO') : 'EM_ANDAMENTO';
      await supabaseRest(`bling_publicacao_segmentos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: statusExecucao,
          concluidos: Number(registro.concluidos || 0) + concluidos,
          corretos: Number(registro.corretos || 0) + corretos,
          falhas: Number(registro.falhas || 0) + falhas,
          pendentes: Math.max(0, Number(registro.pendentes || 0) - concluidos - corretos - falhas),
          updated_at: new Date().toISOString(),
          ...(terminou ? { concluido_em: new Date().toISOString() } : {}),
        }),
      });
      return Response.json({ processados: concluidos + corretos + falhas, concluidos, corretos, falhas, terminou, interrompido, status: statusExecucao });
    }

    return Response.json({ erro: 'Operação desconhecida.' }, { status: 400 });
  } catch (erro) {
    return respostaErro(erro);
  }
}
