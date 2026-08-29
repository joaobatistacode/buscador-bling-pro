import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BLING_API, tokenValido } from '../sessao';
import {
  lerCorpoLimitado,
  naoAutorizado,
  origemInvalida,
  origemPermitida,
  temAcesso,
} from '@/lib/acesso';
import { supabaseRest } from '@/lib/supabase-admin';

type Objeto = Record<string, unknown>;
type FalhaApi = Error & { status?: number; codigo?: string };

const CAMPOS_PUT_PRODUTO = [
  'nome', 'codigo', 'preco', 'tipo', 'situacao', 'formato', 'descricaoCurta',
  'dataValidade', 'unidade', 'pesoLiquido', 'pesoBruto', 'volumes',
  'itensPorCaixa', 'gtin', 'gtinEmbalagem', 'tipoProducao', 'condicao',
  'freteGratis', 'marca', 'descricaoComplementar', 'linkExterno', 'observacoes',
  'descricaoEmbalagemDiscreta', 'categoria', 'estoque', 'fornecedor',
  'dimensoes', 'tributacao', 'linhaProduto', 'camposCustomizados',
  'artigoPerigoso', 'duns',
] as const;

const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const INTERVALO_LEITURA_BLING_MS = 500;
let filaLeiturasBling = Promise.resolve();
let ultimaLeituraBling = 0;

function falhaApi(mensagem: string, codigo: string) {
  const falha = new Error(mensagem) as FalhaApi;
  falha.codigo = codigo;
  return falha;
}

async function aguardarJanelaDeLeitura(signal?: AbortSignal | null) {
  let liberar: () => void = () => {};
  const anterior = filaLeiturasBling;
  filaLeiturasBling = new Promise<void>(resolve => { liberar = () => resolve(); });
  await anterior;
  try {
    if (signal?.aborted) throw signal.reason || new DOMException('Consulta cancelada.', 'AbortError');
    const espera = Math.max(0, ultimaLeituraBling + INTERVALO_LEITURA_BLING_MS - Date.now());
    if (espera) await pausa(espera);
    if (signal?.aborted) throw signal.reason || new DOMException('Consulta cancelada.', 'AbortError');
    ultimaLeituraBling = Date.now();
  } finally {
    liberar();
  }
}

function esperaAposLimite(resposta: Response, tentativa: number) {
  const retryAfter = resposta.headers.get('retry-after');
  const segundos = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(segundos) && segundos >= 0) return Math.min(10_000, Math.max(1_000, segundos * 1_000));
  const data = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(data)) return Math.min(10_000, Math.max(1_000, data - Date.now()));
  return Math.min(8_000, 1_000 * (2 ** tentativa));
}

function inteiro(valor: unknown, nome: string) {
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero <= 0) throw new Error(`${nome} inválido.`);
  return numero;
}

function texto(valor: unknown, limite: number, nome: string) {
  const limpo = String(valor ?? '').replace(/[\u0000-\u001F]/g, '').trim();
  if (!limpo || limpo.length > limite) throw new Error(`${nome} inválido.`);
  return limpo;
}

function linksDoHistorico(valor: unknown): string[] {
  const encontrados: string[] = [];
  const visitar = (entrada: unknown, profundidade = 0) => {
    if (profundidade > 5) return;
    if (Array.isArray(entrada)) { entrada.forEach(visitar); return; }
    if (typeof entrada === 'string') {
      const textoEntrada = entrada.trim();
      if (!textoEntrada) return;
      try {
        const convertido: unknown = JSON.parse(textoEntrada);
        if (convertido !== entrada) { visitar(convertido); return; }
      } catch { /* URL legada armazenada diretamente. */ }
      if (/^https:\/\//i.test(textoEntrada)) encontrados.push(textoEntrada);
      return;
    }
    if (entrada && typeof entrada === 'object') {
      const objeto = entrada as Objeto;
      const camposPreferidos = ['url', 'link', 'imagem', 'imagemURL', 'urlOriginal', 'linkOriginal', 'urlImagem', 'linkMiniatura'];
      let encontrouCampo = false;
      for (const campo of camposPreferidos) {
        if (objeto[campo] !== undefined) { encontrouCampo = true; visitar(objeto[campo], profundidade + 1); }
      }
      if (!encontrouCampo) Object.values(objeto).forEach(item => visitar(item, profundidade + 1));
    }
  };
  visitar(valor);
  return [...new Set(encontrados)];
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (!valor || typeof valor !== 'object') return valor;
  return Object.fromEntries(
    Object.entries(valor as Objeto).sort(([a], [b]) => a.localeCompare(b)).map(([chave, item]) => [chave, ordenar(item)])
  );
}

const hash = (valor: unknown) => createHash('sha256').update(JSON.stringify(ordenar(valor))).digest('hex');

function segredoAssinatura() {
  const segredo = process.env.APP_SESSION_SECRET || '';
  if (segredo.length < 32) throw new Error('APP_SESSION_SECRET não está configurado com segurança.');
  return segredo;
}

function assinar(dados: Objeto) {
  const conteudo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const assinatura = createHmac('sha256', segredoAssinatura()).update(conteudo).digest('base64url');
  return `${conteudo}.${assinatura}`;
}

function conferirAssinatura(token: unknown): Objeto {
  const partes = String(token || '').split('.');
  if (partes.length !== 2) throw falhaApi('Simulação inválida. Simule novamente.', 'SIMULACAO_INVALIDA');
  const esperada = createHmac('sha256', segredoAssinatura()).update(partes[0]).digest();
  let recebida: Buffer;
  try { recebida = Buffer.from(partes[1], 'base64url'); } catch { throw falhaApi('Simulação inválida. Simule novamente.', 'SIMULACAO_INVALIDA'); }
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) {
    throw falhaApi('A simulação foi alterada ou não é válida. Simule novamente.', 'SIMULACAO_INVALIDA');
  }
  let dados: Objeto;
  try {
    dados = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8')) as Objeto;
  } catch {
    throw falhaApi('Simulação inválida. Simule novamente.', 'SIMULACAO_INVALIDA');
  }
  if (Number(dados.expiraEm) < Date.now()) throw falhaApi('A simulação expirou. Simule novamente.', 'SIMULACAO_EXPIRADA');
  return dados;
}

async function chamarBling(caminho: string, token: string, init: RequestInit = {}) {
  const metodo = String(init.method || 'GET').toUpperCase();
  const somenteLeitura = metodo === 'GET';
  const maximoTentativas = somenteLeitura ? 4 : 1;
  for (let tentativa = 0; tentativa < maximoTentativas; tentativa++) {
    if (somenteLeitura) await aguardarJanelaDeLeitura(init.signal);
    const timeout = AbortSignal.timeout(20_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const resposta = await fetch(`${BLING_API}${caminho}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      cache: 'no-store',
      signal,
    });
    const corpo = await resposta.json().catch(() => null);
    if (resposta.ok) return corpo;
    if (somenteLeitura && resposta.status === 429 && tentativa + 1 < maximoTentativas) {
      await pausa(esperaAposLimite(resposta, tentativa));
      continue;
    }
    const erro = corpo?.error;
    const campos = Array.isArray(erro?.fields)
      ? erro.fields.map((campo: Objeto) => `${campo.element || campo.field || '?'}: ${campo.msg || campo.message || 'inválido'}`).join(' | ')
      : '';
    const motivo = [erro?.description || erro?.message || `HTTP ${resposta.status}`, campos].filter(Boolean).join(' — ');
    const falha = new Error(motivo) as FalhaApi;
    falha.status = resposta.status;
    throw falha;
  }
  throw new Error('O limite de leituras do Bling permaneceu ativo após as tentativas seguras.');
}

async function listarTudo(caminho: string, token: string, maximoPaginas = 100) {
  const itens: unknown[] = [];
  for (let pagina = 1; pagina <= maximoPaginas; pagina++) {
    const separador = caminho.includes('?') ? '&' : '?';
    const retorno = await chamarBling(`${caminho}${separador}pagina=${pagina}&limite=100`, token);
    const lote = Array.isArray(retorno?.data) ? retorno.data : [];
    itens.push(...lote);
    if (lote.length < 100) return itens;
  }
  throw new Error('A listagem ultrapassou o limite seguro de 10.000 registros.');
}

async function tokenDaSessao() {
  const token = await tokenValido();
  if (!token) throw new Error('Não está conectado ao Bling.');
  return token;
}

async function consultaOpcional<T>(nome: string, consulta: () => Promise<T>) {
  try {
    return { dados: await consulta(), aviso: '' };
  } catch (erro) {
    return {
      dados: [] as T,
      aviso: `${nome}: ${erro instanceof Error ? erro.message : 'consulta indisponível'}`,
    };
  }
}

function idsPositivos(valor: string | null, limite = 200) {
  const ids = [...new Set(String(valor || '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (ids.length > limite) throw new Error(`Selecione no máximo ${limite} categorias por consulta.`);
  return ids;
}

async function listarProdutosDasCategorias(ids: number[], token: string, busca: string, signal?: AbortSignal) {
  const mapa = new Map<number, unknown>();
  let truncado = false;
  for (const idCategoria of ids) {
    for (let pagina = 1; pagina <= 5; pagina++) {
      if (mapa.size >= 2_000) { truncado = true; break; }
      const parametros = new URLSearchParams({
        pagina: String(pagina), limite: '100', criterio: '5', tipo: 'T', idCategoria: String(idCategoria),
      });
      if (busca) parametros.set('nome', busca);
      const retorno = await chamarBling(`/produtos?${parametros}`, token, { signal });
      const lote = Array.isArray(retorno?.data) ? retorno.data : [];
      for (const produto of lote) {
        const categoriaRetornada = produto?.categoria && typeof produto.categoria === 'object'
          ? produto.categoria
          : { id: idCategoria };
        mapa.set(Number(produto.id), { ...produto, categoria: categoriaRetornada });
      }
      if (lote.length < 100) break;
      if (pagina === 5) truncado = true;
    }
    if (mapa.size >= 2_000) break;
  }
  if (busca) {
    const porCodigo = await chamarBling(`/produtos?pagina=1&limite=5&criterio=5&codigos[]=${encodeURIComponent(busca)}`, token, { signal });
    const permitidas = new Set(ids);
    for (const produto of Array.isArray(porCodigo?.data) ? porCodigo.data : []) {
      if (permitidas.has(Number(produto?.categoria?.id || 0))) mapa.set(Number(produto.id), produto);
    }
  }
  return { produtos: [...mapa.values()], truncado };
}

function camposDoProduto(produto: Objeto) {
  return Array.isArray(produto.camposCustomizados) ? produto.camposCustomizados : [];
}

function normalizarCampo(valor: unknown) {
  const campo = valor && typeof valor === 'object' ? valor as Objeto : {};
  const idCampoCustomizado = inteiro(campo.idCampoCustomizado, 'Campo customizado');
  const normalizado: Objeto = { idCampoCustomizado };
  if (Number.isSafeInteger(Number(campo.idVinculo)) && Number(campo.idVinculo) > 0) normalizado.idVinculo = Number(campo.idVinculo);
  if (campo.valor !== undefined && campo.valor !== null) normalizado.valor = String(campo.valor).slice(0, 4000);
  if (campo.item !== undefined && campo.item !== null) normalizado.item = String(campo.item).slice(0, 4000);
  return normalizado;
}

function mesclarCampos(atuais: unknown[], alteracoes: unknown[]) {
  const mapa = new Map<number, Objeto>();
  for (const campo of atuais) {
    const normalizado = normalizarCampo(campo);
    mapa.set(Number(normalizado.idCampoCustomizado), normalizado);
  }
  for (const alteracao of alteracoes.slice(0, 100)) {
    const entrada = alteracao && typeof alteracao === 'object' ? alteracao as Objeto : {};
    const id = inteiro(entrada.idCampoCustomizado, 'Campo customizado');
    const atual = mapa.get(id) || { idCampoCustomizado: id };
    const valor = String(entrada.valor ?? '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 4000);
    const item = String(entrada.item ?? '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 4000);
    if (!valor && !item) throw new Error(`Informe um valor para o campo ${id}. A remoção não é liberada neste módulo.`);
    const usaItem = item || (atual.item !== undefined && atual.valor === undefined);
    const proximo = { ...atual };
    if (usaItem) {
      proximo.item = item || valor;
      delete proximo.valor;
    } else {
      proximo.valor = valor;
      delete proximo.item;
    }
    mapa.set(id, proximo);
  }
  return [...mapa.values()];
}

const camposProtegidos = [
  'nome', 'codigo', 'preco', 'tipo', 'situacao', 'formato', 'descricaoCurta',
  'descricaoComplementar', 'marca', 'pesoLiquido', 'pesoBruto', 'estoque',
  'dimensoes', 'midia', 'tributacao', 'linhaProduto', 'estrutura',
] as const;

function retratoProtegido(produto: Objeto) {
  return Object.fromEntries(camposProtegidos.map(campo => [campo, produto[campo]]));
}

function retratoEditavel(produto: Objeto) {
  return { categoria: produto.categoria ?? null, camposCustomizados: camposDoProduto(produto) };
}

function linksDasImagens(produto: Objeto) {
  const midia = produto.midia && typeof produto.midia === 'object' ? produto.midia as Objeto : {};
  const imagens = midia.imagens && typeof midia.imagens === 'object' ? midia.imagens as Objeto : {};
  const grupos = [imagens.internas, imagens.externas, imagens.imagensURL];
  const links: string[] = [];
  const chaves = new Set<string>();
  for (const grupo of grupos) {
    if (!Array.isArray(grupo)) continue;
    for (const item of grupo) {
      const registro = item && typeof item === 'object' ? item as Objeto : {};
      const link = String(registro.link || registro.url || registro.linkOriginal || registro.urlOriginal || registro.imagemURL || registro.urlImagem || registro.linkMiniatura || '').trim();
      const chave = linkEstavelDaImagem(link);
      if (/^https:\/\//i.test(link) && !chaves.has(chave)) {
        chaves.add(chave);
        links.push(link);
      }
    }
  }
  const imagemPrincipal = String(produto.imagemURL || '').trim();
  if (!links.length && /^https:\/\//i.test(imagemPrincipal)) links.push(imagemPrincipal);
  return links;
}

function validarNovasImagens(valor: unknown, quantidadeEsperada: number) {
  if (!Array.isArray(valor) || !valor.length || valor.length > 10) {
    throw new Error('A simulação deve conter entre 1 e 10 imagens.');
  }
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL não está configurada.');
  const hostPermitido = new URL(base).host;
  const urls = [...new Set(valor.map(item => String(item || '').trim()))];
  if (urls.length !== valor.length || urls.length !== quantidadeEsperada) {
    throw new Error(`A reposição deve conter exatamente ${quantidadeEsperada} imagem(ns), sem repetições.`);
  }
  for (const item of urls) {
    let url: URL;
    try { url = new URL(item); } catch { throw new Error('Uma das imagens novas possui endereço inválido.'); }
    if (url.protocol !== 'https:' || url.host !== hostPermitido) {
      throw new Error('As imagens novas precisam ser as cópias protegidas geradas pelo próprio sistema.');
    }
    if (!url.pathname.startsWith('/storage/v1/object/public/produtos-bling/') || !url.pathname.includes('-marketplace/')) {
      throw new Error('O caminho de uma imagem nova não pertence à área protegida de teste para marketplaces.');
    }
  }
  return urls;
}

function retratoSemMidia(produto: Objeto) {
  const copia = { ...produto };
  delete copia.midia;
  delete copia.imagemURL;
  delete copia.dataAlteracao;
  return copia;
}

function linkEstavelDaImagem(link: string) {
  try {
    const url = new URL(link);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return link;
  }
}

function retratoParaSimulacaoDeImagens(produto: Objeto) {
  return {
    produto: retratoSemMidia(produto),
    imagens: linksDasImagens(produto).map(linkEstavelDaImagem),
  };
}

function corpoPutParaImagens(produto: Objeto, linksNovos: string[]) {
  const formato = String(produto.formato || '').toUpperCase();
  if (formato !== 'S') {
    throw falhaApi(
      'A substituição automática de imagens está liberada somente para produto simples, sem variações ou composição.',
      'PRODUTO_NAO_SIMPLES',
    );
  }
  const corpo: Objeto = {};
  for (const campo of CAMPOS_PUT_PRODUTO) {
    if (produto[campo] !== undefined && produto[campo] !== null) corpo[campo] = produto[campo];
  }

  const categoria = produto.categoria && typeof produto.categoria === 'object' ? produto.categoria as Objeto : {};
  if (Number.isSafeInteger(Number(categoria.id)) && Number(categoria.id) > 0) corpo.categoria = { id: Number(categoria.id) };
  const linhaProduto = produto.linhaProduto && typeof produto.linhaProduto === 'object' ? produto.linhaProduto as Objeto : {};
  if (Number.isSafeInteger(Number(linhaProduto.id)) && Number(linhaProduto.id) > 0) corpo.linhaProduto = { id: Number(linhaProduto.id) };

  const midiaAtual = produto.midia && typeof produto.midia === 'object' ? produto.midia as Objeto : {};
  const midia: Objeto = { imagens: { imagensURL: linksNovos.map(link => ({ link })) } };
  if (midiaAtual.video && typeof midiaAtual.video === 'object') midia.video = midiaAtual.video;
  corpo.midia = midia;
  return corpo;
}

async function conferirSubstituicaoDeImagens(
  idProduto: number,
  token: string,
  antes: Objeto,
  quantidadeEsperada: number,
) {
  const linksAntes = linksDasImagens(antes);
  const assinaturaAntes = hash(linksAntes.map(linkEstavelDaImagem));
  let assinaturaAnterior = '';
  let leiturasEstaveis = 0;
  let depois: Objeto | undefined;
  let linksConfirmados: string[] = [];

  for (let tentativa = 0; tentativa < 8; tentativa++) {
    await pausa(tentativa === 0 ? 1_200 : 1_500);
    depois = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
    if (!depois) continue;
    if (hash(retratoSemMidia(antes)) !== hash(retratoSemMidia(depois))) {
      throw new Error('ALERTA: a conferência detectou mudança fora das imagens. Interrompa novas operações e revise o produto no Bling.');
    }

    linksConfirmados = linksDasImagens(depois);
    const assinaturaAtual = hash(linksConfirmados.map(linkEstavelDaImagem));
    const conjuntoFoiSubstituido = linksConfirmados.length !== linksAntes.length || assinaturaAtual !== assinaturaAntes;
    if (linksConfirmados.length === quantidadeEsperada && conjuntoFoiSubstituido && assinaturaAtual === assinaturaAnterior) {
      leiturasEstaveis += 1;
      if (leiturasEstaveis >= 1) return { depois, linksConfirmados };
    } else {
      leiturasEstaveis = 0;
    }
    assinaturaAnterior = assinaturaAtual;
  }

  if (!depois) throw new Error('O Bling não devolveu o produto após a alteração.');
  throw new Error(`O Bling respondeu, mas estabilizou com ${linksConfirmados.length} de ${quantidadeEsperada} imagens. A operação foi marcada para revisão.`);
}

function respostaErro(erro: unknown) {
  const statusBling = Number((erro as { status?: number })?.status);
  const status = statusBling === 429 ? 429 : statusBling === 401 || statusBling === 403 ? 401 : 400;
  const codigo = (erro as FalhaApi)?.codigo;
  return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha na administração do catálogo.', ...(codigo ? { codigo } : {}) }, { status });
}

async function iniciarAuditoria(dados: Objeto) {
  const [registro] = await supabaseRest('bling_catalogo_operacoes', {
    method: 'POST',
    body: JSON.stringify({ ...dados, status: 'PENDENTE' }),
  });
  if (!registro?.id) throw new Error('Não foi possível abrir a auditoria. Nenhuma alteração foi feita no Bling.');
  return String(registro.id);
}

async function concluirAuditoria(id: string, status: 'SUCESSO' | 'FALHA' | 'REVISAO', detalhe?: string) {
  await supabaseRest(`bling_catalogo_operacoes?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, detalhe: detalhe?.slice(0, 1000) || null, concluido_em: new Date().toISOString() }),
  });
}

export async function GET(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    const token = await tokenDaSessao();
    const url = new URL(request.url);
    const recurso = url.searchParams.get('recurso') || 'resumo';

    if (recurso === 'resumo') {
      const categorias = await listarTudo('/categorias/produtos', token);
      const canaisResultado = await consultaOpcional('Canais de venda', () => listarTudo('/canais-venda?situacao=1', token, 20));
      const modulosResultado = await consultaOpcional('Módulos de campos', async () => (await chamarBling('/campos-customizados/modulos', token))?.data || []);
      const tiposResultado = await consultaOpcional('Tipos de campos', async () => (await chamarBling('/campos-customizados/tipos', token))?.data || []);
      return Response.json({
        categorias,
        canais: canaisResultado.dados,
        modulos: modulosResultado.dados,
        tipos: tiposResultado.dados,
        avisos: [canaisResultado.aviso, modulosResultado.aviso, tiposResultado.aviso].filter(Boolean),
      });
    }

    if (recurso === 'produtos') {
      const categoria = url.searchParams.get('categoria');
      const categorias = idsPositivos(url.searchParams.get('categorias'));
      const busca = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (categorias.length) {
        const retorno = await listarProdutosDasCategorias(categorias, token, busca, request.signal);
        return Response.json(retorno);
      }
      const parametros = new URLSearchParams({ pagina: '1', limite: '50', criterio: '5', tipo: 'T' });
      if (categoria) parametros.set('idCategoria', String(inteiro(categoria, 'Categoria')));
      if (busca) parametros.set('nome', busca);
      const retorno = await chamarBling(`/produtos?${parametros}`, token);
      let produtos = Array.isArray(retorno?.data) ? retorno.data : [];
      if (busca) {
        const porCodigo = await chamarBling(`/produtos?pagina=1&limite=5&criterio=5&codigos[]=${encodeURIComponent(busca)}`, token);
        const mapa = new Map<number, unknown>();
        for (const produto of [...(porCodigo?.data || []), ...produtos]) mapa.set(Number(produto.id), produto);
        produtos = [...mapa.values()];
      }
      return Response.json({ produtos });
    }

    if (recurso === 'diagnostico') {
      const ids = idsPositivos(url.searchParams.get('ids'), 50);
      if (!ids.length) throw new Error('Selecione ao menos um produto para o diagnóstico.');

      const parametrosLote = new URLSearchParams({ pagina: '1', limite: '100', criterio: '5', tipo: 'T' });
      ids.forEach(id => parametrosLote.append('idsProdutos[]', String(id)));
      const produtosRetorno = await chamarBling(`/produtos?${parametrosLote}`, token);
      const produtos = new Map<number, Objeto>((Array.isArray(produtosRetorno?.data) ? produtosRetorno.data : []).map((item: Objeto) => [Number(item.id), item]));
      const parametrosSaldo = new URLSearchParams();
      ids.forEach(id => parametrosSaldo.append('idsProdutos[]', String(id)));
      const saldosRetorno = await chamarBling(`/estoques/saldos?${parametrosSaldo}`, token);
      const saldos = new Map<number, Objeto>((Array.isArray(saldosRetorno?.data) ? saldosRetorno.data : []).map((item: Objeto) => [Number((item.produto as Objeto | undefined)?.id), item]));
      const diagnosticos: Objeto[] = [];

      for (const id of ids) {
        const produto = produtos.get(id) || {};
        let vinculos: unknown[] = [];
        let canalConferido = true;
        try {
          vinculos = await listarTudo(`/produtos/lojas?idProduto=${id}`, token, 5);
        } catch {
          canalConferido = false;
        }
        const saldo = saldos.get(id);
        const saldoFisico = Number(saldo?.saldoFisicoTotal || 0);
        const saldoVirtual = Number(saldo?.saldoVirtualTotal || 0);
        const quantidadeImagens = String(produto.imagemURL || '').trim() ? 1 : 0;
        const semImagem = quantidadeImagens === 0;
        const semCanal = vinculos.length === 0;
        diagnosticos.push({
          id,
          saldoFisico,
          saldoVirtual,
          quantidadeImagens,
          quantidadeCanais: vinculos.length,
          canalConferido,
          canais: vinculos.map(item => Number(((item as Objeto).loja as Objeto | undefined)?.id || 0)).filter(Boolean),
          alerta: saldoFisico > 0 && semImagem && semCanal && canalConferido,
        });
      }
      return Response.json({ diagnosticos });
    }

    if (recurso === 'produto') {
      const id = inteiro(url.searchParams.get('id'), 'Produto');
      const produto = (await chamarBling(`/produtos/${id}`, token))?.data;
      return Response.json({ produto });
    }

    if (recurso === 'imagens-supabase') {
      const codigo = texto(url.searchParams.get('codigo'), 120, 'SKU');
      const [historico] = await supabaseRest(
        `bling_produtos?codigo=eq.${encodeURIComponent(codigo)}&select=*&limit=1`,
        { method: 'GET' },
      ) as Array<Objeto>;
      const imagens = linksDoHistorico([
        historico?.imagens,
        historico?.img1,
        historico?.img2,
        historico?.img3,
        historico?.img4,
      ]);
      if (!imagens.length) {
        throw falhaApi('Nenhuma imagem salva no Supabase foi encontrada para este SKU.', 'IMAGENS_SUPABASE_AUSENTES');
      }
      return Response.json({ produto: { codigo: historico.codigo, nome: historico.nome }, imagens });
    }

    if (recurso === 'campos') {
      const modulo = inteiro(url.searchParams.get('modulo'), 'Módulo');
      const campos = await listarTudo(`/campos-customizados/modulos/${modulo}`, token, 50);
      return Response.json({ campos });
    }

    if (recurso === 'categorias-marketplace') {
      const loja = inteiro(url.searchParams.get('loja'), 'Loja');
      const integracao = texto(url.searchParams.get('integracao'), 80, 'Integração');
      const pai = String(url.searchParams.get('pai') || '').trim().slice(0, 100);
      const parametros = new URLSearchParams({ idLoja: String(loja), tipoIntegracao: integracao });
      if (pai) parametros.set('idCategoria', pai);
      const categorias = (await chamarBling(`/anuncios/categorias?${parametros}`, token))?.data || [];
      return Response.json({ categorias });
    }

    if (recurso === 'atributos') {
      const loja = inteiro(url.searchParams.get('loja'), 'Loja');
      const integracao = texto(url.searchParams.get('integracao'), 80, 'Integração');
      const categoria = texto(url.searchParams.get('categoria'), 100, 'Categoria do marketplace');
      const parametros = new URLSearchParams({ idLoja: String(loja), tipoIntegracao: integracao });
      const dados = (await chamarBling(`/anuncios/categorias/${encodeURIComponent(categoria)}?${parametros}`, token))?.data;
      const atributos = Array.isArray(dados)
        ? dados
        : Array.isArray(dados?.atributos)
          ? dados.atributos
          : dados?.id ? [dados] : [];
      return Response.json({ atributos });
    }

    return Response.json({ erro: 'Consulta desconhecida.' }, { status: 400 });
  } catch (erro) {
    return respostaErro(erro);
  }
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  const contextoLog: {
    acao: string;
    etapa: string;
    idProduto?: number;
    codigo?: string;
    modo?: string;
  } = { acao: 'desconhecida', etapa: 'ler-pedido' };
  try {
    const bruto = await lerCorpoLimitado(request, 256 * 1024);
    const pedido = JSON.parse(new TextDecoder().decode(bruto)) as Objeto;
    const acao = String(pedido.acao || '');
    contextoLog.acao = acao || 'desconhecida';
    contextoLog.etapa = 'obter-token-bling';
    const token = await tokenDaSessao();

    if (acao === 'simular-imagens') {
      const idProduto = inteiro(pedido.idProduto, 'Produto');
      contextoLog.idProduto = idProduto;
      contextoLog.etapa = 'consultar-produto-para-simulacao';
      const atual = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
      if (!atual) throw new Error('O Bling não devolveu o produto.');
      const linksAtuais = linksDasImagens(atual);
      const reposicaoSegura = pedido.modo === 'remover-reaplicar';
      contextoLog.modo = reposicaoSegura ? 'remover-reaplicar' : 'bloqueado';
      if (!reposicaoSegura) {
        throw falhaApi(
          'O fluxo antigo de substituição foi bloqueado. Prepare a reposição segura com remoção confirmada antes da aplicação.',
          'FLUXO_IMAGENS_ANTIGO_BLOQUEADO',
        );
      }
      const quantidadeNova = Array.isArray(pedido.urls) ? pedido.urls.length : 0;
      const linksNovos = validarNovasImagens(pedido.urls, quantidadeNova);
      const codigo = texto(atual.codigo, 120, 'SKU do produto');
      contextoLog.codigo = codigo;
      contextoLog.etapa = 'assinar-simulacao-imagens';
      const produtoSemImagens = linksAtuais.length === 0;
      const planoImagens = { midia: { imagens: { imagensURL: linksNovos.map(link => ({ link })) } } };
      const plano = {
        versao: 1,
        tipo: produtoSemImagens ? 'reposicao-imagens' : 'preparar-reposicao-imagens',
        modo: produtoSemImagens ? 'apos-remocao-confirmada' : 'remover-reaplicar',
        idProduto,
        codigo,
        linksAtuais,
        linksNovos,
        quantidadeAntes: linksAtuais.length,
        quantidadeDepois: linksNovos.length,
        hashAtual: hash(retratoParaSimulacaoDeImagens(atual)),
        expiraEm: Date.now() + 10 * 60 * 1000,
      };
      const simulacao = assinar(plano);
      return Response.json({
        simulacao,
        simulacaoAplicacao: produtoSemImagens ? simulacao : undefined,
        produtoSemImagens,
        expiraEm: plano.expiraEm,
        modo: plano.modo,
        produto: { id: idProduto, codigo, nome: atual.nome },
        antes: { imagens: linksAtuais },
        depois: { imagens: linksNovos },
        corpoPatch: planoImagens,
      });
    }

    if (acao === 'remover-imagens') {
      contextoLog.etapa = 'validar-simulacao-remocao';
      const plano = conferirAssinatura(pedido.simulacao);
      if (plano.tipo !== 'preparar-reposicao-imagens' || plano.modo !== 'remover-reaplicar') {
        throw falhaApi('Esta simulação não pertence ao fluxo seguro de reposição de imagens.', 'SIMULACAO_INVALIDA');
      }
      const codigo = texto(plano.codigo, 120, 'SKU');
      contextoLog.codigo = codigo;
      contextoLog.modo = 'remover-reaplicar';
      if (String(pedido.confirmacao || '').trim() !== codigo) throw new Error(`Digite exatamente o SKU ${codigo} para confirmar.`);
      const idProduto = inteiro(plano.idProduto, 'Produto');
      contextoLog.idProduto = idProduto;
      contextoLog.etapa = 'reler-produto-antes-da-remocao';
      const antes = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
      if (!antes || hash(retratoParaSimulacaoDeImagens(antes)) !== plano.hashAtual) {
        throw falhaApi('O produto mudou depois da simulação. Nenhuma alteração foi feita; simule novamente.', 'SIMULACAO_DESATUALIZADA');
      }
      const linksAtuais = linksDasImagens(antes);
      const quantidadeAntes = inteiro(plano.quantidadeAntes, 'Quantidade atual de imagens');
      if (linksAtuais.length !== quantidadeAntes) {
        throw falhaApi('A quantidade de imagens mudou depois da simulação. Nenhuma alteração foi feita; simule novamente.', 'SIMULACAO_DESATUALIZADA');
      }
      const quantidadeDepois = inteiro(plano.quantidadeDepois, 'Quantidade final de imagens');
      const linksNovos = validarNovasImagens(plano.linksNovos, quantidadeDepois);
      contextoLog.etapa = 'montar-corpo-remocao';
      const corpoSemImagens = corpoPutParaImagens(antes, []);
      contextoLog.etapa = 'abrir-auditoria-remocao';
      const auditoria = await iniciarAuditoria({
        tipo: 'ALTERAR_IMAGENS_MARKETPLACE',
        id_produto_bling: idProduto,
        codigo,
        antes: { imagens: linksAtuais },
        solicitado: { etapa: 'REMOVER', imagens: [] },
      });
      let requisicaoEnviada = false;
      try {
        await pausa(500);
        contextoLog.etapa = 'enviar-put-sem-imagens';
        requisicaoEnviada = true;
        await chamarBling(`/produtos/${idProduto}`, token, { method: 'PUT', body: JSON.stringify(corpoSemImagens) });
        contextoLog.etapa = 'confirmar-produto-sem-imagens';
        const { depois, linksConfirmados } = await conferirSubstituicaoDeImagens(idProduto, token, antes, 0);
        if (linksConfirmados.length !== 0) throw new Error('O Bling não confirmou a remoção total das imagens.');
        const expiraEm = Date.now() + 10 * 60 * 1000;
        const planoAplicacao = {
          versao: 1,
          tipo: 'reposicao-imagens',
          modo: 'apos-remocao-confirmada',
          idProduto,
          codigo,
          linksNovos,
          quantidadeAntes: 0,
          quantidadeDepois,
          hashAtual: hash(retratoParaSimulacaoDeImagens(depois)),
          expiraEm,
        };
        contextoLog.etapa = 'concluir-auditoria-remocao';
        await concluirAuditoria(auditoria, 'SUCESSO');
        return Response.json({
          removido: true,
          quantidadeConfirmada: 0,
          simulacaoAplicacao: assinar(planoAplicacao),
          expiraEm,
        });
      } catch (erro) {
        await concluirAuditoria(auditoria, requisicaoEnviada ? 'REVISAO' : 'FALHA', erro instanceof Error ? erro.message : 'Falha não identificada').catch(() => null);
        throw erro;
      }
    }

    if (acao === 'aplicar-imagens') {
      contextoLog.etapa = 'validar-simulacao-imagens';
      const plano = conferirAssinatura(pedido.simulacao);
      if (plano.tipo !== 'reposicao-imagens' || plano.modo !== 'apos-remocao-confirmada') {
        throw falhaApi(
          'A aplicação permanece bloqueada até o Bling confirmar que o produto está sem imagens.',
          'ALTERACAO_IMAGENS_BLOQUEADA',
        );
      }
      const codigo = texto(plano.codigo, 120, 'SKU');
      contextoLog.codigo = codigo;
      contextoLog.modo = String(plano.modo || 'substituir');
      if (String(pedido.confirmacao || '').trim() !== codigo) throw new Error(`Digite exatamente o SKU ${codigo} para confirmar.`);
      const idProduto = inteiro(plano.idProduto, 'Produto');
      contextoLog.idProduto = idProduto;
      contextoLog.etapa = 'reler-produto-antes-do-put';
      const antes = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
      if (!antes || hash(retratoParaSimulacaoDeImagens(antes)) !== plano.hashAtual) {
        throw falhaApi('O produto mudou depois da simulação. Nenhuma alteração foi feita; simule novamente.', 'SIMULACAO_DESATUALIZADA');
      }
      const linksAtuais = linksDasImagens(antes);
      const quantidadeAntes = Number(plano.quantidadeAntes);
      if (quantidadeAntes !== 0) throw falhaApi('A reposição segura exige produto sem imagens.', 'SIMULACAO_INVALIDA');
      const quantidadeDepois = inteiro(plano.quantidadeDepois, 'Quantidade final de imagens');
      if (linksAtuais.length !== quantidadeAntes) {
        throw falhaApi('A quantidade de imagens mudou depois da simulação. Nenhuma alteração foi feita; simule novamente.', 'SIMULACAO_DESATUALIZADA');
      }
      const linksNovos = validarNovasImagens(plano.linksNovos, quantidadeDepois);
      const planoImagens = { midia: { imagens: { imagensURL: linksNovos.map(link => ({ link })) } } };
      contextoLog.etapa = 'montar-corpo-put';
      const corpoPut = corpoPutParaImagens(antes, linksNovos);
      contextoLog.etapa = 'abrir-auditoria';
      const auditoria = await iniciarAuditoria({
        tipo: 'ALTERAR_IMAGENS_MARKETPLACE',
        id_produto_bling: idProduto,
        codigo,
        antes: { imagens: linksAtuais },
        solicitado: planoImagens,
      });
      let requisicaoEnviada = false;
      try {
        await pausa(500);
        contextoLog.etapa = 'enviar-put-bling';
        requisicaoEnviada = true;
        await chamarBling(`/produtos/${idProduto}`, token, { method: 'PUT', body: JSON.stringify(corpoPut) });

        contextoLog.etapa = 'conferir-substituicao';
        const { depois, linksConfirmados } = await conferirSubstituicaoDeImagens(
          idProduto,
          token,
          antes,
          quantidadeDepois,
        );
        contextoLog.etapa = 'concluir-auditoria';
        await concluirAuditoria(auditoria, 'SUCESSO');
        return Response.json({
          aplicado: true,
          produto: { id: idProduto, codigo, nome: depois.nome },
          imagensAntes: linksAtuais,
          imagensDepois: linksConfirmados,
          quantidadeConfirmada: linksConfirmados.length,
        });
      } catch (erro) {
        await concluirAuditoria(auditoria, requisicaoEnviada ? 'REVISAO' : 'FALHA', erro instanceof Error ? erro.message : 'Falha não identificada').catch(() => null);
        throw erro;
      }
    }

    if (acao === 'simular-produto') {
      const idProduto = inteiro(pedido.idProduto, 'Produto');
      const atual = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
      if (!atual) throw new Error('O Bling não devolveu o produto.');
      const categoriaAtual = Number((atual.categoria as Objeto | undefined)?.id || 0);
      const categoriaNova = pedido.idCategoria === undefined || pedido.idCategoria === null || pedido.idCategoria === ''
        ? categoriaAtual
        : inteiro(pedido.idCategoria, 'Categoria');
      if (categoriaNova !== categoriaAtual) {
        await pausa(360);
        await chamarBling(`/categorias/produtos/${categoriaNova}`, token);
      }
      const alteracoes = Array.isArray(pedido.campos) ? pedido.campos : [];
      const camposAtuais = camposDoProduto(atual);
      const camposNovos = alteracoes.length ? mesclarCampos(camposAtuais, alteracoes) : camposAtuais;
      if (categoriaNova === categoriaAtual && hash(camposNovos) === hash(camposAtuais)) {
        throw new Error('Nenhuma alteração foi informada.');
      }
      const codigo = texto(atual.codigo, 120, 'SKU do produto');
      const plano = {
        versao: 1,
        tipo: 'produto',
        idProduto,
        codigo,
        categoriaNova,
        alterarCategoria: categoriaNova !== categoriaAtual,
        camposNovos,
        alterarCampos: hash(camposNovos) !== hash(camposAtuais),
        hashAtual: hash(atual),
        expiraEm: Date.now() + 10 * 60 * 1000,
      };
      return Response.json({
        simulacao: assinar(plano),
        expiraEm: plano.expiraEm,
        produto: { id: idProduto, codigo, nome: atual.nome },
        antes: { categoria: atual.categoria || null, camposCustomizados: camposAtuais },
        depois: { categoria: { id: categoriaNova }, camposCustomizados: camposNovos },
        corpoPatch: {
          ...(plano.alterarCategoria ? { categoria: { id: categoriaNova } } : {}),
          ...(plano.alterarCampos ? { camposCustomizados: camposNovos } : {}),
        },
      });
    }

    if (acao === 'aplicar-produto') {
      const plano = conferirAssinatura(pedido.simulacao);
      if (plano.tipo !== 'produto') throw new Error('Esta simulação não é de produto.');
      const codigo = texto(plano.codigo, 120, 'SKU');
      if (String(pedido.confirmacao || '').trim() !== codigo) throw new Error(`Digite exatamente o SKU ${codigo} para confirmar.`);
      const idProduto = inteiro(plano.idProduto, 'Produto');
      const antes = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
      if (!antes || hash(antes) !== plano.hashAtual) {
        throw new Error('O produto mudou depois da simulação. Nenhuma alteração foi feita; simule novamente.');
      }
      const corpoPatch: Objeto = {};
      if (plano.alterarCategoria === true) corpoPatch.categoria = { id: inteiro(plano.categoriaNova, 'Categoria') };
      if (plano.alterarCampos === true) corpoPatch.camposCustomizados = plano.camposNovos;
      if (!Object.keys(corpoPatch).length) throw new Error('A simulação não contém alterações.');
      const auditoria = await iniciarAuditoria({
        tipo: 'ALTERAR_PRODUTO', id_produto_bling: idProduto, codigo,
        antes: retratoEditavel(antes), solicitado: corpoPatch,
      });
      let requisicaoEnviada = false;
      try {
        await pausa(360);
        requisicaoEnviada = true;
        await chamarBling(`/produtos/${idProduto}`, token, { method: 'PATCH', body: JSON.stringify(corpoPatch) });
        await pausa(360);
        const depois = (await chamarBling(`/produtos/${idProduto}`, token))?.data as Objeto;
        if (!depois) throw new Error('O Bling não devolveu o produto após a alteração.');
        if (hash(retratoProtegido(antes)) !== hash(retratoProtegido(depois))) {
          throw new Error('ALERTA: a conferência detectou mudança fora de categoria/campos. Interrompa novas operações e revise o produto no Bling.');
        }
        const esperado = {
          categoria: plano.alterarCategoria ? { id: plano.categoriaNova } : (antes.categoria || null),
          camposCustomizados: plano.alterarCampos ? plano.camposNovos : camposDoProduto(antes),
        };
        if (hash(retratoEditavel(depois)) !== hash(esperado)) {
          throw new Error('O Bling respondeu, mas a conferência final não encontrou exatamente os valores simulados.');
        }
        await concluirAuditoria(auditoria, 'SUCESSO');
        return Response.json({ aplicado: true, produto: { id: idProduto, codigo, nome: depois.nome }, categoria: depois.categoria, camposCustomizados: camposDoProduto(depois) });
      } catch (erro) {
        await concluirAuditoria(auditoria, requisicaoEnviada ? 'REVISAO' : 'FALHA', erro instanceof Error ? erro.message : 'Falha não identificada').catch(() => null);
        throw erro;
      }
    }

    if (acao === 'simular-campo') {
      const nome = texto(pedido.nome, 120, 'Nome do campo');
      const modulo = inteiro(pedido.idModulo, 'Módulo');
      const tipoCampo = inteiro(pedido.idTipo, 'Tipo de campo');
      const categoria = inteiro(pedido.idCategoria, 'Categoria');
      await chamarBling(`/categorias/produtos/${categoria}`, token);
      const corpo: Objeto = {
        nome,
        situacao: 1,
        modulo: { id: modulo },
        tipoCampo: { id: tipoCampo },
        agrupadores: [{ id: categoria }],
        placeholder: String(pedido.placeholder || '').trim().slice(0, 200),
        obrigatorio: pedido.obrigatorio === true,
      };
      const minimo = Number(pedido.minimo);
      const maximo = Number(pedido.maximo);
      if (Number.isInteger(minimo) && minimo >= 0 && Number.isInteger(maximo) && maximo >= minimo) corpo.tamanho = { minimo, maximo };
      const plano = { versao: 1, tipo: 'campo', corpo, nome, expiraEm: Date.now() + 10 * 60 * 1000 };
      return Response.json({ simulacao: assinar(plano), expiraEm: plano.expiraEm, corpo });
    }

    if (acao === 'criar-campo') {
      const plano = conferirAssinatura(pedido.simulacao);
      if (plano.tipo !== 'campo') throw new Error('Esta simulação não é de campo customizado.');
      const nome = texto(plano.nome, 120, 'Nome do campo');
      if (String(pedido.confirmacao || '').trim() !== nome) throw new Error(`Digite exatamente ${nome} para confirmar.`);
      const auditoria = await iniciarAuditoria({ tipo: 'CRIAR_CAMPO', solicitado: plano.corpo });
      let requisicaoEnviada = false;
      try {
        requisicaoEnviada = true;
        const retorno = await chamarBling('/campos-customizados', token, { method: 'POST', body: JSON.stringify(plano.corpo) });
        await concluirAuditoria(auditoria, 'SUCESSO');
        return Response.json({ criado: true, campo: retorno?.data || retorno });
      } catch (erro) {
        await concluirAuditoria(auditoria, requisicaoEnviada ? 'REVISAO' : 'FALHA', erro instanceof Error ? erro.message : 'Falha não identificada').catch(() => null);
        throw erro;
      }
    }

    return Response.json({ erro: 'Operação desconhecida.' }, { status: 400 });
  } catch (erro) {
    console.error('[bling/administracao] POST falhou', {
      ...contextoLog,
      codigoErro: String((erro as FalhaApi)?.codigo || ''),
      statusBling: Number((erro as FalhaApi)?.status) || undefined,
      mensagem: erro instanceof Error ? erro.message : 'Falha não identificada',
    });
    return respostaErro(erro);
  }
}
