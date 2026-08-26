'use client';

import { useEffect, useMemo, useState } from 'react';

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

type Props = {
  categorias: CategoriaCatalogo[];
  produtoAberto?: number;
  aoAbrir: (produto: ProdutoCatalogo) => void;
  aoErro: (mensagem: string) => void;
};

async function jsonDaResposta(resposta: Response) {
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.erro) throw new Error(dados.erro || `HTTP ${resposta.status}`);
  return dados;
}

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
    ...produtos.map(item => [item.codigo, item.nome, porId.get(Number(item.categoria?.id)) || 'Sem categoria', item.situacao || '']),
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

  const segmentoAtualId = segmentoId;
  const categoriasDoSegmento = useMemo(() => segmentoAtualId ? filhosDe(segmentoAtualId, categorias) : [], [categorias, segmentoAtualId]);
  const subcategorias = useMemo(() => categoriaId ? filhosDe(categoriaId, categorias) : [], [categorias, categoriaId]);
  const nivelId = subcategoriaId || categoriaId || segmentoAtualId;
  const idsConsulta = useMemo(() => nivelId
    ? (somenteNivel ? [nivelId] : idsDaArvore(nivelId, categorias))
    : [], [categorias, nivelId, somenteNivel]);
  const porId = useMemo(() => new Map(categorias.map(item => [item.id, item])), [categorias]);
  const trilha = [segmentoAtualId, categoriaId, subcategoriaId].filter(Boolean).map(id => porId.get(Number(id))?.descricao).filter(Boolean).join(' › ');

  const consultar = async () => {
    if (!idsConsulta.length) return;
    setCarregando(true);
    setProdutos([]);
    setPagina(1);
    setDiagnosticos({});
    aoErro('');
    try {
      const parametros = new URLSearchParams({ recurso: 'produtos', categorias: idsConsulta.join(',') });
      if (busca.trim()) parametros.set('q', busca.trim());
      const dados = await jsonDaResposta(await fetch(`/api/bling/administracao?${parametros}`));
      setProdutos(dados.produtos || []);
      setTruncado(Boolean(dados.truncado));
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível consultar os produtos.');
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    if (!idsConsulta.length) return;
    const atraso = window.setTimeout(() => { void consultar(); }, 80);
    return () => window.clearTimeout(atraso);
    // A busca textual só é aplicada ao confirmar; a navegação hierárquica é automática.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsConsulta.join(',')]);

  const porPagina = 50;
  const totalPaginas = Math.max(1, Math.ceil(produtos.length / porPagina));
  const visiveis = produtos.slice((pagina - 1) * porPagina, pagina * porPagina);

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

  const selecionarSegmento = (id: number) => {
    setSegmentoId(id);
    setCategoriaId(undefined);
    setSubcategoriaId(undefined);
    setSomenteNivel(false);
  };

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

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_35px_rgba(15,23,42,.05)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div><p className="text-xs font-black uppercase tracking-wider text-cyan-700">Produtos do filtro</p><p className="mt-1 text-sm text-slate-500"><strong className="text-slate-900">{produtos.length}</strong> encontrados{truncado ? ' · limite seguro atingido' : ''}</p></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => baixarProdutos(produtos, categorias)} disabled={!produtos.length} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40">Exportar para balanço</button>
            <button type="button" onClick={diagnosticarPagina} disabled={!visiveis.length || diagnosticando} className="rounded-xl bg-amber-100 px-3 py-2 text-xs font-black text-amber-900 disabled:opacity-40">{diagnosticando ? 'Conferindo no Bling…' : 'Conferir estoque, fotos e canais'}</button>
          </div>
        </div>
        {truncado && <div role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs font-semibold text-amber-900">A consulta parou em 2.000 produtos. Refine por categoria para obter um balanço completo.</div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead><tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500"><th className="px-5 py-3">SKU / produto</th><th className="px-4 py-3">Categoria atual</th><th className="px-4 py-3">Estoque</th><th className="px-4 py-3">Tem foto</th><th className="px-4 py-3">Canais</th><th className="px-5 py-3 text-right">Ação</th></tr></thead>
            <tbody>{visiveis.map(item => {
              const diagnostico = diagnosticos[item.id];
              return <tr key={item.id} className={`border-t border-slate-100 ${diagnostico?.alerta ? 'bg-rose-50/70' : produtoAberto === item.id ? 'bg-cyan-50' : ''}`}>
                <td className="px-5 py-3"><span className="font-mono text-xs font-black text-cyan-700">{item.codigo}</span><span className="mt-1 block max-w-xl font-bold text-slate-900">{item.nome}</span>{diagnostico?.alerta && <span className="mt-1 inline-block rounded-full bg-rose-100 px-2 py-1 text-[10px] font-black uppercase text-rose-700">Com estoque, sem foto e fora dos canais</span>}</td>
                <td className="px-4 py-3 text-slate-600">{porId.get(Number(item.categoria?.id))?.descricao || 'Sem categoria'}</td>
                <td className="px-4 py-3 font-bold">{diagnostico ? diagnostico.saldoFisico.toLocaleString('pt-BR') : '—'}</td>
                <td className="px-4 py-3">{diagnostico ? (diagnostico.quantidadeImagens ? <span className="font-bold text-emerald-700">Sim</span> : <span className="font-bold text-rose-700">Não</span>) : '—'}</td>
                <td className="px-4 py-3">{diagnostico ? (diagnostico.canalConferido ? diagnostico.quantidadeCanais : <span className="font-bold text-amber-700">Não verificado</span>) : '—'}</td>
                <td className="px-5 py-3 text-right"><button type="button" onClick={() => aoAbrir(item)} className="rounded-lg bg-[#071a24] px-3 py-2 text-xs font-black text-white">Abrir editor</button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {!carregando && !produtos.length && <div className="grid min-h-40 place-items-center px-5 text-center text-sm text-slate-500">Nenhum produto foi encontrado neste nível.</div>}
        {produtos.length > porPagina && <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm"><button type="button" onClick={() => setPagina(valor => Math.max(1, valor - 1))} disabled={pagina === 1} className="font-black text-blue-700 disabled:text-slate-300">Anterior</button><span className="text-slate-500">Página {pagina} de {totalPaginas}</span><button type="button" onClick={() => setPagina(valor => Math.min(totalPaginas, valor + 1))} disabled={pagina === totalPaginas} className="font-black text-blue-700 disabled:text-slate-300">Próxima</button></div>}
      </div>
    </div>
  );
}
