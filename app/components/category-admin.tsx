'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CategoryBrowser, type CategoriaCatalogo, type ProdutoCatalogo } from './category-browser';
import { StorePublication } from './store-publication';

type Categoria = CategoriaCatalogo;
type Canal = { id: number; descricao: string; tipo: string; situacao: number };
type Modulo = { id: number; nome: string; modulo: string };
type TipoCampo = { id: number; nome: string; mascara?: string };
type Campo = { id: number; nome: string; situacao?: number };
type ProdutoLista = ProdutoCatalogo;
type ValorCampo = { idCampoCustomizado: number; idVinculo?: number; valor?: string; item?: string };
type Produto = ProdutoLista & { categoria?: { id?: number }; camposCustomizados?: ValorCampo[] };
type CategoriaCanal = { id: string | number; nome: string };
type Atributo = { id: string | number; nome: string; obrigatorio?: boolean; tipo?: string; unidadePadrao?: string; minimo?: number; maximo?: number };
type SimulacaoProduto = { simulacao: string; produto: ProdutoLista; antes: { categoria?: { id?: number } }; depois: { categoria?: { id?: number } }; corpoPatch: Record<string, unknown> };
type SimulacaoCampo = { simulacao: string; corpo: Record<string, unknown> };

const cartao = 'rounded-2xl border border-slate-200 bg-white shadow-[0_10px_35px_rgba(15,23,42,.05)]';

async function jsonDaResposta(resposta: Response) {
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.erro) throw new Error(dados.erro || `HTTP ${resposta.status}`);
  return dados;
}

function baixarCategorias(categorias: Categoria[]) {
  const linhas = [['id', 'categoria', 'id_categoria_pai'], ...categorias.map(item => [String(item.id), item.descricao, String(item.categoriaPai?.id || '')])];
  const csv = linhas.map(linha => linha.map(valor => {
    const seguro = /^[=+\-@]/.test(valor) ? `'${valor}` : valor;
    return `"${seguro.replaceAll('"', '""')}"`;
  }).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `categorias-bling-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function nomeCategoria(id: number | undefined, categorias: Categoria[]) {
  return categorias.find(categoria => categoria.id === id)?.descricao || (id ? `Categoria ${id}` : 'Sem categoria');
}

function caminhoCategoria(id: number, categorias: Categoria[]) {
  const porId = new Map(categorias.map(item => [item.id, item]));
  const partes: string[] = [];
  const visitados = new Set<number>();
  let atual = porId.get(id);
  while (atual && !visitados.has(atual.id)) {
    visitados.add(atual.id);
    partes.unshift(atual.descricao);
    atual = porId.get(Number(atual.categoriaPai?.id || 0));
  }
  return partes.join(' › ');
}

export function CategoryAdminView() {
  const [secao, setSecao] = useState<'editor' | 'publicacao' | 'campos' | 'canais'>('editor');
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [canais, setCanais] = useState<Canal[]>([]);
  const [modulos, setModulos] = useState<Modulo[]>([]);
  const [tipos, setTipos] = useState<TipoCampo[]>([]);
  const [campos, setCampos] = useState<Campo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [mensagem, setMensagem] = useState('');
  const [erro, setErro] = useState('');

  const [produto, setProduto] = useState<Produto | null>(null);
  const [categoriaNova, setCategoriaNova] = useState('');
  const [valoresCampos, setValoresCampos] = useState<Record<number, string>>({});
  const [simulacaoProduto, setSimulacaoProduto] = useState<SimulacaoProduto | null>(null);
  const [confirmacaoProduto, setConfirmacaoProduto] = useState('');
  const [gravando, setGravando] = useState(false);

  const [novoCampo, setNovoCampo] = useState({ nome: '', idCategoria: '', idTipo: '', placeholder: '', minimo: '0', maximo: '255', obrigatorio: false });
  const [simulacaoCampo, setSimulacaoCampo] = useState<SimulacaoCampo | null>(null);
  const [confirmacaoCampo, setConfirmacaoCampo] = useState('');

  const [canalSelecionado, setCanalSelecionado] = useState('');
  const [categoriasCanal, setCategoriasCanal] = useState<CategoriaCanal[]>([]);
  const [categoriaCanal, setCategoriaCanal] = useState('');
  const [atributos, setAtributos] = useState<Atributo[]>([]);
  const [trilhaCanal, setTrilhaCanal] = useState<CategoriaCanal[]>([]);

  const moduloProdutos = useMemo(() => modulos.find(modulo => /produto/i.test(`${modulo.nome} ${modulo.modulo}`)), [modulos]);
  const categoriasOrdenadas = useMemo(() => [...categorias].sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR')), [categorias]);
  const canaisMarketplace = useMemo(() => canais.filter(canal => /mercado.?livre|shopee|amazon/i.test(`${canal.tipo} ${canal.descricao}`)), [canais]);

  const carregarResumo = useCallback(async () => {
    setCarregando(true); setErro(''); setMensagem('');
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/administracao?recurso=resumo'));
      setCategorias(dados.categorias || []);
      setCanais(dados.canais || []);
      setModulos(dados.modulos || []);
      setTipos(dados.tipos || []);
      const aviso = Array.isArray(dados.avisos) && dados.avisos.length ? ` Avisos de permissão: ${dados.avisos.join(' | ')}` : '';
      setMensagem(`${(dados.categorias || []).length} categorias importadas do Bling. Nenhuma informação foi alterada.${aviso}`);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível consultar o Bling.'); }
    finally { setCarregando(false); }
  }, []);

  useEffect(() => {
    const quadro = requestAnimationFrame(() => { void carregarResumo(); });
    return () => cancelAnimationFrame(quadro);
  }, [carregarResumo]);

  useEffect(() => {
    if (!moduloProdutos) return;
    fetch(`/api/bling/administracao?recurso=campos&modulo=${moduloProdutos.id}`)
      .then(jsonDaResposta).then(dados => setCampos(dados.campos || []))
      .catch(e => setErro(e instanceof Error ? e.message : 'Não foi possível carregar os campos.'));
  }, [moduloProdutos]);

  const abrirProduto = async (item: ProdutoLista) => {
    setErro(''); setMensagem(''); setSimulacaoProduto(null); setConfirmacaoProduto('');
    try {
      const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?recurso=produto&id=${item.id}`));
      const completo = dados.produto as Produto;
      setProduto(completo);
      setCategoriaNova(String(completo.categoria?.id || ''));
      setValoresCampos(Object.fromEntries((completo.camposCustomizados || []).map(campo => [campo.idCampoCustomizado, campo.valor || campo.item || ''])));
    } catch (e) { setErro(e instanceof Error ? e.message : 'Falha ao abrir produto.'); }
  };

  const simularProduto = async () => {
    if (!produto) return;
    setGravando(true); setErro(''); setMensagem(''); setSimulacaoProduto(null);
    const alteracoes = campos.flatMap(campo => {
      const atual = (produto.camposCustomizados || []).find(valor => valor.idCampoCustomizado === campo.id);
      const novoValor = String(valoresCampos[campo.id] || '').trim();
      const valorAtual = String(atual?.valor || atual?.item || '');
      if (!novoValor || novoValor === valorAtual) return [];
      return [{ idCampoCustomizado: campo.id, ...(atual?.item !== undefined && atual?.valor === undefined ? { item: novoValor } : { valor: novoValor }) }];
    });
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'simular-produto', idProduto: produto.id, idCategoria: categoriaNova, campos: alteracoes }),
      }));
      setSimulacaoProduto(dados);
      setMensagem('Simulação pronta. Confira o resumo e digite o SKU somente se estiver correto.');
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível simular.'); }
    finally { setGravando(false); }
  };

  const aplicarProduto = async () => {
    if (!simulacaoProduto) return;
    setGravando(true); setErro(''); setMensagem('');
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'aplicar-produto', simulacao: simulacaoProduto.simulacao, confirmacao: confirmacaoProduto }),
      }));
      setMensagem(`Produto ${dados.produto.codigo} conferido e atualizado somente em categoria/campos customizados.`);
      setSimulacaoProduto(null); setConfirmacaoProduto('');
      await abrirProduto(dados.produto);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível aplicar.'); }
    finally { setGravando(false); }
  };

  const simularNovoCampo = async () => {
    if (!moduloProdutos) { setErro('O módulo de Produtos não foi localizado no Bling.'); return; }
    setGravando(true); setErro(''); setMensagem(''); setSimulacaoCampo(null);
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'simular-campo', idModulo: moduloProdutos.id, ...novoCampo }),
      }));
      setSimulacaoCampo(dados); setMensagem('Definição validada. Digite o nome do campo para criá-lo no Bling.');
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível validar o campo.'); }
    finally { setGravando(false); }
  };

  const criarCampo = async () => {
    if (!simulacaoCampo) return;
    setGravando(true); setErro(''); setMensagem('');
    try {
      await jsonDaResposta(await fetch('/api/bling/administracao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'criar-campo', simulacao: simulacaoCampo.simulacao, confirmacao: confirmacaoCampo }),
      }));
      setMensagem(`Campo “${novoCampo.nome}” criado e vinculado à categoria escolhida.`);
      setSimulacaoCampo(null); setConfirmacaoCampo(''); setNovoCampo({ nome: '', idCategoria: '', idTipo: '', placeholder: '', minimo: '0', maximo: '255', obrigatorio: false });
      if (moduloProdutos) {
        const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?recurso=campos&modulo=${moduloProdutos.id}`));
        setCampos(dados.campos || []);
      }
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível criar o campo.'); }
    finally { setGravando(false); }
  };

  const carregarCategoriasCanal = async (pai?: CategoriaCanal) => {
    const canal = canaisMarketplace.find(item => String(item.id) === canalSelecionado);
    if (!canal) return;
    setErro(''); setCategoriasCanal([]); setAtributos([]); setCategoriaCanal('');
    try {
      const parametros = new URLSearchParams({ recurso: 'categorias-marketplace', loja: String(canal.id), integracao: canal.tipo });
      if (pai) parametros.set('pai', String(pai.id));
      const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?${parametros}`));
      setCategoriasCanal(dados.categorias || []);
      setTrilhaCanal(atual => pai ? [...atual, pai] : []);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível consultar o canal.'); }
  };

  const carregarAtributos = async (idCategoria: string) => {
    const canal = canaisMarketplace.find(item => String(item.id) === canalSelecionado);
    setCategoriaCanal(idCategoria); setAtributos([]); setErro('');
    if (!canal || !idCategoria) return;
    try {
      const parametros = new URLSearchParams({ recurso: 'atributos', loja: String(canal.id), integracao: canal.tipo, categoria: idCategoria });
      const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?${parametros}`));
      setAtributos(Array.isArray(dados.atributos) ? dados.atributos : Object.values(dados.atributos || {}));
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível consultar os atributos.'); }
  };

  return (
    <section className="space-y-6">
      <div className="overflow-hidden rounded-[28px] bg-[linear-gradient(125deg,#071a24,#0b3445_58%,#0c5263)] p-6 text-white shadow-[0_24px_70px_rgba(7,26,36,.20)] md:p-8">
        <p className="text-xs font-black uppercase tracking-[.22em] text-cyan-300">Administração do catálogo</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
          <div><h2 className="max-w-3xl text-3xl font-black tracking-tight md:text-4xl">Categorias, lojas e marketplaces</h2><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">Organize o catálogo, prepare um segmento por vez para a loja virtual e consulte os atributos dos marketplaces.</p></div>
          <button type="button" onClick={carregarResumo} disabled={carregando || gravando} className="rounded-xl bg-cyan-300 px-5 py-3 text-sm font-black text-[#071a24] disabled:opacity-50">{carregando ? 'Importando…' : 'Atualizar do Bling'}</button>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-950"><strong>Proteção ativa:</strong> o cadastro principal nunca usa PUT. Categoria e campos do produto continuam limitados a PATCH; a publicação em lote altera somente o recurso separado de vínculo produto–loja, sempre após simulação, auditoria e conferência posterior.</div>
      {erro && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-800">{erro}</div>}
      {mensagem && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{mensagem}</div>}

      <div className="flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {([['editor','Editor de produtos'],['publicacao','Publicação em lote'],['campos','Campos customizados'],['canais','Mercado Livre, Shopee e Amazon']] as const).map(([id, rotulo]) => <button key={id} type="button" onClick={() => setSecao(id)} className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-black ${secao === id ? 'bg-[#071a24] text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{rotulo}</button>)}
      </div>

      {secao === 'editor' && <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-black uppercase tracking-wider text-cyan-700">Mapa do catálogo</p><h3 className="mt-1 text-2xl font-black">Segmento, categoria e subcategoria</h3></div>
          <button type="button" onClick={() => baixarCategorias(categorias)} className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-black text-blue-700">Exportar árvore CSV</button>
        </div>
        <CategoryBrowser categorias={categorias} produtoAberto={produto?.id} aoAbrir={abrirProduto} aoErro={setErro} />
        <div className={`${cartao} p-5 md:p-7`}>
          {!produto ? <div className="grid min-h-96 place-items-center text-center text-sm text-slate-500"><div><p className="text-lg font-black text-slate-800">Selecione um produto</p><p className="mt-2">A categoria atual e os campos serão lidos diretamente do Bling.</p></div></div> : <>
            <div className="border-b border-slate-200 pb-5"><p className="font-mono text-xs font-black text-cyan-700">{produto.codigo}</p><h3 className="mt-1 text-2xl font-black">{produto.nome}</h3><p className="mt-2 text-sm text-slate-500">Atual: {nomeCategoria(produto.categoria?.id, categorias)}</p></div>
            <label className="mt-6 block text-sm font-black">Mover para segmento/categoria/subcategoria<select value={categoriaNova} onChange={e => { setCategoriaNova(e.target.value); setSimulacaoProduto(null); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm"><option value="">Selecione</option>{categoriasOrdenadas.map(c => <option key={c.id} value={c.id}>{caminhoCategoria(c.id, categorias)}</option>)}</select></label>
            <div className="mt-7"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wider text-blue-700">Produto</p><h4 className="mt-1 text-lg font-black">Campos customizados</h4></div><span className="text-xs text-slate-500">{campos.length} cadastrados</span></div><div className="mt-4 grid gap-4 md:grid-cols-2">{campos.filter(c => c.situacao !== 0).map(campo => <label key={campo.id} className="text-xs font-black uppercase tracking-wide text-slate-500">{campo.nome}<input value={valoresCampos[campo.id] || ''} onChange={e => { setValoresCampos(v => ({ ...v, [campo.id]: e.target.value })); setSimulacaoProduto(null); }} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm font-normal normal-case" /></label>)}</div></div>
            <div className="mt-7 flex justify-end"><button type="button" onClick={simularProduto} disabled={gravando} className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-black text-white disabled:opacity-50">{gravando ? 'Conferindo…' : 'Simular alteração'}</button></div>
            {simulacaoProduto && <div className="mt-6 rounded-2xl border-2 border-amber-300 bg-amber-50 p-5"><p className="text-xs font-black uppercase tracking-wider text-amber-700">Simulação — nenhuma gravação ainda</p><h4 className="mt-2 text-lg font-black">Corpo PATCH limitado</h4><pre className="mt-3 max-h-52 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-emerald-300">{JSON.stringify(simulacaoProduto.corpoPatch, null, 2)}</pre><p className="mt-4 text-sm font-semibold">Para aplicar, digite o SKU <strong>{produto.codigo}</strong>:</p><div className="mt-3 flex flex-wrap gap-2"><input value={confirmacaoProduto} onChange={e => setConfirmacaoProduto(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-amber-300 bg-white px-4 py-3 font-mono text-sm" /><button type="button" onClick={aplicarProduto} disabled={gravando || confirmacaoProduto !== produto.codigo} className="rounded-xl bg-amber-600 px-5 py-3 text-sm font-black text-white disabled:opacity-40">Aplicar no Bling</button></div></div>}
          </>}
        </div>
      </div>}

      {secao === 'publicacao' && <StorePublication categorias={categorias} canais={canais} aoErro={setErro} aoMensagem={setMensagem} />}

      {secao === 'campos' && <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className={`${cartao} p-6`}><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wider text-cyan-700">Importados do Bling</p><h3 className="mt-1 text-xl font-black">Campos do módulo Produtos</h3></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black">{campos.length}</span></div><div className="mt-5 divide-y divide-slate-100">{campos.map(campo => <div key={campo.id} className="flex items-center justify-between gap-4 py-3"><div><p className="font-bold">{campo.nome}</p><p className="font-mono text-xs text-slate-400">ID {campo.id}</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${campo.situacao === 0 ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>{campo.situacao === 0 ? 'Inativo' : 'Ativo'}</span></div>)}</div></div>
        <div className={`${cartao} p-6`}><p className="text-xs font-black uppercase tracking-wider text-blue-700">Novo campo</p><h3 className="mt-1 text-xl font-black">Vincular a uma categoria</h3><p className="mt-2 text-xs leading-5 text-slate-500">O agrupador enviado será somente a categoria escolhida.</p>
          <div className="mt-5 space-y-4"><label className="block text-xs font-black uppercase text-slate-500">Nome<input value={novoCampo.nome} onChange={e => { setNovoCampo(v => ({ ...v, nome: e.target.value })); setSimulacaoCampo(null); }} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm font-normal normal-case" /></label><label className="block text-xs font-black uppercase text-slate-500">Categoria<select value={novoCampo.idCategoria} onChange={e => { setNovoCampo(v => ({ ...v, idCategoria: e.target.value })); setSimulacaoCampo(null); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-normal normal-case"><option value="">Selecione</option>{categoriasOrdenadas.map(c => <option key={c.id} value={c.id}>{c.descricao}</option>)}</select></label><label className="block text-xs font-black uppercase text-slate-500">Tipo<select value={novoCampo.idTipo} onChange={e => { setNovoCampo(v => ({ ...v, idTipo: e.target.value })); setSimulacaoCampo(null); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-normal normal-case"><option value="">Selecione</option>{tipos.map(tipo => <option key={tipo.id} value={tipo.id}>{tipo.nome}</option>)}</select></label><label className="block text-xs font-black uppercase text-slate-500">Orientação<input value={novoCampo.placeholder} onChange={e => setNovoCampo(v => ({ ...v, placeholder: e.target.value }))} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm font-normal normal-case" /></label><label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={novoCampo.obrigatorio} onChange={e => setNovoCampo(v => ({ ...v, obrigatorio: e.target.checked }))} /> Obrigatório no Bling</label><button type="button" onClick={simularNovoCampo} disabled={gravando || !novoCampo.nome || !novoCampo.idCategoria || !novoCampo.idTipo} className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-black text-white disabled:opacity-40">Validar definição</button></div>
          {simulacaoCampo && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-xs font-bold text-amber-900">Digite exatamente “{novoCampo.nome}”:</p><input value={confirmacaoCampo} onChange={e => setConfirmacaoCampo(e.target.value)} className="mt-2 w-full rounded-lg border border-amber-300 px-3 py-2.5 text-sm" /><button type="button" onClick={criarCampo} disabled={gravando || confirmacaoCampo !== novoCampo.nome} className="mt-3 w-full rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">Criar no Bling</button></div>}
        </div>
      </div>}

      {secao === 'canais' && <div className="grid gap-5 xl:grid-cols-[380px_1fr]">
        <aside className={`${cartao} p-6`}><p className="text-xs font-black uppercase tracking-wider text-cyan-700">Canais habilitados</p><h3 className="mt-1 text-xl font-black">Consultar categoria externa</h3><p className="mt-2 text-xs leading-5 text-slate-500">A lista vem da conta conectada. O sistema não presume IDs nem cria atributos por adivinhação.</p><label className="mt-5 block text-xs font-black uppercase text-slate-500">Loja/canal<select value={canalSelecionado} onChange={e => { setCanalSelecionado(e.target.value); setCategoriasCanal([]); setAtributos([]); setTrilhaCanal([]); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-normal normal-case"><option value="">Selecione</option>{canaisMarketplace.map(canal => <option key={canal.id} value={canal.id}>{canal.tipo} · {canal.descricao}</option>)}</select></label><button type="button" onClick={() => carregarCategoriasCanal()} disabled={!canalSelecionado} className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-black text-white disabled:opacity-40">Buscar categorias do canal</button>{trilhaCanal.length > 0 && <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"><span className="font-bold">Nível:</span> {trilhaCanal.map(item => item.nome).join(' › ')}<button type="button" onClick={() => carregarCategoriasCanal()} className="mt-1 block font-black text-blue-700">Voltar ao início</button></div>}<label className="mt-5 block text-xs font-black uppercase text-slate-500">Categoria do canal<select value={categoriaCanal} onChange={e => carregarAtributos(e.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-normal normal-case"><option value="">Selecione</option>{categoriasCanal.map(categoria => <option key={String(categoria.id)} value={String(categoria.id)}>{categoria.nome}</option>)}</select></label>{categoriaCanal && <button type="button" onClick={() => { const atual = categoriasCanal.find(item => String(item.id) === categoriaCanal); if (atual) void carregarCategoriasCanal(atual); }} className="mt-3 w-full rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-black text-blue-700">Abrir subcategorias</button>}</aside>
        <div className={`${cartao} p-6`}><div><p className="text-xs font-black uppercase tracking-wider text-blue-700">Ficha do marketplace</p><h3 className="mt-1 text-xl font-black">Atributos oficiais da categoria</h3><p className="mt-2 text-sm text-slate-500">Use esta relação para decidir quais campos customizados precisam existir no Bling.</p></div>{!categoriaCanal ? <div className="grid min-h-72 place-items-center text-sm text-slate-500">Selecione um canal e uma categoria.</div> : <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><th className="px-3 py-3">Atributo</th><th className="px-3 py-3">Obrigatório</th><th className="px-3 py-3">Tipo</th><th className="px-3 py-3">Regra</th></tr></thead><tbody>{atributos.map(atributo => <tr key={String(atributo.id)} className="border-b border-slate-100"><td className="px-3 py-3 font-bold">{atributo.nome}<span className="ml-2 font-mono text-xs font-normal text-slate-400">{atributo.id}</span></td><td className="px-3 py-3">{atributo.obrigatorio ? <span className="rounded-full bg-rose-50 px-2 py-1 text-xs font-black text-rose-700">Sim</span> : 'Não'}</td><td className="px-3 py-3">{atributo.tipo || '—'}</td><td className="px-3 py-3 text-slate-500">{[atributo.unidadePadrao, atributo.minimo !== undefined ? `mín. ${atributo.minimo}` : '', atributo.maximo !== undefined ? `máx. ${atributo.maximo}` : ''].filter(Boolean).join(' · ') || '—'}</td></tr>)}</tbody></table>{atributos.length === 0 && <p className="py-10 text-center text-sm text-slate-500">O canal não devolveu atributos para esta categoria.</p>}</div>}</div>
      </div>}
    </section>
  );
}
