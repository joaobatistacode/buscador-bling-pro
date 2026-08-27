'use client';

import { useMemo, useRef, useState } from 'react';
import type { CategoriaCatalogo } from './category-browser';

type Canal = { id: number; descricao: string; tipo: string; situacao: number };
type Execucao = {
  id: string;
  id_segmento_bling: number;
  segmento: string;
  id_loja_bling: number;
  loja: string;
  status: string;
  total: number;
  pendentes: number;
  corretos: number;
  bloqueados: number;
  concluidos: number;
  falhas: number;
  created_at: string;
};
type Item = {
  id: string;
  codigo: string;
  produto: string;
  categoria?: string | null;
  acao: string;
  status: string;
  motivo?: string | null;
};
type DiagnosticoCategoria = {
  idProduto: number;
  codigo: string;
  produto: string;
  categoria?: string | null;
  idCategoriaInterna: number;
  idMapeamento: number | null;
  idCategoriaNoMapeamento: number | null;
  idVinculo: number | null;
  idsNoVinculo: number[];
  situacao: 'SEM_VINCULO' | 'SEM_CATEGORIA' | 'USA_ID_INTERNO' | 'USA_ID_VINCULO_LOJA' | 'OUTRO_ID';
};

type Props = {
  categorias: CategoriaCatalogo[];
  canais: Canal[];
  aoErro: (mensagem: string) => void;
  aoMensagem: (mensagem: string) => void;
};

async function jsonDaResposta(resposta: Response) {
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.erro) throw new Error(dados.erro || `HTTP ${resposta.status}`);
  return dados;
}

const numero = new Intl.NumberFormat('pt-BR');

function selo(status: string) {
  if (status === 'CONCLUIDO' || status === 'CORRETO' || status === 'FINALIZADO') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'BLOQUEADO' || status === 'FALHA' || status === 'REVISAO') return 'bg-rose-50 text-rose-700 ring-rose-200';
  if (status === 'PROCESSANDO' || status === 'EM_ANDAMENTO') return 'bg-blue-50 text-blue-700 ring-blue-200';
  return 'bg-amber-50 text-amber-700 ring-amber-200';
}

export function StorePublication({ categorias, canais, aoErro, aoMensagem }: Props) {
  const ids = useMemo(() => new Set(categorias.map(item => item.id)), [categorias]);
  const segmentos = useMemo(() => categorias
    .filter(item => !item.categoriaPai?.id || !ids.has(Number(item.categoriaPai.id)))
    .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR')), [categorias, ids]);
  const lojas = useMemo(() => {
    const ativas = canais.filter(canal => canal.situacao !== 0);
    const lojaBling = ativas.filter(canal => /bling.*loja|loja.*virtual/i.test(`${canal.tipo} ${canal.descricao}`));
    return lojaBling.length ? lojaBling : ativas;
  }, [canais]);

  const [segmentoId, setSegmentoId] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [execucao, setExecucao] = useState<Execucao | null>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [execucoes, setExecucoes] = useState<Execucao[]>([]);
  const [confirmacao, setConfirmacao] = useState('');
  const [diagnosticos, setDiagnosticos] = useState<DiagnosticoCategoria[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [executando, setExecutando] = useState(false);
  const continuarRef = useRef(false);

  const carregarExecucoes = async () => {
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/publicacao?recurso=execucoes'));
      setExecucoes(dados.execucoes || []);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível carregar as execuções.');
    }
  };

  const carregarExecucao = async (id: string) => {
    const dados = await jsonDaResposta(await fetch(`/api/bling/publicacao?recurso=execucao&id=${encodeURIComponent(id)}`));
    setExecucao(dados.execucao || null);
    setItens(dados.itens || []);
    setSegmentoId(String(dados.execucao?.id_segmento_bling || ''));
    setLojaId(String(dados.execucao?.id_loja_bling || ''));
    setConfirmacao('');
    setDiagnosticos([]);
  };

  const simular = async () => {
    const segmento = segmentos.find(item => String(item.id) === segmentoId);
    const loja = lojas.find(item => String(item.id) === lojaId);
    if (!segmento || !loja) { aoErro('Escolha o segmento e a Bling Loja Virtual.'); return; }
    setOcupado(true); aoErro(''); aoMensagem(''); setExecucao(null); setItens([]); setDiagnosticos([]);
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/publicacao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'simular', idSegmento: segmento.id, idLoja: loja.id, loja: `${loja.tipo} · ${loja.descricao}` }),
      }));
      await carregarExecucao(String(dados.execucao.id));
      await carregarExecucoes();
      aoMensagem(`Simulação de ${segmento.descricao} concluída. Nenhum vínculo foi alterado no Bling.`);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível simular o segmento.');
    } finally {
      setOcupado(false);
    }
  };

  const pausar = async () => {
    continuarRef.current = false;
    aoMensagem('Parada solicitada. O lote atual será concluído antes da pausa.');
  };

  const executar = async () => {
    if (!execucao || confirmacao !== execucao.segmento) return;
    continuarRef.current = true;
    setExecutando(true); aoErro(''); aoMensagem('Processamento iniciado em lotes de 10 produtos.');
    try {
      while (continuarRef.current) {
        const dados = await jsonDaResposta(await fetch('/api/bling/publicacao', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acao: 'aplicar-lote', id: execucao.id, confirmacao }),
        }));
        await carregarExecucao(execucao.id);
        if (dados.interrompido) {
          continuarRef.current = false;
          aoErro(`Execução pausada pelo servidor: ${dados.interrompido}`);
          break;
        }
        if (dados.terminou) {
          continuarRef.current = false;
          aoMensagem('Segmento finalizado. Confira os itens bloqueados ou em revisão antes de exportar no Bling.');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      if (!continuarRef.current) {
        await fetch('/api/bling/publicacao', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acao: 'pausar', id: execucao.id }),
        }).catch(() => null);
        await carregarExecucao(execucao.id);
      }
      await carregarExecucoes();
    } catch (erro) {
      continuarRef.current = false;
      aoErro(erro instanceof Error ? erro.message : 'A execução foi interrompida.');
    } finally {
      setExecutando(false);
    }
  };

  const reconciliar = async () => {
    if (!execucao || confirmacao !== execucao.segmento || execucao.falhas === 0) return;
    setOcupado(true); aoErro(''); aoMensagem('Conferindo os itens em revisão sem gravar no Bling…');
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/publicacao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'reconciliar', id: execucao.id, confirmacao }),
      }));
      await carregarExecucao(execucao.id);
      await carregarExecucoes();
      if (dados.interrompido) aoErro(`Conferência interrompida: ${dados.interrompido}`);
      else if (dados.restantes > 0) aoErro(`${dados.confirmados} vínculo(s) confirmado(s); ${dados.restantes} continuam em revisão. O segmento permanece bloqueado.`);
      else aoMensagem(`${dados.confirmados} vínculo(s) confirmado(s) somente por leitura. O segmento pode ser retomado após nova confirmação.`);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível reconciliar os itens.');
    } finally {
      setOcupado(false);
    }
  };

  const diagnosticarCategorias = async () => {
    if (!execucao || confirmacao !== execucao.segmento || execucao.falhas === 0) return;
    setOcupado(true); setDiagnosticos([]); aoErro(''); aoMensagem('Consultando os IDs no Bling sem alterar vínculos ou estados…');
    try {
      const dados = await jsonDaResposta(await fetch('/api/bling/publicacao', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'diagnosticar-categorias', id: execucao.id, confirmacao }),
      }));
      setDiagnosticos(dados.diagnosticos || []);
      aoMensagem(`Diagnóstico somente leitura concluído para ${numero.format(Number(dados.total || 0))} item(ns). Nenhum dado foi alterado.`);
    } catch (erro) {
      aoErro(erro instanceof Error ? erro.message : 'Não foi possível diagnosticar os IDs de categoria.');
    } finally {
      setOcupado(false);
    }
  };

  const bloqueios = useMemo(() => {
    const mapa = new Map<string, number>();
    itens.filter(item => item.status === 'BLOQUEADO').forEach(item => mapa.set(item.categoria || 'Sem categoria', (mapa.get(item.categoria || 'Sem categoria') || 0) + 1));
    return [...mapa.entries()].sort((a, b) => b[1] - a[1]);
  }, [itens]);
  const visiveis = itens.filter(item => item.status !== 'CORRETO').slice(0, 100);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-5">
        <p className="text-xs font-black uppercase tracking-[.18em] text-cyan-800">Execução controlada</p>
        <h3 className="mt-1 text-2xl font-black text-slate-950">Publicar um segmento por vez</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">A simulação lê a estrutura real do Bling, identifica vínculos existentes e bloqueia categorias sem correspondência confirmada. Somente depois da confirmação o sistema trabalha em lotes de 10 produtos.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <label className="text-xs font-black uppercase text-slate-500">Segmento<select value={segmentoId} onChange={e => { setSegmentoId(e.target.value); setExecucao(null); setItens([]); }} disabled={executando} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-bold normal-case"><option value="">Selecione um dos segmentos</option>{segmentos.map(item => <option key={item.id} value={item.id}>{item.descricao}</option>)}</select></label>
          <label className="text-xs font-black uppercase text-slate-500">Loja<select value={lojaId} onChange={e => { setLojaId(e.target.value); setExecucao(null); setItens([]); }} disabled={executando} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-bold normal-case"><option value="">Selecione a Bling Loja Virtual</option>{lojas.map(item => <option key={item.id} value={item.id}>{item.tipo} · {item.descricao}</option>)}</select></label>
          <button type="button" onClick={simular} disabled={ocupado || executando || !segmentoId || !lojaId} className="self-end rounded-xl bg-[#071a24] px-5 py-3 text-sm font-black text-white disabled:opacity-40">{ocupado ? 'Simulando…' : 'Simular segmento'}</button>
        </div>
      </div>

      {execucao && <>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {[
            ['Total', execucao.total, 'text-slate-950'],
            ['Pendentes', execucao.pendentes, 'text-blue-700'],
            ['Já corretos', execucao.corretos, 'text-emerald-700'],
            ['Bloqueados', execucao.bloqueados, 'text-rose-700'],
            ['Concluídos', execucao.concluidos, 'text-cyan-700'],
            ['Falhas', execucao.falhas, 'text-amber-700'],
          ].map(([rotulo, valor, cor]) => <div key={String(rotulo)} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-xs font-bold text-slate-500">{rotulo}</p><p className={`mt-2 text-3xl font-black ${cor}`}>{numero.format(Number(valor))}</p></div>)}
        </div>

        {bloqueios.length > 0 && <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5"><p className="text-sm font-black text-rose-800">Categorias que precisam ser vinculadas uma única vez no Bling</p><p className="mt-1 text-xs leading-5 text-rose-700">Esses produtos não serão alterados até que a API confirme o vínculo da categoria interna com a categoria da loja.</p><div className="mt-3 flex flex-wrap gap-2">{bloqueios.map(([categoria, total]) => <span key={categoria} className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-rose-700 ring-1 ring-rose-200">{categoria} · {total}</span>)}</div></div>}

        {execucao.falhas > 0 && <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 p-5"><p className="text-sm font-black text-rose-900">Segmento bloqueado por {numero.format(execucao.falhas)} item(ns) em revisão</p><p className="mt-1 text-xs leading-5 text-rose-700">O diagnóstico compara os IDs sem gravar nada. A conferência também consulta o Bling novamente, mas pode atualizar somente o estado local quando encontrar um vínculo já correto.</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={diagnosticarCategorias} disabled={ocupado || executando || confirmacao !== execucao.segmento} className="rounded-xl border border-rose-300 bg-white px-5 py-3 text-sm font-black text-rose-800 disabled:opacity-40">{ocupado ? 'Consultando…' : 'Diagnosticar IDs de categoria'}</button><button type="button" onClick={reconciliar} disabled={ocupado || executando || confirmacao !== execucao.segmento} className="rounded-xl bg-rose-700 px-5 py-3 text-sm font-black text-white disabled:opacity-40">{ocupado ? 'Conferindo…' : `Conferir ${numero.format(execucao.falhas)} itens em revisão`}</button></div></div>}

        {diagnosticos.length > 0 && <div className="overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-sm"><div className="border-b border-violet-100 bg-violet-50 px-5 py-4"><p className="text-sm font-black text-violet-950">Diagnóstico somente leitura dos IDs</p><p className="mt-1 text-xs text-violet-700">Categoria interna, vínculo da categoria com a loja e categorias devolvidas no vínculo do produto. Nenhum registro foi alterado.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead><tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500"><th className="px-5 py-3">Produto</th><th className="px-4 py-3">Categoria interna</th><th className="px-4 py-3">Vínculo categoria-loja</th><th className="px-4 py-3">IDs no produto-loja</th><th className="px-5 py-3">Resultado</th></tr></thead><tbody>{diagnosticos.map(item => <tr key={`${item.idProduto}-${item.idVinculo || 'sem-vinculo'}`} className="border-t border-slate-100"><td className="px-5 py-3"><span className="font-mono text-xs font-black text-cyan-700">{item.codigo}</span><span className="mt-1 block font-bold">{item.produto}</span></td><td className="px-4 py-3"><span className="block text-slate-700">{item.categoria || 'Nome não informado'}</span><code className="text-xs font-bold text-slate-950">ID {item.idCategoriaInterna}</code></td><td className="px-4 py-3"><code className="text-xs font-bold text-slate-950">{item.idMapeamento ? `ID ${item.idMapeamento}` : 'Não encontrado'}</code>{item.idCategoriaNoMapeamento && <span className="mt-1 block text-xs text-slate-500">categoriaProduto.id: {item.idCategoriaNoMapeamento}</span>}</td><td className="px-4 py-3 font-mono text-xs font-bold text-slate-700">{item.idsNoVinculo.length ? item.idsNoVinculo.join(', ') : 'Nenhum'}</td><td className="px-5 py-3"><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ring-1 ${item.situacao === 'USA_ID_INTERNO' ? selo('CORRETO') : selo('REVISAO')}`}>{item.situacao.replaceAll('_', ' ')}</span></td></tr>)}</tbody></table></div></div>}

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div><p className="text-xs font-black uppercase tracking-wider text-blue-700">Simulação salva</p><h4 className="mt-1 text-xl font-black">{execucao.segmento} → {execucao.loja}</h4><span className={`mt-2 inline-block rounded-full px-2.5 py-1 text-[10px] font-black uppercase ring-1 ${selo(execucao.status)}`}>{execucao.status.replaceAll('_', ' ')}</span></div>
            <div className="flex flex-wrap items-end gap-2"><label className="text-xs font-black text-slate-500">Digite “{execucao.segmento}” para liberar<input value={confirmacao} onChange={e => setConfirmacao(e.target.value)} disabled={executando || ocupado} className="mt-2 block min-w-60 rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-normal text-slate-950" /></label>{executando ? <button type="button" onClick={pausar} className="rounded-xl bg-amber-500 px-5 py-3 text-sm font-black text-white">Parar com segurança</button> : <button type="button" onClick={executar} disabled={ocupado || confirmacao !== execucao.segmento || execucao.pendentes === 0 || execucao.falhas > 0} className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-black text-white disabled:opacity-40">{execucao.falhas > 0 ? 'Reconcilie antes de retomar' : execucao.status === 'PAUSADO' ? 'Retomar segmento' : 'Vincular segmento'}</button>}</div>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4"><p className="text-sm font-black">Itens que exigem ação ou conferência</p><p className="mt-1 text-xs text-slate-500">Mostrando até 100 registros; os já corretos ficam ocultos desta tabela.</p></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500"><th className="px-5 py-3">Produto</th><th className="px-4 py-3">Categoria</th><th className="px-4 py-3">Ação</th><th className="px-5 py-3">Situação</th></tr></thead><tbody>{visiveis.map(item => <tr key={item.id} className="border-t border-slate-100"><td className="px-5 py-3"><span className="font-mono text-xs font-black text-cyan-700">{item.codigo}</span><span className="mt-1 block font-bold">{item.produto}</span>{item.motivo && <span className="mt-1 block text-xs text-rose-600">{item.motivo}</span>}</td><td className="px-4 py-3 text-slate-600">{item.categoria || 'Sem categoria'}</td><td className="px-4 py-3 font-bold">{item.acao}</td><td className="px-5 py-3"><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ring-1 ${selo(item.status)}`}>{item.status}</span></td></tr>)}</tbody></table></div>
        </div>
      </>}

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wider text-slate-500">Retomada</p><h4 className="mt-1 text-lg font-black">Execuções recentes</h4></div><button type="button" onClick={carregarExecucoes} className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-black text-blue-700">Carregar histórico</button></div>
        <div className="mt-4 space-y-2">{execucoes.map(item => <button key={item.id} type="button" onClick={() => void carregarExecucao(item.id).catch(erro => aoErro(erro instanceof Error ? erro.message : 'Falha ao abrir execução.'))} className="flex w-full items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 text-left hover:bg-slate-50"><span><strong className="block text-sm">{item.segmento}</strong><span className="mt-1 block text-xs text-slate-500">{item.loja} · {numero.format(item.total)} produtos</span></span><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ring-1 ${selo(item.status)}`}>{item.status.replaceAll('_', ' ')}</span></button>)}</div>
      </div>
    </div>
  );
}
