'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProdutoResultado } from '../produtos';

type Painel = {
  operacao: { enviados: number; pendentes: number; total: number; atualizadoEm?: string | null };
  historico: { total: number; enviados: number; revisados: number; aguardandoRevisao: number; medidasReais: number; medidasEstimadas: number };
  qualidade: { baseEnviados: number; fotos: Record<'0' | '1' | '2' | '3' | '4', number>; marca: { com: number; sem: number }; descricao: { com: number; sem: number } };
  tarefas: { pendentes: number; concluidas: number };
  integracoes: {
    bling: { configurado: boolean; conectado: boolean; api: 'ONLINE' | 'LIMITADA' | 'INDISPONIVEL' | 'DESCONECTADA' | 'NAO_CONFIGURADA' };
    supabase: { configurado: boolean; online: boolean };
    telegram: { configurado: boolean };
  };
};
type ProdutoHistorico = { codigo: string; nome: string; curta: string; marca: string; peso: string; largura: string; altura: string; profundidade: string; origem_medidas?: string; fonte_medidas?: string; imagens?: string[]; status?: string; revisado?: boolean; enviado_em?: string };
type Tarefa = { id: string; titulo: string; descricao?: string; status: 'PENDENTE' | 'EM_ANDAMENTO' | 'CONCLUIDA'; prioridade: 'BAIXA' | 'MEDIA' | 'ALTA'; codigo_produto?: string; prazo?: string };

const classeCartao = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_35px_rgba(15,23,42,0.05)]';

const numero = new Intl.NumberFormat('pt-BR');

function StatusIntegracao({ nome, detalhe, ativo }: { nome: string; detalhe: string; ativo: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-3.5 shadow-[0_8px_24px_rgba(15,23,42,.04)]">
      <div className="min-w-0">
        <p className="text-sm font-black text-slate-900">{nome}</p>
        <p className="mt-0.5 truncate text-xs text-slate-500">{detalhe}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${ativo ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}`}>
        {ativo ? 'Ativa' : 'Atenção'}
      </span>
    </div>
  );
}

function BarraQualidade({ rotulo, valor, total, cor }: { rotulo: string; valor: number; total: number; cor: string }) {
  const percentual = total ? Math.round((valor / total) * 100) : 0;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4 text-sm">
        <span className="font-bold text-slate-600">{rotulo}</span>
        <span className="font-black text-slate-950">{numero.format(valor)} <span className="font-semibold text-slate-400">· {percentual}%</span></span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${cor} transition-[width] duration-500`} style={{ width: `${percentual}%` }} />
      </div>
    </div>
  );
}

type RevisaoAtual = { total: number; revisados: number; comErro: number; semFotos: number };

export function DashboardView({ geminiConfigurado, serperConfigurado, revisaoAtual }: { geminiConfigurado: boolean; serperConfigurado: boolean; revisaoAtual: RevisaoAtual }) {
  const [dados, setDados] = useState<Painel | null>(null);
  const [erro, setErro] = useState('');
  const [enviados, setEnviados] = useState('0');
  const [pendentes, setPendentes] = useState('0');
  const [editando, setEditando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [atualizando, setAtualizando] = useState(true);
  const [mensagem, setMensagem] = useState('');
  const carregar = useCallback(async () => {
    setErro('');
    setAtualizando(true);
    try {
      const resposta = await fetch('/api/dashboard', { cache: 'no-store' });
      const retorno = await resposta.json();
      if (!resposta.ok || retorno.erro) throw new Error(retorno.erro || 'Não foi possível carregar o painel.');
      setDados(retorno);
      setEnviados(String(retorno.operacao.enviados));
      setPendentes(String(retorno.operacao.pendentes));
    } finally {
      setAtualizando(false);
    }
  }, []);
  useEffect(() => {
    let ativo = true;
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(async resposta => ({ resposta, retorno: await resposta.json() }))
      .then(({ resposta, retorno }) => {
        if (!resposta.ok || retorno.erro) throw new Error(retorno.erro || 'Não foi possível carregar o painel.');
        if (!ativo) return;
        setDados(retorno);
        setEnviados(String(retorno.operacao.enviados));
        setPendentes(String(retorno.operacao.pendentes));
      })
      .catch(e => { if (ativo) setErro(e instanceof Error ? e.message : 'Não foi possível carregar o painel.'); })
      .finally(() => { if (ativo) setAtualizando(false); });
    return () => { ativo = false; };
  }, []);
  const salvarTotais = async () => {
    setSalvando(true); setMensagem('');
    try {
      const resposta = await fetch('/api/dashboard', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enviados: Number(enviados), pendentes: Number(pendentes) }) });
      const retorno = await resposta.json();
      if (!resposta.ok) throw new Error(retorno.erro || 'Não foi possível salvar.');
      await carregar(); setEditando(false); setMensagem('Totais atualizados com sucesso.');
    } catch (e) { setMensagem(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
    finally { setSalvando(false); }
  };
  if (erro && !dados) return <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"><p className="font-bold">O Dashboard não conseguiu carregar os indicadores.</p><p className="mt-1">{erro}</p><button type="button" onClick={() => void carregar().catch(e => setErro(e instanceof Error ? e.message : 'Não foi possível carregar o painel.'))} className="mt-4 rounded-xl bg-red-700 px-4 py-2 font-black text-white">Tentar novamente</button></div>;
  if (!dados) return <div className="grid min-h-52 place-items-center rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-500">Carregando indicadores do Dashboard…</div>;
  const progresso = dados.operacao.total ? Math.round((dados.operacao.enviados / dados.operacao.total) * 100) : 0;
  const base = dados.qualidade.baseEnviados;
  const blingOnline = dados.integracoes.bling.api === 'ONLINE' || dados.integracoes.bling.api === 'LIMITADA';
  const blingDetalhe = dados.integracoes.bling.api === 'ONLINE' ? 'API respondendo e sessão conectada' : dados.integracoes.bling.api === 'LIMITADA' ? 'API conectada, limite temporário atingido' : dados.integracoes.bling.api === 'DESCONECTADA' ? 'Reconecte sua conta do Bling' : dados.integracoes.bling.api === 'NAO_CONFIGURADA' ? 'Credenciais ausentes na Vercel' : 'API não respondeu à última verificação';
  return (
    <section className="space-y-6">
      <div className="relative overflow-hidden rounded-[28px] bg-[linear-gradient(125deg,#071a24_0%,#0b3445_58%,#0c5263_100%)] p-6 text-white shadow-[0_24px_70px_rgba(7,26,36,.22)] md:p-8">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-cyan-300/10 blur-2xl" />
        <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
          <div>
            <p className="text-xs font-black uppercase tracking-[.24em] text-cyan-300">Central de operação</p>
            <h2 className="mt-3 max-w-2xl text-3xl font-black tracking-tight md:text-4xl">Seu catálogo, do trabalho pendente ao produto publicado.</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Defina a base geral uma vez. Depois, cada novo envio concluído atualiza automaticamente os totais e a qualidade do catálogo.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" onClick={() => setEditando(valor => !valor)} className="rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-black text-[#071a24] transition hover:bg-cyan-200">{editando ? 'Fechar edição' : 'Atualizar quantidades'}</button>
              <button type="button" onClick={() => void carregar().catch(e => setErro(e instanceof Error ? e.message : 'Não foi possível atualizar o painel.'))} disabled={atualizando} className="rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-black text-white transition hover:bg-white/10 disabled:opacity-50">{atualizando ? 'Atualizando…' : 'Atualizar painel'}</button>
              {dados.operacao.atualizadoEm ? <span className="self-center text-xs text-slate-400">Atualizado em {new Date(dados.operacao.atualizadoEm).toLocaleString('pt-BR')}</span> : null}
            </div>
          </div>
          <div className="flex items-center gap-5 rounded-3xl border border-white/10 bg-white/[.06] p-4 backdrop-blur-sm">
            <div className="grid h-28 w-28 shrink-0 place-items-center rounded-full p-2" style={{ background: `conic-gradient(#67e8f9 ${progresso}%, rgba(255,255,255,.12) 0)` }}>
              <div className="grid h-full w-full place-items-center rounded-full bg-[#0a2936] text-center"><div><strong className="block text-2xl font-black">{progresso}%</strong><span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">concluído</span></div></div>
            </div>
            <div className="pr-2"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">Meta cadastrada</p><p className="mt-1 text-2xl font-black">{numero.format(dados.operacao.total)}</p><p className="mt-1 text-xs text-slate-400">produtos no total</p></div>
          </div>
        </div>
      </div>

      {editando ? <div className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <label className="min-w-[190px] flex-1 text-sm font-black text-slate-800">Já enviados ao Bling<input type="number" min="0" step="1" value={enviados} onChange={e => setEnviados(e.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg font-black outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" /></label>
          <label className="min-w-[190px] flex-1 text-sm font-black text-slate-800">Ainda faltam fazer<input type="number" min="0" step="1" value={pendentes} onChange={e => setPendentes(e.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg font-black outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100" /></label>
          <button type="button" disabled={salvando} onClick={salvarTotais} className="rounded-xl bg-[#071a24] px-6 py-3.5 text-sm font-black text-white transition hover:bg-[#0b3445] disabled:opacity-50">{salvando ? 'Salvando…' : 'Salvar no painel'}</button>
        </div>
        {mensagem ? <p role="status" className="mt-3 text-sm font-semibold text-slate-600">{mensagem}</p> : null}
      </div> : mensagem ? <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">{mensagem}</p> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Enviados', dados.operacao.enviados, 'base manual + novos envios', 'text-emerald-600', 'bg-emerald-50'],
          ['Ainda faltam', dados.operacao.pendentes, 'diminui após cada novo envio', 'text-orange-600', 'bg-orange-50'],
          ['Na revisão atual', revisaoAtual.total, `${revisaoAtual.revisados} já conferidos neste navegador`, 'text-blue-600', 'bg-blue-50'],
          ['Tarefas abertas', dados.tarefas.pendentes, `${dados.tarefas.concluidas} já concluídas`, 'text-violet-600', 'bg-violet-50'],
        ].map(([rotulo, valor, detalhe, cor, fundo]) => <div key={String(rotulo)} className={`${classeCartao} relative overflow-hidden`}><span className={`absolute right-4 top-4 h-3 w-3 rounded-full ${fundo} ring-4 ring-current/5`} /><p className="text-sm font-bold text-slate-500">{rotulo}</p><p className={`mt-3 text-4xl font-black ${cor}`}>{numero.format(Number(valor))}</p><p className="mt-2 text-xs leading-5 text-slate-500">{detalhe}</p></div>)}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className={`${classeCartao} border-blue-200 bg-blue-50/40`}><p className="text-xs font-black uppercase tracking-wider text-blue-700">Lote aberto neste navegador</p><p className="mt-2 text-3xl font-black text-slate-950">{numero.format(revisaoAtual.total)}</p><p className="mt-1 text-xs text-slate-500">Esta é a lista que aparece na aba Revisão.</p></div>
        <div className={`${classeCartao} ${revisaoAtual.comErro ? 'border-rose-200 bg-rose-50/50' : ''}`}><p className="text-xs font-black uppercase tracking-wider text-rose-700">Produtos com erro</p><p className="mt-2 text-3xl font-black text-slate-950">{numero.format(revisaoAtual.comErro)}</p><p className="mt-1 text-xs text-slate-500">Falhas que precisam de conferência antes do envio.</p></div>
        <div className={`${classeCartao} ${revisaoAtual.semFotos ? 'border-amber-200 bg-amber-50/50' : ''}`}><p className="text-xs font-black uppercase tracking-wider text-amber-700">Produtos sem fotos</p><p className="mt-2 text-3xl font-black text-slate-950">{numero.format(revisaoAtual.semFotos)}</p><p className="mt-1 text-xs text-slate-500">Itens do lote atual sem nenhuma imagem selecionada.</p></div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
        <div className={`${classeCartao} p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.18em] text-cyan-700">Cobertura visual</p><h3 className="mt-1 text-xl font-black">Fotos dos produtos enviados</h3></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">Base: {numero.format(base)} enviados no histórico</span></div>
          <div className="mt-6 space-y-4">
            <BarraQualidade rotulo="4 fotos" valor={dados.qualidade.fotos['4']} total={base} cor="bg-emerald-500" />
            <BarraQualidade rotulo="3 fotos" valor={dados.qualidade.fotos['3']} total={base} cor="bg-cyan-500" />
            <BarraQualidade rotulo="2 fotos" valor={dados.qualidade.fotos['2']} total={base} cor="bg-blue-500" />
            <BarraQualidade rotulo="1 foto" valor={dados.qualidade.fotos['1']} total={base} cor="bg-amber-500" />
            <BarraQualidade rotulo="Sem foto" valor={dados.qualidade.fotos['0']} total={base} cor="bg-rose-500" />
          </div>
        </div>

        <div className="space-y-5">
          <div className={`${classeCartao} p-6`}><p className="text-xs font-black uppercase tracking-[.18em] text-blue-700">Cadastro comercial</p><h3 className="mt-1 text-lg font-black">Marca preenchida</h3><div className="mt-5 flex items-end justify-between gap-4"><p className="text-4xl font-black text-slate-950">{numero.format(dados.qualidade.marca.com)}</p><p className="text-sm font-bold text-rose-600">{numero.format(dados.qualidade.marca.sem)} sem marca</p></div><div className="mt-4 h-2.5 overflow-hidden rounded-full bg-rose-100"><div className="h-full rounded-full bg-blue-600" style={{ width: `${base ? dados.qualidade.marca.com / base * 100 : 0}%` }} /></div></div>
          <div className={`${classeCartao} p-6`}><p className="text-xs font-black uppercase tracking-[.18em] text-blue-700">Conteúdo do site</p><h3 className="mt-1 text-lg font-black">Descrição curta preenchida</h3><div className="mt-5 flex items-end justify-between gap-4"><p className="text-4xl font-black text-slate-950">{numero.format(dados.qualidade.descricao.com)}</p><p className="text-sm font-bold text-rose-600">{numero.format(dados.qualidade.descricao.sem)} sem descrição</p></div><div className="mt-4 h-2.5 overflow-hidden rounded-full bg-rose-100"><div className="h-full rounded-full bg-cyan-600" style={{ width: `${base ? dados.qualidade.descricao.com / base * 100 : 0}%` }} /></div></div>
        </div>
      </div>

      <div className="rounded-[24px] border border-slate-200 bg-slate-100/70 p-5 md:p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-black uppercase tracking-[.18em] text-slate-500">Saúde do sistema</p><h3 className="mt-1 text-xl font-black">APIs e chaves</h3></div><p className="text-xs text-slate-500">O valor das chaves nunca é exibido.</p></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <StatusIntegracao nome="API do Bling" detalhe={blingDetalhe} ativo={blingOnline} />
          <StatusIntegracao nome="Credenciais do Bling" detalhe={dados.integracoes.bling.configurado ? 'Client ID e Client Secret presentes' : 'Configuração incompleta'} ativo={dados.integracoes.bling.configurado} />
          <StatusIntegracao nome="Supabase" detalhe={dados.integracoes.supabase.online ? 'Banco de dados respondendo' : 'Banco indisponível'} ativo={dados.integracoes.supabase.configurado && dados.integracoes.supabase.online} />
          <StatusIntegracao nome="Telegram" detalhe={dados.integracoes.telegram.configurado ? 'Bot e celular configurados' : 'Token ou Chat ID ausente'} ativo={dados.integracoes.telegram.configurado} />
          <StatusIntegracao nome="Gemini" detalhe={geminiConfigurado ? 'Chave disponível nesta sessão' : 'Adicione a chave em Configurações'} ativo={geminiConfigurado} />
          <StatusIntegracao nome="Serper" detalhe={serperConfigurado ? 'Chave disponível nesta sessão' : 'Adicione a chave em Configurações'} ativo={serperConfigurado} />
        </div>
      </div>
    </section>
  );
}

export function HistoryView({ aoAbrir }: { aoAbrir: (produto: ProdutoResultado) => void }) {
  const [busca, setBusca] = useState('');
  const [produtos, setProdutos] = useState<ProdutoHistorico[]>([]);
  const [selecionado, setSelecionado] = useState<ProdutoHistorico | null>(null);
  const [carregando, setCarregando] = useState(false);
  const carregar = useCallback(async (termo = '') => { setCarregando(true); const r = await fetch(`/api/historico?q=${encodeURIComponent(termo)}`); const d = await r.json(); setProdutos(d.produtos || []); setCarregando(false); }, []);
  useEffect(() => { const id = setTimeout(() => carregar(busca), 250); return () => clearTimeout(id); }, [busca, carregar]);
  const alterar = (campo: keyof ProdutoHistorico, valor: string) => setSelecionado(p => p ? { ...p, [campo]: valor } : p);
  const salvar = async () => { if (!selecionado) return; const p = { codigo: selecionado.codigo, nome: selecionado.nome, curta: selecionado.curta, marca: selecionado.marca, peso: selecionado.peso, largura: selecionado.largura, altura: selecionado.altura, profundidade: selecionado.profundidade, origemMedidas: selecionado.origem_medidas, fonteMedidas: selecionado.fonte_medidas, img1: selecionado.imagens?.[0], img2: selecionado.imagens?.[1], img3: selecionado.imagens?.[2], img4: selecionado.imagens?.[3], revisado: selecionado.revisado, enviadoBling: selecionado.status === 'ENVIADO', enviadoEm: selecionado.enviado_em }; const r = await fetch('/api/historico', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: selecionado.codigo, produto: p }) }); if (r.ok) await carregar(busca); };
  return <section><div className="mb-7"><p className="text-xs font-black uppercase tracking-[.22em] text-cyan-700">Memória do catálogo</p><h2 className="mt-2 text-3xl font-black tracking-tight">Histórico de produtos</h2><p className="mt-2 text-sm text-slate-600">Pesquise por código ou nome, corrija um item antigo e reabra-o na revisão.</p></div><div className="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[360px_1fr]"><aside className="border-b border-slate-200 bg-slate-50/70 p-4 lg:border-b-0 lg:border-r"><input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar código ou produto…" className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-cyan-600"/><p className="mt-3 text-xs text-slate-500">{carregando ? 'Buscando…' : `${produtos.length} resultado(s)`}</p><div className="mt-3 max-h-[600px] space-y-1 overflow-auto">{produtos.map(p => <button key={p.codigo} onClick={() => setSelecionado(p)} className={`w-full rounded-xl px-3 py-3 text-left ${selecionado?.codigo === p.codigo ? 'bg-slate-950 text-white' : 'hover:bg-white'}`}><span className="block font-mono text-xs font-black">{p.codigo}</span><span className="mt-1 block truncate text-sm">{p.nome}</span><span className="mt-1 block text-[10px] font-bold uppercase tracking-wide opacity-60">{p.status || 'REVISÃO'}</span></button>)}</div></aside><div className="p-5 md:p-7">{selecionado ? <><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs font-black text-cyan-700">{selecionado.codigo}</p><h3 className="mt-1 text-xl font-black">{selecionado.nome}</h3></div><button onClick={() => aoAbrir({ codigo: selecionado.codigo, nome: selecionado.nome, curta: selecionado.curta, marca: selecionado.marca, peso: selecionado.peso, largura: selecionado.largura, altura: selecionado.altura, profundidade: selecionado.profundidade, origemMedidas: selecionado.origem_medidas, fonteMedidas: selecionado.fonte_medidas, img1: selecionado.imagens?.[0], img2: selecionado.imagens?.[1], img3: selecionado.imagens?.[2], img4: selecionado.imagens?.[3] })} className="rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-black text-white">Abrir na revisão</button></div><div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{(['marca','peso','largura','altura','profundidade'] as const).map(c => <label key={c} className="text-xs font-black uppercase tracking-wide text-slate-500">{c}<input value={selecionado[c] || ''} onChange={e => alterar(c, e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-normal normal-case"/></label>)}</div><label className="mt-5 block text-sm font-black">Descrição curta<textarea maxLength={136} rows={4} value={selecionado.curta || ''} onChange={e => alterar('curta', e.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 p-3 font-normal"/></label><div className="mt-5 flex justify-end"><button onClick={salvar} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-black text-white">Salvar alteração</button></div></> : <div className="flex min-h-72 items-center justify-center text-sm text-slate-500">Selecione um produto para visualizar.</div>}</div></div></section>;
}

export function TasksView() {
  const [tarefas, setTarefas] = useState<Tarefa[]>([]); const [titulo, setTitulo] = useState('');
  const carregar = useCallback(() => fetch('/api/tarefas').then(r => r.json()).then(d => setTarefas(d.tarefas || [])), []);
  useEffect(() => { carregar(); }, [carregar]);
  const criar = async () => { if (!titulo.trim()) return; await fetch('/api/tarefas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo, prioridade: 'MEDIA' }) }); setTitulo(''); carregar(); };
  const mudar = async (id: string, status: Tarefa['status']) => { await fetch('/api/tarefas', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) }); carregar(); };
  const colunas: [Tarefa['status'], string][] = [['PENDENTE','A fazer'],['EM_ANDAMENTO','Em andamento'],['CONCLUIDA','Concluídas']];
  return <section><div className="mb-7"><p className="text-xs font-black uppercase tracking-[.22em] text-cyan-700">Organização</p><h2 className="mt-2 text-3xl font-black tracking-tight">CRM de tarefas</h2><p className="mt-2 text-sm text-slate-600">Registre correções, pendências e próximos passos do catálogo.</p></div><div className="mb-5 flex gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"><input value={titulo} onChange={e => setTitulo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') criar(); }} placeholder="Nova tarefa…" className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-cyan-600"/><button onClick={criar} className="rounded-xl bg-cyan-700 px-5 py-3 text-sm font-black text-white">Adicionar</button></div><div className="grid gap-4 lg:grid-cols-3">{colunas.map(([status, rotulo]) => <div key={status} className="rounded-2xl bg-slate-200/60 p-3"><div className="flex items-center justify-between px-2 py-2"><h3 className="text-sm font-black">{rotulo}</h3><span className="rounded-full bg-white px-2 py-0.5 text-xs font-black">{tarefas.filter(t => t.status === status).length}</span></div><div className="space-y-2">{tarefas.filter(t => t.status === status).map(t => <article key={t.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm font-bold">{t.titulo}</p>{t.codigo_produto && <p className="mt-1 font-mono text-xs text-cyan-700">{t.codigo_produto}</p>}<div className="mt-3 flex flex-wrap gap-2">{status !== 'PENDENTE' && <button onClick={() => mudar(t.id,'PENDENTE')} className="text-xs font-bold text-slate-500">A fazer</button>}{status !== 'EM_ANDAMENTO' && <button onClick={() => mudar(t.id,'EM_ANDAMENTO')} className="text-xs font-bold text-amber-700">Em andamento</button>}{status !== 'CONCLUIDA' && <button onClick={() => mudar(t.id,'CONCLUIDA')} className="text-xs font-bold text-emerald-700">Concluir</button>}</div></article>)}</div></div>)}</div></section>;
}
