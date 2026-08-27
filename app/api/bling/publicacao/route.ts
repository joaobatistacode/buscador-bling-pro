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

async function mapeamentoExatoDaCategoria(idLoja: number, idCategoriaProduto: number, token: string) {
  const encontrados = await listarTudo(`/categorias/lojas?idLoja=${idLoja}&idCategoriaProduto=${idCategoriaProduto}`, token, 5);
  const exatos = encontrados.filter(item =>
    Number((item.loja as Objeto | undefined)?.id || 0) === idLoja
    && Number((item.categoriaProduto as Objeto | undefined)?.id || 0) === idCategoriaProduto
  );
  if (exatos.length === 0) throw new Error(`A subcategoria ${idCategoriaProduto} não possui vínculo exato com esta loja.`);
  if (exatos.length > 1) throw new Error(`A subcategoria ${idCategoriaProduto} possui mais de um vínculo com esta loja. Corrija a duplicidade no Bling antes de continuar.`);
  return { registro: exatos[0], id: inteiro(exatos[0].id, 'Vínculo categoria–loja') };
}

async function conferirCategoriaNoVinculo(
  idProduto: number,
  idLoja: number,
  idCategoria: number,
  token: string,
  idVinculo?: number,
  esperas = [0]
) {
  let ultimoVinculo: Objeto | undefined;
  for (const espera of esperas) {
    if (espera > 0) await pausa(espera);
    if (idVinculo) {
      try {
        const detalhe = (await chamarBling(`/produtos/lojas/${idVinculo}`, token))?.data as Objeto | undefined;
        if (detalhe) ultimoVinculo = detalhe;
      } catch (erro) {
        if (Number((erro as { status?: number })?.status) !== 404) throw erro;
      }
      if (ultimoVinculo && idsCategoriasDoVinculo(ultimoVinculo).includes(idCategoria)) {
        return { confirmado: ultimoVinculo, ultimoVinculo };
      }
      continue;
    }
    const vinculos = await listarTudo(`/produtos/lojas?idProduto=${idProduto}&idLoja=${idLoja}`, token, 5);
    ultimoVinculo = vinculos[0];
    const confirmado = vinculos.find(vinculo => idsCategoriasDoVinculo(vinculo).includes(idCategoria));
    if (confirmado) return { confirmado, ultimoVinculo: confirmado };
  }
  return { confirmado: undefined, ultimoVinculo };
}

function corpoVinculo(atual: Objeto, idCategoriaLoja: number) {
  const categorias = [...new Set([...idsCategoriasDoVinculo(atual), idCategoriaLoja])].map(id => ({ id }));
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
      const mapeamentosPorCategoria = new Map<number, number>();
      for (const item of mapeamentos) {
        const idCategoria = Number((item.categoriaProduto as Objeto | undefined)?.id || 0);
        const idMapeamento = Number(item.id || 0);
        if (idCategoria > 0 && idMapeamento > 0) mapeamentosPorCategoria.set(idCategoria, idMapeamento);
      }
      const vinculosPorProduto = new Map(vinculos.map(item => [Number((item.produto as Objeto | undefined)?.id || 0), item]));
      const nomesCategorias = new Map(categorias.map(item => [item.id, item.descricao]));

      const itens = produtos.map((produto, indice) => {
        const idCategoria = Number(produto.categoria?.id || 0);
        const idMapeamento = Number(mapeamentosPorCategoria.get(idCategoria) || 0);
        const vinculo = vinculosPorProduto.get(produto.id);
        const categoriasVinculadas = vinculo ? idsCategoriasDoVinculo(vinculo) : [];
        const semCategoria = !idCategoria;
        const semMapeamento = idCategoria > 0 && !idMapeamento;
        const correto = Boolean(vinculo && categoriasVinculadas.includes(idMapeamento));
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

    if (acao === 'diagnosticar-categorias') {
      const id = textoSeguro(pedido.id, 80);
      const registro = await execucao(id);
      const segmento = String(registro.segmento || '');
      if (String(pedido.confirmacao || '').trim() !== segmento) throw new Error(`Digite exatamente ${segmento} para diagnosticar.`);
      const token = await tokenDaSessao();
      const idLoja = inteiro(registro.id_loja_bling, 'Loja');
      const revisoes = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=eq.REVISAO&select=id,id_produto_bling,codigo,produto,id_categoria_produto,id_vinculo_loja,acao,categoria&order=posicao.asc&limit=20`, { method: 'GET' }) as (ItemFila & { categoria?: string | null })[];
      const mapeamentosPorCategoria = new Map<number, Objeto | undefined>();
      const diagnosticos = [];

      for (const item of revisoes) {
        const idProduto = inteiro(item.id_produto_bling, 'Produto');
        const idCategoriaInterna = inteiro(item.id_categoria_produto, 'Categoria');
        let mapeamento = mapeamentosPorCategoria.get(idCategoriaInterna);
        if (!mapeamentosPorCategoria.has(idCategoriaInterna)) {
          const encontrados = await listarTudo(`/categorias/lojas?idLoja=${idLoja}&idCategoriaProduto=${idCategoriaInterna}`, token, 5);
          mapeamento = encontrados.find(candidato => Number((candidato.categoriaProduto as Objeto | undefined)?.id || 0) === idCategoriaInterna);
          mapeamentosPorCategoria.set(idCategoriaInterna, mapeamento);
        }

        let vinculo: Objeto | undefined;
        const idVinculoSalvo = Number(item.id_vinculo_loja || 0);
        if (idVinculoSalvo > 0) {
          try {
            vinculo = (await chamarBling(`/produtos/lojas/${idVinculoSalvo}`, token))?.data as Objeto | undefined;
          } catch (erro) {
            if (Number((erro as { status?: number })?.status) !== 404) throw erro;
          }
        }
        if (!vinculo) {
          const encontrados = await listarTudo(`/produtos/lojas?idProduto=${idProduto}&idLoja=${idLoja}`, token, 5);
          vinculo = encontrados[0];
        }

        const idMapeamento = Number(mapeamento?.id || 0) || null;
        const idCategoriaNoMapeamento = Number((mapeamento?.categoriaProduto as Objeto | undefined)?.id || 0) || null;
        const idsNoVinculo = vinculo ? idsCategoriasDoVinculo(vinculo) : [];
        const usaIdInterno = idsNoVinculo.includes(idCategoriaInterna);
        const usaIdMapeamento = Boolean(idMapeamento && idsNoVinculo.includes(idMapeamento));
        const situacao = !vinculo
          ? 'SEM_VINCULO'
          : idsNoVinculo.length === 0
            ? 'SEM_CATEGORIA'
            : usaIdInterno
              ? 'USA_ID_INTERNO'
              : usaIdMapeamento
                ? 'USA_ID_VINCULO_LOJA'
                : 'OUTRO_ID';

        diagnosticos.push({
          idProduto,
          codigo: item.codigo,
          produto: item.produto,
          categoria: item.categoria || null,
          idCategoriaInterna,
          idMapeamento,
          idCategoriaNoMapeamento,
          idVinculo: Number(vinculo?.id || 0) || null,
          idsNoVinculo,
          situacao,
        });
      }

      return Response.json({ somenteLeitura: true, limite: 20, total: diagnosticos.length, diagnosticos });
    }

    if (acao === 'testar-categoria-loja') {
      const id = textoSeguro(pedido.id, 80);
      const registro = await execucao(id);
      const segmento = String(registro.segmento || '');
      if (String(pedido.confirmacao || '').trim() !== segmento) throw new Error(`Digite exatamente ${segmento} para testar.`);
      const token = await tokenDaSessao();
      const idLoja = inteiro(registro.id_loja_bling, 'Loja');
      const revisoes = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=eq.REVISAO&select=id,id_produto_bling,codigo,produto,id_categoria_produto,id_vinculo_loja,acao&order=posicao.asc&limit=1`, { method: 'GET' }) as ItemFila[];
      const item = revisoes[0];
      if (!item) throw new Error('Nenhum item em revisão está disponível para o teste controlado.');

      const idProduto = inteiro(item.id_produto_bling, 'Produto');
      const idCategoria = inteiro(item.id_categoria_produto, 'Categoria');
      const mapeamento = await mapeamentoExatoDaCategoria(idLoja, idCategoria, token);
      const atuais = await listarTudo(`/produtos/lojas?idProduto=${idProduto}&idLoja=${idLoja}`, token, 5);
      const atual = atuais[0];
      const reivindicado = await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}&status=eq.REVISAO`, {
        method: 'PATCH', body: JSON.stringify({ status: 'PROCESSANDO', updated_at: new Date().toISOString() }),
      });
      if (!Array.isArray(reivindicado) || reivindicado.length !== 1) throw new Error('Este item já está sendo testado ou deixou a revisão. Recarregue a execução.');
      let auditoria = '';
      let requisicaoEnviada = false;

      try {
        const [registroAuditoria] = await supabaseRest('bling_catalogo_operacoes', {
          method: 'POST', body: JSON.stringify({
            tipo: 'VINCULAR_LOJA', status: 'PENDENTE', id_produto_bling: idProduto, codigo: item.codigo,
            antes: atual || null,
            solicitado: {
              testeControlado: true,
              loja: { id: idLoja },
              categoriaProduto: { id: idCategoria },
              categoriasProdutos: [{ id: mapeamento.id }],
            },
          }),
        });
        if (!registroAuditoria?.id) throw new Error('A auditoria não pôde ser aberta. Nenhum vínculo foi alterado.');
        auditoria = String(registroAuditoria.id);

        let idVinculoAlterado = Number(atual?.id || 0);
        if (!idsCategoriasDoVinculo(atual || {}).includes(mapeamento.id)) {
          await pausa(380);
          requisicaoEnviada = true;
          if (!atual) {
            const criado = await chamarBling('/produtos/lojas', token, {
              method: 'POST',
              body: JSON.stringify({ codigo: item.codigo, produto: { id: idProduto }, loja: { id: idLoja }, categoriasProdutos: [{ id: mapeamento.id }] }),
            });
            idVinculoAlterado = Number(criado?.data?.id || 0);
            if (!idVinculoAlterado) throw new Error('O Bling aceitou a criação, mas não devolveu o ID do vínculo para conferência.');
          } else {
            const idVinculo = inteiro(atual.id, 'Vínculo produto–loja');
            idVinculoAlterado = idVinculo;
            const detalhe = (await chamarBling(`/produtos/lojas/${idVinculo}`, token))?.data as Objeto;
            await pausa(380);
            await chamarBling(`/produtos/lojas/${idVinculo}`, token, { method: 'PUT', body: JSON.stringify(corpoVinculo(detalhe, mapeamento.id)) });
          }
        }

        const { confirmado } = await conferirCategoriaNoVinculo(idProduto, idLoja, mapeamento.id, token, idVinculoAlterado || undefined, [0, 2_000, 5_000]);
        if (!confirmado) throw new Error(`O teste foi enviado, mas o Bling não devolveu o vínculo categoria–loja ${mapeamento.id}. O segmento continua bloqueado.`);
        await atualizarAuditoria(auditoria, 'SUCESSO', `Teste unitário confirmou o vínculo categoria–loja ${mapeamento.id}.`);
        await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'CONCLUIDO', id_vinculo_loja: confirmado.id, motivo: `Teste unitário confirmou o vínculo categoria–loja ${mapeamento.id}.`, updated_at: new Date().toISOString() }),
        });
        const restantes = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=in.(FALHA,REVISAO)&select=id&limit=5000`, { method: 'GET' });
        const falhasRestantes = Array.isArray(restantes) ? restantes.length : Math.max(0, Number(registro.falhas || 0) - 1);
        await supabaseRest(`bling_publicacao_segmentos?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'PAUSADO',
            concluidos: Number(registro.concluidos || 0) + 1,
            falhas: falhasRestantes,
            updated_at: new Date().toISOString(),
          }),
        });
        return Response.json({ confirmado: true, somenteUmProduto: true, codigo: item.codigo, idProduto, idCategoriaProduto: idCategoria, idCategoriaLoja: mapeamento.id, falhasRestantes });
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : 'O teste controlado não pôde ser confirmado.';
        if (auditoria) await atualizarAuditoria(auditoria, requisicaoEnviada ? 'REVISAO' : 'FALHA', mensagem).catch(() => null);
        await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'REVISAO', motivo: mensagem.slice(0, 1000), updated_at: new Date().toISOString() }),
        }).catch(() => null);
        throw erro;
      }
    }

    if (acao === 'reconciliar') {
      const id = textoSeguro(pedido.id, 80);
      const registro = await execucao(id);
      const segmento = String(registro.segmento || '');
      if (String(pedido.confirmacao || '').trim() !== segmento) throw new Error(`Digite exatamente ${segmento} para conferir.`);
      const token = await tokenDaSessao();
      const idLoja = inteiro(registro.id_loja_bling, 'Loja');
      const revisoes = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=eq.REVISAO&select=id,id_produto_bling,codigo,produto,id_categoria_produto,id_vinculo_loja,acao&order=posicao.asc&limit=50`, { method: 'GET' }) as ItemFila[];
      const idsMapeamento = new Map<number, number>();
      let confirmados = 0;
      let naoConfirmados = 0;
      let interrompido = '';

      for (const item of revisoes) {
        try {
          const idProduto = inteiro(item.id_produto_bling, 'Produto');
          const idCategoria = inteiro(item.id_categoria_produto, 'Categoria');
          let idMapeamento = idsMapeamento.get(idCategoria);
          if (!idMapeamento) {
            idMapeamento = (await mapeamentoExatoDaCategoria(idLoja, idCategoria, token)).id;
            idsMapeamento.set(idCategoria, idMapeamento);
          }
          const conferencia = await conferirCategoriaNoVinculo(idProduto, idLoja, idMapeamento, token, undefined, [0]);
          if (!conferencia.confirmado) {
            const motivo = conferencia.ultimoVinculo
              ? 'O vínculo existe, mas continua sem a categoria esperada. Nenhuma gravação foi enviada na reconciliação.'
              : 'Nenhum vínculo foi localizado. Nenhuma gravação foi enviada na reconciliação.';
            await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
              method: 'PATCH', body: JSON.stringify({ motivo, updated_at: new Date().toISOString() }),
            });
            naoConfirmados += 1;
            continue;
          }
          await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'CONCLUIDO', id_vinculo_loja: conferencia.confirmado.id, motivo: 'Vínculo confirmado posteriormente por consulta somente leitura.', updated_at: new Date().toISOString() }),
          });
          const auditorias = await supabaseRest(`bling_catalogo_operacoes?tipo=eq.VINCULAR_LOJA&id_produto_bling=eq.${idProduto}&status=eq.REVISAO&select=id&order=created_at.desc&limit=1`, { method: 'GET' });
          if (Array.isArray(auditorias) && auditorias[0]?.id) {
            await atualizarAuditoria(String(auditorias[0].id), 'SUCESSO', 'Vínculo confirmado posteriormente por consulta somente leitura.');
          }
          confirmados += 1;
        } catch (erro) {
          interrompido = erro instanceof Error ? erro.message : 'A conferência somente leitura foi interrompida.';
          break;
        }
      }

      const restantes = await supabaseRest(`bling_publicacao_segmento_itens?execucao_id=eq.${encodeURIComponent(id)}&status=in.(FALHA,REVISAO)&select=id&limit=5000`, { method: 'GET' });
      const falhasRestantes = Array.isArray(restantes) ? restantes.length : Number(registro.falhas || 0);
      await supabaseRest(`bling_publicacao_segmentos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'PAUSADO',
          concluidos: Number(registro.concluidos || 0) + confirmados,
          falhas: falhasRestantes,
          updated_at: new Date().toISOString(),
        }),
      });
      return Response.json({ somenteLeituraBling: true, analisados: confirmados + naoConfirmados, confirmados, naoConfirmados, restantes: falhasRestantes, interrompido });
    }

    if (acao === 'aplicar-lote') {
      const id = textoSeguro(pedido.id, 80);
      const registro = await execucao(id);
      const segmento = String(registro.segmento || '');
      if (String(pedido.confirmacao || '').trim() !== segmento) throw new Error(`Digite exatamente ${segmento} para iniciar.`);
      if (registro.status === 'FINALIZADO' || registro.status === 'CANCELADO') throw new Error('Esta execução já foi encerrada.');
      if (Number(registro.falhas || 0) > 0) throw new Error('Existem itens em revisão. Faça a conferência somente leitura antes de retomar.');
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
      const idsMapeamento = new Map<number, number>();

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
          let idMapeamento = idsMapeamento.get(idCategoria);
          if (!idMapeamento) {
            idMapeamento = (await mapeamentoExatoDaCategoria(idLoja, idCategoria, token)).id;
            idsMapeamento.set(idCategoria, idMapeamento);
          }
          const atuais = await listarTudo(`/produtos/lojas?idProduto=${idProduto}&idLoja=${idLoja}`, token, 5);
          const atual = atuais[0];
          if (atual && idsCategoriasDoVinculo(atual).includes(idMapeamento)) {
            await supabaseRest(`bling_publicacao_segmento_itens?id=eq.${encodeURIComponent(item.id)}`, {
              method: 'PATCH', body: JSON.stringify({ status: 'CORRETO', acao: 'IGNORAR', id_vinculo_loja: atual.id, motivo: 'O vínculo já estava correto na conferência final.', updated_at: new Date().toISOString() }),
            });
            corretos += 1;
            continue;
          }
          const [registroAuditoria] = await supabaseRest('bling_catalogo_operacoes', {
            method: 'POST', body: JSON.stringify({
              tipo: 'VINCULAR_LOJA', status: 'PENDENTE', id_produto_bling: idProduto, codigo: item.codigo,
              antes: atual || null,
              solicitado: { loja: { id: idLoja }, categoriaProduto: { id: idCategoria }, categoriasProdutos: [{ id: idMapeamento }] },
            }),
          });
          if (!registroAuditoria?.id) throw new Error('A auditoria não pôde ser aberta. Nenhum vínculo foi alterado.');
          auditoria = String(registroAuditoria.id);
          await pausa(380);
          requisicaoEnviada = true;
          let idVinculoAlterado = Number(atual?.id || 0);
          if (!atual) {
            const criado = await chamarBling('/produtos/lojas', token, {
              method: 'POST',
              body: JSON.stringify({ codigo: item.codigo, produto: { id: idProduto }, loja: { id: idLoja }, categoriasProdutos: [{ id: idMapeamento }] }),
            });
            idVinculoAlterado = Number(criado?.data?.id || 0);
            if (!idVinculoAlterado) throw new Error('O Bling aceitou a criação, mas não devolveu o ID do vínculo para conferência.');
          } else {
            const idVinculo = inteiro(atual.id, 'Vínculo produto–loja');
            idVinculoAlterado = idVinculo;
            const detalhe = (await chamarBling(`/produtos/lojas/${idVinculo}`, token))?.data as Objeto;
            await pausa(380);
            await chamarBling(`/produtos/lojas/${idVinculo}`, token, { method: 'PUT', body: JSON.stringify(corpoVinculo(detalhe, idMapeamento)) });
          }
          const { confirmado: conferido } = await conferirCategoriaNoVinculo(idProduto, idLoja, idMapeamento, token, idVinculoAlterado, [0, 2_000, 5_000]);
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
          if (requisicaoEnviada || [401, 403, 429].includes(statusBling)) { interrompido = mensagem; break; }
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
