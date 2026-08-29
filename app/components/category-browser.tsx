'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export type CategoriaCatalogo = { id: number; descricao: string; categoriaPai?: { id?: number } };
export type ProdutoCatalogo = {
  id: number;
  codigo: string;
  nome: string;
  imagemURL?: string;
  situacao?: string;
  categoria?: { id?: number };
};

type Diagnostico = {
  id: number;
  saldoFisico: number;
  saldoVirtual: number;
  quantidadeImagens: number;
  quantidadeCanais: number;
  canalConferido: boolean;
  canais: number[];
  alerta: boolean;
};

type ImagemTesteMarketplace = {
  indice: number;
  urlOriginal: string;
  urlPrevia: string;
  blob: Blob;
  larguraOriginal: number;
  alturaOriginal: number;
};

type ModoImagens = 'remover-reaplicar' | 'apos-remocao-confirmada';

type ProdutoTesteMarketplace = {
  id: number;
  codigo: string;
  nome: string;
  linksAtuais: string[];
  linksParaGerar: string[];
  modo: ModoImagens;
};

type SimulacaoImagens = {
  simulacao: string;
  simulacaoAplicacao?: string;
  produtoSemImagens?: boolean;
  expiraEm: number;
  modo: ModoImagens;
  corpoPatch: { midia: { imagens: { imagensURL: Array<{ link: string }> } } };
};

type ReposicaoImagens = {
  simulacao: string;
  expiraEm: number;
};

type LoteImagens = {
  id: string;
  status: 'PRONTO' | 'EM_ANDAMENTO' | 'PAUSADO' | 'FINALIZADO' | 'REVISAO' | 'CANCELADO';
  total: number;
  pendentes: number;
  processando: number;
  concluidos: number;
  ignorados: number;
  falhas: number;
  created_at: string;
};

type ItemLoteImagens = {
  id: string;
  lote_id: string;
  posicao: number;
  id_produto_bling: number;
  codigo: string;
  produto: string;
  status: 'PENDENTE' | 'PROCESSANDO' | 'CONCLUIDO' | 'IGNORADO' | 'FALHA' | 'REVISAO';
  etapa: string;
  urls_marketplace?: string[];
  motivo?: string | null;
  tentativas: number;
  concluido_em?: string | null;
};

type Props = {
  categorias: CategoriaCatalogo[];
  produtoAberto?: number;
  aoAbrir: (produto: ProdutoCatalogo) => void;
  aoErro: (mensagem: string) => void;
};

type FalhaResposta = Error & { status?: number; codigo?: string };

async function jsonDaResposta(resposta: Response) {
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.erro) {
    const falha = new Error(dados.erro || `HTTP ${resposta.status}`) as FalhaResposta;
    falha.status = resposta.status;
    falha.codigo = String(dados.codigo || '');
    throw falha;
  }
  return dados;
}

const LADO_MARKETPLACE = 1200;

function linksDasImagens(produto: Record<string, unknown>) {
  const midia = produto.midia && typeof produto.midia === 'object' ? produto.midia as Record<string, unknown> : {};
  const imagens = midia.imagens && typeof midia.imagens === 'object' ? midia.imagens as Record<string, unknown> : {};
  const grupos = [imagens.internas, imagens.externas, imagens.imagensURL];
  const links: string[] = [];
  const chaves = new Set<string>();
  for (const grupo of grupos) {
    if (!Array.isArray(grupo)) continue;
    for (const item of grupo) {
      const registro = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const link = String(registro.link || registro.url || registro.linkOriginal || registro.urlOriginal || registro.imagemURL || registro.urlImagem || registro.linkMiniatura || '').trim();
      let chave = link;
      try {
        const url = new URL(link);
        url.search = '';
        url.hash = '';
        chave = url.toString();
      } catch {}
      if (/^https:\/\//i.test(link) && !chaves.has(chave)) {
        chaves.add(chave);
        links.push(link);
      }
    }
  }
  const principal = String(produto.imagemURL || '').trim();
  if (!links.length && /^https:\/\//i.test(principal)) links.push(principal);
  return links;
}

const carregarImagem = (blob: Blob) => new Promise<HTMLImageElement>((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const imagem = new Image();
  imagem.onload = () => { URL.revokeObjectURL(url); resolve(imagem); };
  imagem.onerror = () => { URL.revokeObjectURL(url); reject(new Error('O navegador não conseguiu abrir a imagem.')); };
  imagem.src = url;
});

async function gerarCopiaMarketplace(url: string) {
  const resposta = await fetch(`/api/imagem?url=${encodeURIComponent(url)}`);
  if (!resposta.ok) throw new Error(`Não foi possível carregar uma das imagens (HTTP ${resposta.status}).`);
  const imagem = await carregarImagem(await resposta.blob());
  const canvas = document.createElement('canvas');
  canvas.width = LADO_MARKETPLACE;
  canvas.height = LADO_MARKETPLACE;
  const contexto = canvas.getContext('2d');
  if (!contexto) throw new Error('O navegador não conseguiu preparar a imagem.');
  contexto.fillStyle = '#ffffff';
  contexto.fillRect(0, 0, LADO_MARKETPLACE, LADO_MARKETPLACE);
  contexto.imageSmoothingEnabled = true;
  contexto.imageSmoothingQuality = 'high';
  const escala = Math.min(LADO_MARKETPLACE / imagem.naturalWidth, LADO_MARKETPLACE / imagem.naturalHeight);
  const largura = imagem.naturalWidth * escala;
  const altura = imagem.naturalHeight * escala;
  contexto.drawImage(imagem, (LADO_MARKETPLACE - largura) / 2, (LADO_MARKETPLACE - altura) / 2, largura, altura);
  const blobFinal = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blobFinal) throw new Error('O navegador não conseguiu criar o JPEG de teste.');
  return { blob: blobFinal, larguraOriginal: imagem.naturalWidth, alturaOriginal: imagem.naturalHeight };
}

const tamanhoArquivo = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function filhosDe(id: number, categorias: CategoriaCatalogo[]) {
  return categorias
    .filter(item => Number(item.categoriaPai?.id || 0) === id)
    .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR'));
}

function idsDaArvore(id: number, categorias: CategoriaCatalogo[]) {
  const encontrados = new Set<number>();
  const fila = [id];
  while (fila.length) {
    const atual = fila.shift();
    if (!atual || encontrados.has(atual)) continue;
    encontrados.add(atual);
    for (const filho of filhosDe(atual, categorias)) fila.push(filho.id);
  }
  return [...encontrados];
}

function baixarProdutos(produtos: ProdutoCatalogo[], categorias: CategoriaCatalogo[]) {
  const porId = new Map(categorias.map(item => [item.id, item.descricao]));
  const linhas = [
    ['sku', 'produto', 'categoria', 'situacao'],
    ...produtos.map(item => [item.codigo, item.nome, porId.get(Number(item.categoria?.id)) || 'Categoria não informada', item.situacao || '']),
  ];
  const csv = linhas.map(linha => linha.map(valor => {
    const seguro = /^[=+\-@]/.test(valor) ? `'${valor}` : valor;
    return `"${seguro.replaceAll('"', '""')}"`;
  }).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `balanco-catalogo-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function CategoryBrowser({ categorias, produtoAberto, aoAbrir, aoErro }: Props) {
  const idsConhecidos = useMemo(() => new Set(categorias.map(item => item.id)), [categorias]);
  const segmentos = useMemo(() => categorias
    .filter(item => !item.categoriaPai?.id || !idsConhecidos.has(Number(item.categoriaPai.id)))
    .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR')), [categorias, idsConhecidos]);

  const [segmentoId, setSegmentoId] = useState<number>();
  const [categoriaId, setCategoriaId] = useState<number>();
  const [subcategoriaId, setSubcategoriaId] = useState<number>();
  const [somenteNivel, setSomenteNivel] = useState(false);
  const [busca, setBusca] = useState('');
  const [produtos, setProdutos] = useState<ProdutoCatalogo[]>([]);
  const [truncado, setTruncado] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [diagnosticando, setDiagnosticando] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [diagnosticos, setDiagnosticos] = useState<Record<number, Diagnostico>>({});
  const [somenteComFotos, setSomenteComFotos] = useState(true);
  const [produtoTeste, setProdutoTeste] = useState<ProdutoTesteMarketplace>();
  const [imagensTeste, setImagensTeste] = useState<ImagemTesteMarketplace[]>([]);
  const [preparandoTeste, setPreparandoTeste] = useState(false);
  const [simulandoImagens, setSimulandoImagens] = useState(false);
  const [removendoImagens, setRemovendoImagens] = useState(false);
  const [aplicandoImagens, setAplicandoImagens] = useState(false);
  const [simulacaoImagens, setSimulacaoImagens] = useState<SimulacaoImagens>();
  const [reposicaoImagens, setReposicaoImagens] = useState<ReposicaoImagens>();
  const [confirmacaoSku, setConfirmacaoSku] = useState('');
  const [mensagemTeste, setMensagemTeste] = useState('');
  const [selecionadosLote, setSelecionadosLote] = useState<Record<number, ProdutoCatalogo>>({});
  const [loteImagens, setLoteImagens] = useState<LoteImagens>();
  const [itensLote, setItensLote] = useState<ItemLoteImagens[]>([]);
  const [abaLote, setAbaLote] = useState<'FILA' | 'CONCLUIDOS'>('FILA');
  const [carregandoLote, setCarregandoLote] = useState(false);
  const [executandoLote, setExecutandoLote] = useState(false);
  const [itemAtualLote, setItemAtualLote] = useState<ItemLoteImagens>();
  const [confirmacaoLote, setConfirmacaoLote] = useState('');
  const interromperLote = useRef(false);
  const controladorConsulta = useRef<AbortController | undefined>(undefined);
  const sequenciaConsulta = useRef(0);

  const segmentoAtualId = segmentoId;
  const categoriasDoSegmento = useMemo(() => segmentoAtualId ? filhosDe(segmentoAtualId, categorias) : [], [categorias, segmentoAtualId]);
  const subcategorias = useMemo(() => categoriaId ? filhosDe(categoriaId, categorias) : [], [categorias, categoriaId]);
  const nivelId = subcategoriaId || categoriaId || segmentoAtualId;
  const idsConsulta = useMemo(() => nivelId
    ? (somenteNivel ? [nivelId] : idsDaArvore(nivelId, categorias))
    : [], [categorias, nivelId, somenteNivel]);
  const porId = useMemo(() => new Map(categorias.map(item => [item.id, item])), [categorias]);
  const trilha = [segmentoAtualId, categoriaId, subcategoriaId].filter(Boolean).map(id => porId.get(Number(id))?.descricao).filter(Boolean).join(' › ');
  const aguardandoDiagnostico = <span className="text-xs font-semibold text-slate-400">Clique em conferir</span>;

  const consultar = async () => {
    if (!idsConsulta.length) return;
    controladorConsulta.current?.abort();
    const controlador = new AbortController();
    controladorConsulta.current = controlador;
    const sequencia = ++sequenciaConsulta.current;
    setCarregando(true);
    setProdutos([]);
    setPagina(1);
    setDiagnosticos({});
    aoErro('');
    try {
      const parametros = new URLSearchParams({ recurso: 'produtos', categorias: idsConsulta.join(',') });
      if (busca.trim()) parametros.set('q', busca.trim());
      const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?${parametros}`, { signal: controlador.signal }));
      if (controlador.signal.aborted || sequencia !== sequenciaConsulta.current) return;
      setProdutos(dados.produtos || []);
      setTruncado(Boolean(dados.truncado));
    } catch (erro) {
      if (controlador.signal.aborted || (erro instanceof DOMException && erro.name === 'AbortError')) return;
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível consultar os produtos.');
    } finally {
      if (sequencia === sequenciaConsulta.current) {
        setCarregando(false);
        if (controladorConsulta.current === controlador) controladorConsulta.current = undefined;
      }
    }
  };

  useEffect(() => {
    if (!idsConsulta.length) return;
    const atraso = window.setTimeout(() => { void consultar(); }, 80);
    return () => {
      window.clearTimeout(atraso);
      controladorConsulta.current?.abort();
    };
    // A busca textual só é aplicada ao confirmar; a navegação hierárquica é automática.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsConsulta.join(',')]);

  useEffect(() => () => {
    imagensTeste.forEach(imagem => URL.revokeObjectURL(imagem.urlPrevia));
  }, [imagensTeste]);

  const porPagina = 50;
  const produtosComFiltroDeFoto = useMemo(() => somenteComFotos
    ? produtos.filter(item => String(item.imagemURL || '').trim())
    : produtos, [produtos, somenteComFotos]);
  const totalPaginas = Math.max(1, Math.ceil(produtosComFiltroDeFoto.length / porPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const visiveis = produtosComFiltroDeFoto.slice((paginaSegura - 1) * porPagina, paginaSegura * porPagina);

  const apiLote = async (pedido: Record<string, unknown>) => jsonDaResposta(await fetch('/api/bling/imagens-lote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pedido),
  }));

  const carregarLote = async (id?: string) => {
    setCarregandoLote(true);
    try {
      let loteId = id;
      if (!loteId) {
        const resumo = await jsonDaResposta(await fetch('/api/bling/imagens-lote'));
        const lotes = Array.isArray(resumo.lotes) ? resumo.lotes as LoteImagens[] : [];
        loteId = lotes[0]?.id;
      }
      if (!loteId) {
        setLoteImagens(undefined);
        setItensLote([]);
        return;
      }
      const dados = await jsonDaResposta(await fetch(`/api/bling/imagens-lote?id=${encodeURIComponent(loteId)}`));
      setLoteImagens(dados.lote as LoteImagens);
      setItensLote(Array.isArray(dados.itens) ? dados.itens as ItemLoteImagens[] : []);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível carregar a fila de imagens.');
    } finally {
      setCarregandoLote(false);
    }
  };

  useEffect(() => {
    const atraso = window.setTimeout(() => { void carregarLote(); }, 0);
    return () => window.clearTimeout(atraso);
    // A fila é persistente e precisa ser recuperada somente na abertura do catálogo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alternarSelecaoLote = (item: ProdutoCatalogo) => {
    setSelecionadosLote(atual => {
      const proximo = { ...atual };
      if (proximo[item.id]) delete proximo[item.id];
      else if (Object.keys(proximo).length < 500) proximo[item.id] = item;
      return proximo;
    });
  };

  const selecionarProdutosLote = (lista: ProdutoCatalogo[]) => {
    setSelecionadosLote(atual => {
      const proximo = { ...atual };
      for (const item of lista) {
        if (Object.keys(proximo).length >= 500) break;
        proximo[item.id] = item;
      }
      return proximo;
    });
  };

  const criarLoteImagens = async () => {
    const selecionados = Object.values(selecionadosLote);
    if (!selecionados.length || selecionados.length > 500) return;
    setCarregandoLote(true);
    aoErro('');
    try {
      const retorno = await apiLote({ acao: 'criar', produtos: selecionados });
      setSelecionadosLote({});
      setConfirmacaoLote('');
      setAbaLote('FILA');
      await carregarLote(String(retorno.lote.id));
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível criar o lote.');
    } finally {
      setCarregandoLote(false);
    }
  };

  const atualizarItemLote = async (
    loteId: string,
    itemId: string,
    status: ItemLoteImagens['status'],
    etapa: string,
    motivo?: string,
    urls?: string[],
  ) => apiLote({ acao: 'atualizar-item', loteId, itemId, status, etapa, motivo, urls });

  const processarItemLote = async (loteId: string, item: ItemLoteImagens) => {
    let alteracaoPodeTerSidoEnviada = false;
    try {
      const dadosBling = await fetch(`/api/bling/administracao?recurso=produto&id=${item.id_produto_bling}`).then(jsonDaResposta);
      const produto = dadosBling.produto && typeof dadosBling.produto === 'object' ? dadosBling.produto as Record<string, unknown> : {};
      const codigo = String(produto.codigo || item.codigo).trim();
      const dadosSupabase = await fetch(`/api/bling/administracao?recurso=imagens-supabase&codigo=${encodeURIComponent(codigo)}`).then(jsonDaResposta);
      const originais: string[] = [...new Set<string>((Array.isArray(dadosSupabase.imagens) ? dadosSupabase.imagens : [])
        .map((link: unknown) => String(link || '').trim()).filter((link: string) => /^https:\/\//i.test(link)))];
      const copiasExistentes: string[] = [...new Set<string>((Array.isArray(dadosSupabase.imagensMarketplace) ? dadosSupabase.imagensMarketplace : [])
        .map((link: unknown) => String(link || '').trim()).filter((link: string) => /^https:\/\//i.test(link)))];
      const urls: string[] = [...new Set<string>((Array.isArray(item.urls_marketplace) ? item.urls_marketplace : [])
        .map(link => String(link || '').trim()).filter(link => /^https:\/\//i.test(link)))];

      if (!urls.length && copiasExistentes.length) {
        await atualizarItemLote(loteId, item.id, 'IGNORADO', 'JA_CONVERTIDO', `${copiasExistentes.length} cópia(s) 1200×1200 já existentes.`);
        return;
      }
      if (!originais.length) throw new Error('Nenhuma imagem original foi encontrada no Storage do Supabase.');
      if (originais.length > 10) throw new Error('Mais de 10 imagens originais; produto enviado para revisão.');

      if (!urls.length) {
        const skuSeguro = (codigo.replace(/[^a-zA-Z0-9._-]/g, '-') || `produto-${item.id_produto_bling}`).slice(0, 80);
        for (let indice = 0; indice < originais.length; indice++) {
          const copia = await gerarCopiaMarketplace(originais[indice]);
          const caminho = `${skuSeguro}-marketplace/${skuSeguro}_${indice + 1}_1200.jpg`;
          const retorno = await jsonDaResposta(await fetch(`/api/upload?caminho=${encodeURIComponent(caminho)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg' },
            body: copia.blob,
          }));
          urls.push(String(retorno.url));
        }
        await atualizarItemLote(loteId, item.id, 'PROCESSANDO', 'COPIAS_1200_PRONTAS', undefined, urls);
      }

      const simulacao = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'simular-imagens', idProduto: item.id_produto_bling, modo: 'remover-reaplicar', urls }),
      })) as SimulacaoImagens;
      let simulacaoAplicacao = simulacao.simulacaoAplicacao;
      if (!simulacaoAplicacao) {
        alteracaoPodeTerSidoEnviada = true;
        const remocao = await jsonDaResposta(await fetch('/api/bling/administracao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acao: 'remover-imagens', simulacao: simulacao.simulacao, confirmacao: codigo }),
        }));
        simulacaoAplicacao = String(remocao.simulacaoAplicacao || '');
      }
      if (!simulacaoAplicacao) throw new Error('O Bling não liberou a etapa de aplicação das imagens.');
      alteracaoPodeTerSidoEnviada = true;
      const aplicado = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'aplicar-imagens', simulacao: simulacaoAplicacao, confirmacao: codigo }),
      }));
      await atualizarItemLote(
        loteId,
        item.id,
        'CONCLUIDO',
        'ENVIADO_BLING',
        `${Number(aplicado.quantidadeConfirmada || urls.length)} imagem(ns) 1200×1200 confirmada(s) no Bling.`,
        urls,
      );
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : 'Falha não identificada.';
      await atualizarItemLote(
        loteId,
        item.id,
        alteracaoPodeTerSidoEnviada ? 'REVISAO' : 'FALHA',
        alteracaoPodeTerSidoEnviada ? 'CONFERIR_BLING' : 'FALHA_PREPARACAO',
        mensagem,
      ).catch(() => null);
    }
  };

  const executarLoteImagens = async () => {
    if (!loteImagens || confirmacaoLote !== 'ENVIAR') return;
    interromperLote.current = false;
    setExecutandoLote(true);
    setAbaLote('FILA');
    aoErro('');
    try {
      await apiLote({ acao: 'iniciar', loteId: loteImagens.id });
      while (!interromperLote.current) {
        const retorno = await apiLote({ acao: 'reivindicar', loteId: loteImagens.id });
        if (retorno.pausado || retorno.finalizado) break;
        if (retorno.concorrencia) continue;
        const item = retorno.item as ItemLoteImagens | undefined;
        if (!item) break;
        setItemAtualLote(item);
        await processarItemLote(loteImagens.id, item);
        await carregarLote(loteImagens.id);
      }
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'O processamento do lote foi interrompido.');
    } finally {
      setItemAtualLote(undefined);
      setExecutandoLote(false);
      await carregarLote(loteImagens.id);
    }
  };

  const pausarLoteImagens = async () => {
    if (!loteImagens) return;
    interromperLote.current = true;
    try {
      await apiLote({ acao: 'pausar', loteId: loteImagens.id });
      await carregarLote(loteImagens.id);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível pausar o lote.');
    }
  };

  const tentarFalhasNovamente = async () => {
    if (!loteImagens) return;
    try {
      await apiLote({ acao: 'tentar-novamente', loteId: loteImagens.id });
      setConfirmacaoLote('');
      setAbaLote('FILA');
      await carregarLote(loteImagens.id);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível preparar as novas tentativas.');
    }
  };

  const diagnosticarPagina = async () => {
    if (!visiveis.length) return;
    setDiagnosticando(true);
    aoErro('');
    try {
      const parametros = new URLSearchParams({ recurso: 'diagnostico', ids: visiveis.map(item => item.id).join(',') });
      const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?${parametros}`));
      setDiagnosticos(atual => ({
        ...atual,
        ...Object.fromEntries((dados.diagnosticos || []).map((item: Diagnostico) => [item.id, item])),
      }));
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível conferir estoque, fotos e canais.');
    } finally {
      setDiagnosticando(false);
    }
  };

  const abrirTesteDeFotos = async (item: ProdutoCatalogo) => {
    setPreparandoTeste(true);
    setMensagemTeste('Conferindo o produto no Bling e buscando as imagens originais salvas no Supabase…');
    setSimulacaoImagens(undefined);
    setReposicaoImagens(undefined);
    setConfirmacaoSku('');
    setProdutoTeste(undefined);
    setImagensTeste([]);
    aoErro('');
    try {
      const dadosBling = await fetch(`/api/bling/administracao?recurso=produto&id=${item.id}`).then(jsonDaResposta);
      const produto = dadosBling.produto && typeof dadosBling.produto === 'object' ? dadosBling.produto as Record<string, unknown> : {};
      const codigoProduto = String(produto.codigo || item.codigo).trim();
      const dadosSupabase = await fetch(`/api/bling/administracao?recurso=imagens-supabase&codigo=${encodeURIComponent(codigoProduto)}`).then(jsonDaResposta);
      const linksAtuais = linksDasImagens(produto);
      const copias1200: unknown[] = Array.isArray(dadosSupabase.imagensMarketplace) ? dadosSupabase.imagensMarketplace : [];
      const links1200Existentes = [...new Set(copias1200
        .map(link => String(link || '').trim())
        .filter(link => /^https:\/\//i.test(link)))];
      const imagensSalvas: unknown[] = Array.isArray(dadosSupabase.imagens) ? dadosSupabase.imagens : [];
      const linksParaGerar: string[] = [...new Set(imagensSalvas
        .map(link => String(link || '').trim())
        .filter(link => /^https:\/\//i.test(link)))];
      if (!linksParaGerar.length) throw new Error('Nenhuma imagem original foi encontrada no Supabase para este SKU.');
      if (linksParaGerar.length > 10) throw new Error('O Supabase possui mais de 10 imagens para este produto. O teste foi bloqueado para revisão.');
      setProdutoTeste({
        id: item.id,
        codigo: codigoProduto,
        nome: String(produto.nome || item.nome),
        linksAtuais,
        linksParaGerar,
        modo: 'remover-reaplicar',
      });
      if (links1200Existentes.length) {
        setMensagemTeste(`${links1200Existentes.length} cópia(s) 1200×1200 já existem no Supabase para este SKU. O novo envio foi bloqueado para não duplicá-las novamente no Bling.`);
        return;
      }
      setMensagemTeste(`${linksAtuais.length} imagem(ns) no Bling e ${linksParaGerar.length} original(is) no Supabase. Convertendo as imagens salvas para 1200×1200…`);
      const geradas: ImagemTesteMarketplace[] = [];
      for (let indice = 0; indice < linksParaGerar.length; indice++) {
        const resultado = await gerarCopiaMarketplace(linksParaGerar[indice]);
        geradas.push({
          indice,
          urlOriginal: linksParaGerar[indice],
          urlPrevia: URL.createObjectURL(resultado.blob),
          blob: resultado.blob,
          larguraOriginal: resultado.larguraOriginal,
          alturaOriginal: resultado.alturaOriginal,
        });
      }
      setImagensTeste(geradas);
      setMensagemTeste(`${geradas.length} imagem(ns) convertida(s) a partir do Supabase. Até aqui, nenhuma imagem do Bling foi alterada.`);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : 'Não foi possível preparar o teste.';
      setMensagemTeste('');
      aoErro(mensagem);
    } finally {
      setPreparandoTeste(false);
    }
  };

  const simularTrocaDeImagens = async () => {
    if (!produtoTeste || imagensTeste.length !== produtoTeste.linksParaGerar.length) return;
    setSimulandoImagens(true);
    setMensagemTeste('Salvando as cópias em uma pasta separada e preparando a simulação…');
    aoErro('');
    try {
      const skuSeguro = (produtoTeste.codigo.replace(/[^a-zA-Z0-9._-]/g, '-') || `produto-${produtoTeste.id}`).slice(0, 80);
      const urls: string[] = [];
      for (const imagem of imagensTeste) {
        const caminho = `${skuSeguro}-marketplace/${skuSeguro}_${imagem.indice + 1}_1200.jpg`;
        const retorno = await jsonDaResposta(await fetch(`/api/upload?caminho=${encodeURIComponent(caminho)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: imagem.blob,
        }));
        urls.push(String(retorno.url));
      }
      const simulacao = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acao: 'simular-imagens',
          idProduto: produtoTeste.id,
          modo: produtoTeste.modo,
          urls,
        }),
      })) as SimulacaoImagens;
      setSimulacaoImagens(simulacao);
      if (simulacao.produtoSemImagens && simulacao.simulacaoAplicacao) {
        setReposicaoImagens({ simulacao: simulacao.simulacaoAplicacao, expiraEm: simulacao.expiraEm });
        setMensagemTeste(`O produto já está sem imagens. A etapa de remoção foi dispensada e as ${urls.length} imagens convertidas estão prontas para reaplicação segura.`);
      } else {
        setReposicaoImagens(undefined);
        setMensagemTeste(`Simulação pronta: primeiro remover ${produtoTeste.linksAtuais.length} imagem(ns) do Bling e, somente após confirmar zero, aplicar as ${urls.length} imagens convertidas.`);
      }
    } catch (erro) {
      setMensagemTeste('');
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível simular a troca das imagens.');
    } finally {
      setSimulandoImagens(false);
    }
  };

  const removerImagensDoBling = async () => {
    if (!produtoTeste || !simulacaoImagens) return;
    if (simulacaoImagens.expiraEm <= Date.now()) {
      setSimulacaoImagens(undefined);
      setConfirmacaoSku('');
      setMensagemTeste('A simulação venceu. Prepare novamente o teste antes de remover qualquer imagem.');
      aoErro('A simulação expirou. Nenhuma alteração foi feita no Bling.');
      return;
    }
    setRemovendoImagens(true);
    setMensagemTeste('Solicitando a remoção e aguardando o Bling confirmar zero imagens…');
    aoErro('');
    try {
      const retorno = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'remover-imagens', simulacao: simulacaoImagens.simulacao, confirmacao: confirmacaoSku }),
      }));
      setReposicaoImagens({ simulacao: String(retorno.simulacaoAplicacao), expiraEm: Number(retorno.expiraEm) });
      setMensagemTeste('Etapa 1 concluída: o Bling confirmou que o produto está com zero imagens. A aplicação das imagens convertidas foi liberada somente para este SKU.');
    } catch (erro) {
      const codigo = String((erro as FalhaResposta)?.codigo || '');
      if (codigo.startsWith('SIMULACAO_')) {
        setSimulacaoImagens(undefined);
        setConfirmacaoSku('');
      }
      setReposicaoImagens(undefined);
      aoErro(erro instanceof Error ? erro.message : 'O Bling não confirmou a remoção. A reaplicação continua bloqueada.');
    } finally {
      setRemovendoImagens(false);
    }
  };

  const aplicarTrocaDeImagens = async () => {
    if (!produtoTeste || !reposicaoImagens) return;
    if (reposicaoImagens.expiraEm <= Date.now()) {
      setReposicaoImagens(undefined);
      setConfirmacaoSku('');
      setMensagemTeste('A autorização para reaplicar venceu. O produto continua sem imagens; prepare novamente o teste antes de continuar.');
      aoErro('A autorização de reaplicação expirou. Nenhuma imagem nova foi enviada.');
      return;
    }
    setAplicandoImagens(true);
    setMensagemTeste('Aplicando somente as imagens e conferindo novamente no Bling…');
    aoErro('');
    try {
      const retorno = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'aplicar-imagens', simulacao: reposicaoImagens.simulacao, confirmacao: confirmacaoSku }),
      }));
      setSimulacaoImagens(undefined);
      setReposicaoImagens(undefined);
      setConfirmacaoSku('');
      setMensagemTeste(`Teste completo aprovado: o Bling confirmou ${retorno.quantidadeConfirmada} imagem(ns) convertida(s). Confira visualmente o produto antes de liberar qualquer lote.`);
    } catch (erro) {
      const codigo = String((erro as FalhaResposta)?.codigo || '');
      if (codigo.startsWith('SIMULACAO_')) {
        setReposicaoImagens(undefined);
        setConfirmacaoSku('');
        setMensagemTeste('A autorização de reaplicação foi descartada. O produto precisa ser relido antes de continuar.');
      } else {
        setMensagemTeste('');
      }
      aoErro(erro instanceof Error ? erro.message : 'A reaplicação falhou. Não teste outro produto até revisar este cadastro.');
    } finally {
      setAplicandoImagens(false);
    }
  };

  const selecionarSegmento = (id: number) => {
    setSegmentoId(id);
    setCategoriaId(undefined);
    setSubcategoriaId(undefined);
    setSomenteNivel(false);
  };

  const quantidadeSelecionada = Object.keys(selecionadosLote).length;
  const itensFilaLote = itensLote.filter(item => !['CONCLUIDO', 'IGNORADO'].includes(item.status));
  const itensConcluidosLote = itensLote.filter(item => ['CONCLUIDO', 'IGNORADO'].includes(item.status));
  const itensExibidosLote = abaLote === 'FILA' ? itensFilaLote : itensConcluidosLote;
  const progressoLote = loteImagens?.total
    ? Math.round(((loteImagens.concluidos + loteImagens.ignorados + loteImagens.falhas) / loteImagens.total) * 100)
    : 0;
  const loteAberto = Boolean(loteImagens && ['PRONTO', 'EM_ANDAMENTO', 'PAUSADO'].includes(loteImagens.status));

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto rounded-2xl bg-[#101d27] p-2 shadow-[0_12px_32px_rgba(7,26,36,.18)]">
        <div className="flex min-w-max items-center gap-1">
          {segmentos.map((segmento, indice) => (
            <button
              key={segmento.id}
              type="button"
              onClick={() => selecionarSegmento(segmento.id)}
              className={`group flex items-center gap-2 rounded-xl px-4 py-3 text-left text-xs font-black uppercase tracking-wide transition ${segmentoAtualId === segmento.id ? 'bg-cyan-300 text-[#071a24]' : 'text-slate-200 hover:bg-white/10 hover:text-white'}`}
            >
              <span className={`grid h-7 w-7 place-items-center rounded-lg text-[11px] ${segmentoAtualId === segmento.id ? 'bg-[#071a24] text-cyan-300' : 'bg-white/10 text-amber-300'}`}>{String(indice + 1).padStart(2, '0')}</span>
              {segmento.descricao}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_280px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-black uppercase tracking-[.18em] text-cyan-700">Categoria</p>
          <div className="mt-3 max-h-72 space-y-1 overflow-auto">
            <button type="button" onClick={() => { setCategoriaId(undefined); setSubcategoriaId(undefined); setSomenteNivel(true); }} className={`w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold ${!categoriaId && somenteNivel ? 'bg-amber-50 text-amber-800' : 'text-slate-600 hover:bg-slate-50'}`}>Produtos soltos no segmento</button>
            {categoriasDoSegmento.map(item => <button key={item.id} type="button" onClick={() => { setCategoriaId(item.id); setSubcategoriaId(undefined); setSomenteNivel(false); }} className={`w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold ${categoriaId === item.id ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{item.descricao}</button>)}
            {!segmentoAtualId && <p className="px-3 py-4 text-sm text-slate-400">Escolha um segmento na faixa superior.</p>}
            {segmentoAtualId && !categoriasDoSegmento.length && <p className="px-3 py-4 text-sm text-slate-400">Este segmento não possui categorias filhas.</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-black uppercase tracking-[.18em] text-blue-700">Subcategoria</p>
          <div className="mt-3 max-h-72 space-y-1 overflow-auto">
            {categoriaId && <button type="button" onClick={() => { setSubcategoriaId(undefined); setSomenteNivel(true); }} className={`w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold ${!subcategoriaId && somenteNivel ? 'bg-amber-50 text-amber-800' : 'text-slate-600 hover:bg-slate-50'}`}>Produtos soltos na categoria</button>}
            {subcategorias.map(item => <button key={item.id} type="button" onClick={() => { setSubcategoriaId(item.id); setSomenteNivel(false); }} className={`w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold ${subcategoriaId === item.id ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{item.descricao}</button>)}
            {!categoriaId && <p className="px-3 py-4 text-sm text-slate-400">Escolha uma categoria para ver suas subcategorias.</p>}
            {categoriaId && !subcategorias.length && <p className="px-3 py-4 text-sm text-slate-400">Esta categoria não possui subcategorias.</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-[11px] font-black uppercase tracking-[.18em] text-slate-500">Escopo atual</p>
          <h3 className="mt-2 text-xl font-black text-slate-950">{trilha || 'Escolha um segmento'}</h3>
          <p className="mt-2 text-sm text-slate-500">{somenteNivel ? 'Somente produtos cadastrados diretamente neste nível.' : 'Inclui este nível e todas as categorias abaixo dele.'}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setSomenteNivel(false)} className={`rounded-xl px-3 py-2 text-xs font-black ${!somenteNivel ? 'bg-[#071a24] text-white' : 'bg-slate-100 text-slate-600'}`}>Toda a árvore</button>
            <button type="button" onClick={() => setSomenteNivel(true)} className={`rounded-xl px-3 py-2 text-xs font-black ${somenteNivel ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600'}`}>Somente neste nível</button>
          </div>
          <div className="mt-4 flex gap-2">
            <input value={busca} onChange={evento => setBusca(evento.target.value)} onKeyDown={evento => { if (evento.key === 'Enter') void consultar(); }} className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2.5 text-sm" placeholder="Filtrar por SKU ou nome" />
            <button type="button" onClick={consultar} disabled={carregando || !nivelId} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{carregando ? 'Buscando…' : 'Buscar'}</button>
          </div>
        </div>
      </div>

      {(produtoTeste || preparandoTeste) && <section className="overflow-hidden rounded-2xl border-2 border-violet-200 bg-white shadow-[0_14px_40px_rgba(76,29,149,.08)]">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-violet-100 bg-violet-50 px-5 py-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[.18em] text-violet-700">Teste controlado de imagens</p>
            <h3 className="mt-1 text-lg font-black text-slate-950">{produtoTeste ? `${produtoTeste.codigo} · ${produtoTeste.nome}` : 'Carregando produto do Bling…'}</h3>
            <p className="mt-1 text-xs font-semibold text-slate-600">Origem Supabase · JPEG 1200×1200 · remoção e reaplicação conferidas separadamente</p>
            {produtoTeste && <p className="mt-2 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-900">{produtoTeste.linksAtuais.length} no Bling → zero → {produtoTeste.linksParaGerar.length} convertidas</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => document.getElementById('lote-imagens')?.scrollIntoView({ behavior: 'smooth' })} className="rounded-xl bg-violet-700 px-3 py-2 text-xs font-black text-white">Abrir processamento em lote</button>
            <button type="button" disabled={preparandoTeste || removendoImagens || aplicandoImagens} onClick={() => { setProdutoTeste(undefined); setImagensTeste([]); setSimulacaoImagens(undefined); setReposicaoImagens(undefined); setConfirmacaoSku(''); setMensagemTeste(''); }} className="rounded-xl border border-violet-200 bg-white px-3 py-2 text-xs font-black text-violet-800 disabled:opacity-40">Fechar teste</button>
          </div>
        </div>

        {mensagemTeste && <div role="status" className="border-b border-blue-100 bg-blue-50 px-5 py-3 text-sm font-bold text-blue-800">{mensagemTeste}</div>}
        {produtoTeste && imagensTeste.length > 0 && <div className="p-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {imagensTeste.map(imagem => <article key={imagem.indice} className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imagem.urlPrevia} alt={`Cópia ${imagem.indice + 1} de ${produtoTeste.nome}`} className="aspect-square w-full bg-white object-contain" />
              <div className="space-y-1 p-3 text-xs text-slate-600">
                <p className="font-black text-slate-900">Imagem final {imagem.indice + 1}</p>
                <p>Original: {imagem.larguraOriginal}×{imagem.alturaOriginal}</p>
                <p>Nova: 1200×1200 · {tamanhoArquivo(imagem.blob.size)}</p>
              </div>
            </article>)}
          </div>

          {!simulacaoImagens && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="max-w-2xl text-sm font-semibold text-amber-950">O próximo botão salva as cópias convertidas numa pasta separada do Supabase e monta o teste. Nenhuma imagem do Bling será alterada nesta preparação.</p>
            <button type="button" onClick={simularTrocaDeImagens} disabled={simulandoImagens || preparandoTeste} className="rounded-xl bg-violet-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">{simulandoImagens ? 'Preparando teste…' : 'Preparar teste seguro'}</button>
          </div>}

          {simulacaoImagens && !reposicaoImagens && <div className="mt-5 rounded-2xl border-2 border-rose-300 bg-rose-50 p-4">
            <p className="text-xs font-black uppercase tracking-wider text-rose-800">Etapa 1 de 2 · remover todas as imagens</p>
            <p className="mt-2 text-sm font-semibold text-rose-950">Esta ação enviará o produto sem imagens e aguardará o Bling confirmar <strong>zero imagens</strong>. Se o Bling mantiver qualquer foto, a etapa 2 continuará bloqueada. Digite <strong>{produtoTeste.codigo}</strong> para autorizar somente este produto.</p>
            <details className="mt-3 rounded-xl border border-rose-200 bg-white p-3 text-xs text-slate-700">
              <summary className="cursor-pointer font-black">Ver conjunto exato de imagens novas</summary>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(simulacaoImagens.corpoPatch, null, 2)}</pre>
            </details>
            <div className="mt-4 flex flex-wrap gap-2">
              <input value={confirmacaoSku} onChange={evento => setConfirmacaoSku(evento.target.value)} className="min-w-[240px] flex-1 rounded-xl border border-rose-300 bg-white px-3 py-2.5 text-sm font-bold" placeholder={`Digite ${produtoTeste.codigo}`} />
              <button type="button" onClick={removerImagensDoBling} disabled={removendoImagens || confirmacaoSku !== produtoTeste.codigo} className="rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{removendoImagens ? 'Removendo e conferindo…' : '1. Remover todas as imagens'}</button>
            </div>
          </div>}

          {reposicaoImagens && <div className="mt-5 rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4">
            <p className="text-xs font-black uppercase tracking-wider text-emerald-800">Etapa 2 de 2 · produto confirmado sem imagens</p>
            <p className="mt-2 text-sm font-semibold text-emerald-950">O Bling confirmou zero imagens. Agora o servidor aceitará somente as <strong>{produtoTeste.linksParaGerar.length}</strong> cópias 1200×1200 preparadas acima e fará uma nova conferência antes de aprovar o teste.</p>
            <button type="button" onClick={aplicarTrocaDeImagens} disabled={aplicandoImagens || confirmacaoSku !== produtoTeste.codigo} className="mt-4 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{aplicandoImagens ? 'Aplicando e conferindo…' : '2. Aplicar todas as imagens novas'}</button>
          </div>}

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-black uppercase tracking-wider text-slate-600">Processamento em lote</p>
            <p className="mt-2 text-sm font-semibold text-slate-700">A fila de até 500 produtos continuará bloqueada até este teste completar as duas etapas e a conferência visual ser aprovada.</p>
          </div>
        </div>}
      </section>}

      <section id="lote-imagens" className="overflow-hidden rounded-3xl border-2 border-cyan-200 bg-white shadow-[0_18px_55px_rgba(8,145,178,.12)]">
        <div className="bg-[#071a24] px-5 py-5 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[.2em] text-cyan-300">Central de imagens 1200×1200</p>
              <h3 className="mt-1 text-xl font-black">Seleção e envio de até 500 produtos</h3>
              <p className="mt-2 max-w-3xl text-sm text-slate-300">Os produtos são processados um por vez. Ao concluir, saem da fila e aparecem na aba Concluídos. A fila fica salva para pausa e retomada.</p>
            </div>
            <div className="rounded-2xl bg-white/10 px-4 py-3 text-right">
              <p className="text-xs font-bold text-slate-300">Selecionados agora</p>
              <p className="text-2xl font-black text-cyan-300">{quantidadeSelecionada}<span className="text-sm text-slate-400"> / 500</span></p>
            </div>
          </div>
        </div>

        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => selecionarProdutosLote(visiveis)} disabled={!visiveis.length || quantidadeSelecionada >= 500 || loteAberto} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40">Selecionar os 50 visíveis</button>
            <button type="button" onClick={() => selecionarProdutosLote(produtosComFiltroDeFoto.slice(0, 500))} disabled={!produtosComFiltroDeFoto.length || quantidadeSelecionada >= 500 || loteAberto} className="rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-2 text-xs font-black text-cyan-900 disabled:opacity-40">Selecionar até 500 deste resultado</button>
            <button type="button" onClick={() => setSelecionadosLote({})} disabled={!quantidadeSelecionada || loteAberto} className="rounded-xl px-3 py-2 text-xs font-black text-rose-700 disabled:opacity-40">Limpar seleção</button>
            <button type="button" onClick={criarLoteImagens} disabled={!quantidadeSelecionada || quantidadeSelecionada > 500 || loteAberto || carregandoLote} className="ml-auto rounded-xl bg-blue-700 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{carregandoLote ? 'Salvando fila…' : `Criar fila com ${quantidadeSelecionada} produto(s)`}</button>
          </div>
          {loteAberto && <p className="mt-2 text-xs font-semibold text-amber-700">Finalize ou revise o lote atual antes de criar uma nova fila.</p>}
        </div>

        {loteImagens ? <div className="p-5">
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ['Total', loteImagens.total, 'text-slate-950'],
              ['Pendentes', loteImagens.pendentes, 'text-blue-700'],
              ['Processando', loteImagens.processando, 'text-violet-700'],
              ['Enviados', loteImagens.concluidos, 'text-emerald-700'],
              ['Já prontos', loteImagens.ignorados, 'text-amber-700'],
              ['Revisar', loteImagens.falhas, 'text-rose-700'],
            ].map(([rotulo, valor, cor]) => <div key={String(rotulo)} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{rotulo}</p><p className={`mt-1 text-2xl font-black ${cor}`}>{valor}</p></div>)}
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3 text-xs font-black text-slate-700"><span>Status: {loteImagens.status.replaceAll('_', ' ')}</span><span>{progressoLote}%</span></div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all" style={{ width: `${progressoLote}%` }} /></div>
            {itemAtualLote && <p className="mt-3 text-sm font-bold text-violet-800">Processando agora: {itemAtualLote.codigo} · {itemAtualLote.produto}</p>}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {loteImagens.status !== 'EM_ANDAMENTO' && loteImagens.pendentes > 0 && <>
              <input value={confirmacaoLote} onChange={evento => setConfirmacaoLote(evento.target.value.toUpperCase())} className="min-w-[190px] rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-black" placeholder="Digite ENVIAR" />
              <button type="button" onClick={executarLoteImagens} disabled={executandoLote || confirmacaoLote !== 'ENVIAR'} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{loteImagens.status === 'PAUSADO' ? 'Retomar envio' : 'Iniciar envio ao Bling'}</button>
            </>}
            {(executandoLote || loteImagens.status === 'EM_ANDAMENTO') && <button type="button" onClick={pausarLoteImagens} className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-black text-amber-950">Pausar com segurança</button>}
            {loteImagens.falhas > 0 && !executandoLote && <button type="button" onClick={tentarFalhasNovamente} className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-black text-rose-800">Tentar falhas novamente</button>}
            <button type="button" onClick={() => void carregarLote(loteImagens.id)} disabled={carregandoLote} className="ml-auto rounded-xl border border-slate-300 px-3 py-2.5 text-xs font-black text-slate-700 disabled:opacity-40">Atualizar</button>
          </div>

          <div className="mt-5 flex gap-2 border-b border-slate-200">
            <button type="button" onClick={() => setAbaLote('FILA')} className={`border-b-2 px-4 py-3 text-sm font-black ${abaLote === 'FILA' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500'}`}>Fila ({itensFilaLote.length})</button>
            <button type="button" onClick={() => setAbaLote('CONCLUIDOS')} className={`border-b-2 px-4 py-3 text-sm font-black ${abaLote === 'CONCLUIDOS' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500'}`}>Concluídos ({itensConcluidosLote.length})</button>
          </div>

          <div className="mt-3 max-h-[430px] space-y-2 overflow-auto pr-1">
            {itensExibidosLote.map(item => <article key={item.id} className={`flex flex-wrap items-center gap-3 rounded-2xl border p-3 ${item.status === 'PROCESSANDO' ? 'border-violet-300 bg-violet-50' : item.status === 'CONCLUIDO' ? 'border-emerald-200 bg-emerald-50' : item.status === 'IGNORADO' ? 'border-amber-200 bg-amber-50' : item.status === 'FALHA' || item.status === 'REVISAO' ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-900 text-xs font-black text-white">{item.posicao}</span>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-950"><span className="font-mono text-cyan-700">{item.codigo}</span> · {item.produto}</p><p className="mt-1 text-xs font-semibold text-slate-600">{item.motivo || item.etapa.replaceAll('_', ' ')}</p></div>
              <span className="rounded-full bg-white px-3 py-1 text-[10px] font-black uppercase text-slate-700 shadow-sm">{item.status.replaceAll('_', ' ')}</span>
            </article>)}
            {!itensExibidosLote.length && <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm font-semibold text-slate-500">Nenhum produto nesta aba.</div>}
          </div>
        </div> : <div className="p-8 text-center"><p className="text-sm font-bold text-slate-600">Selecione os produtos na lista abaixo e crie a primeira fila.</p></div>}
      </section>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_35px_rgba(15,23,42,.05)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div><p className="text-xs font-black uppercase tracking-wider text-cyan-700">Produtos do filtro</p><p className="mt-1 text-sm text-slate-500"><strong className="text-slate-900">{produtosComFiltroDeFoto.length}</strong> exibidos de {produtos.length}{truncado ? ' · limite seguro atingido' : ''}</p></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setSomenteComFotos(valor => !valor); setPagina(1); }} className={`rounded-xl px-3 py-2 text-xs font-black ${somenteComFotos ? 'bg-emerald-100 text-emerald-800' : 'border border-slate-300 text-slate-700'}`}>{somenteComFotos ? '✓ Somente com fotos' : 'Mostrar somente com fotos'}</button>
            <button type="button" onClick={() => baixarProdutos(produtosComFiltroDeFoto, categorias)} disabled={!produtosComFiltroDeFoto.length} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40">Exportar para balanço</button>
            <button type="button" onClick={diagnosticarPagina} disabled={!visiveis.length || diagnosticando} className="rounded-xl bg-amber-100 px-3 py-2 text-xs font-black text-amber-900 disabled:opacity-40">{diagnosticando ? 'Conferindo no Bling…' : 'Conferir estoque, fotos e canais'}</button>
          </div>
        </div>
        {truncado && <div role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs font-semibold text-amber-900">A consulta parou em 2.000 produtos. Refine por categoria para obter um balanço completo.</div>}
        {produtos.length > 0 && <div className="border-b border-blue-100 bg-blue-50/70 px-5 py-2.5 text-xs font-semibold text-blue-800">Estoque, fotos e canais são conferidos para os 50 produtos da página visível. Use o botão acima em cada página.</div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead><tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500"><th className="px-4 py-3"><input type="checkbox" aria-label="Selecionar página" checked={Boolean(visiveis.length) && visiveis.every(item => Boolean(selecionadosLote[item.id]))} onChange={evento => evento.target.checked ? selecionarProdutosLote(visiveis) : setSelecionadosLote(atual => { const proximo = { ...atual }; visiveis.forEach(item => delete proximo[item.id]); return proximo; })} disabled={loteAberto} className="h-4 w-4 accent-blue-600" /></th><th className="px-5 py-3">SKU / produto</th><th className="px-4 py-3">Categoria atual</th><th className="px-4 py-3">Estoque</th><th className="px-4 py-3">Tem foto</th><th className="px-4 py-3">Canais</th><th className="px-5 py-3 text-right">Ação</th></tr></thead>
            <tbody>{visiveis.map(item => {
              const diagnostico = diagnosticos[item.id];
              return <tr key={item.id} className={`border-t border-slate-100 ${diagnostico?.alerta ? 'bg-rose-50/70' : produtoAberto === item.id ? 'bg-cyan-50' : ''}`}>
                <td className="px-4 py-3"><input type="checkbox" aria-label={`Selecionar ${item.codigo}`} checked={Boolean(selecionadosLote[item.id])} onChange={() => alternarSelecaoLote(item)} disabled={loteAberto || (!selecionadosLote[item.id] && quantidadeSelecionada >= 500)} className="h-4 w-4 accent-blue-600" /></td>
                <td className="px-5 py-3"><span className="font-mono text-xs font-black text-cyan-700">{item.codigo}</span><span className="mt-1 block max-w-xl font-bold text-slate-900">{item.nome}</span>{diagnostico?.alerta && <span className="mt-1 inline-block rounded-full bg-rose-100 px-2 py-1 text-[10px] font-black uppercase text-rose-700">Com estoque, sem foto e fora dos canais</span>}</td>
                <td className="px-4 py-3 text-slate-600">{porId.get(Number(item.categoria?.id))?.descricao || <span className="font-semibold text-amber-700">Categoria não informada</span>}</td>
                <td className="px-4 py-3 font-bold">{diagnostico ? diagnostico.saldoFisico.toLocaleString('pt-BR') : aguardandoDiagnostico}</td>
                <td className="px-4 py-3">{diagnostico ? (diagnostico.quantidadeImagens ? <span className="font-bold text-emerald-700">Sim</span> : <span className="font-bold text-rose-700">Não</span>) : aguardandoDiagnostico}</td>
                <td className="px-4 py-3">{diagnostico ? (diagnostico.canalConferido ? diagnostico.quantidadeCanais : <span className="font-bold text-amber-700">Não verificado</span>) : aguardandoDiagnostico}</td>
                <td className="px-5 py-3 text-right"><div className="flex justify-end gap-2"><button type="button" onClick={() => void abrirTesteDeFotos(item)} disabled={preparandoTeste || removendoImagens || aplicandoImagens} className="rounded-lg bg-violet-100 px-3 py-2 text-xs font-black text-violet-800 disabled:opacity-40">Testar fotos</button><button type="button" onClick={() => aoAbrir(item)} className="rounded-lg bg-[#071a24] px-3 py-2 text-xs font-black text-white">Abrir editor</button></div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {!carregando && !produtosComFiltroDeFoto.length && <div className="grid min-h-40 place-items-center px-5 text-center text-sm text-slate-500">{produtos.length ? 'Nenhum dos produtos deste nível possui foto no resumo do Bling.' : 'Nenhum produto foi encontrado neste nível.'}</div>}
        {produtosComFiltroDeFoto.length > porPagina && <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm"><button type="button" onClick={() => setPagina(valor => Math.max(1, valor - 1))} disabled={paginaSegura === 1} className="font-black text-blue-700 disabled:text-slate-300">Anterior</button><span className="text-slate-500">Página {paginaSegura} de {totalPaginas}</span><button type="button" onClick={() => setPagina(valor => Math.min(totalPaginas, valor + 1))} disabled={paginaSegura === totalPaginas} className="font-black text-blue-700 disabled:text-slate-300">Próxima</button></div>}
      </div>
    </div>
  );
}
