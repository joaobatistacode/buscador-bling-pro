'use client';

import { useRef, useState } from 'react';

const CONFIRMACAO = 'RESTAURAR IMAGENS';
const CHAVE_CONCLUIDOS = 'buscador-bling:imagens-restauradas';

type Resultado = {
  codigo: string;
  restaurado?: boolean;
  imagensRestauradas?: number;
  ignorado?: boolean;
  motivo?: string;
  erro?: string;
};

async function chamar(corpo: Record<string, unknown>) {
  try {
    const resposta = await fetch('/api/bling/recuperar-imagens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const dados = await resposta.json().catch(() => ({ erro: `HTTP ${resposta.status}` }));
    return { resposta: { ok: resposta.ok, status: resposta.status }, dados };
  } catch (erro) {
    return {
      resposta: { ok: false, status: 0 },
      dados: { erro: erro instanceof Error ? `Falha de rede: ${erro.message}` : 'Falha de rede.' },
    };
  }
}

export function BlingImageRecovery({
  bloqueado,
  aoMudarOcupado,
}: {
  bloqueado: boolean;
  aoMudarOcupado: (ocupado: boolean) => void;
}) {
  const [codigos, setCodigos] = useState<string[]>([]);
  const [consultando, setConsultando] = useState(false);
  const [executando, setExecutando] = useState(false);
  const [confirmacao, setConfirmacao] = useState('');
  const [progresso, setProgresso] = useState({ atual: 0, total: 0 });
  const [mensagem, setMensagem] = useState('Nenhuma consulta executada.');
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const parar = useRef(false);

  const consultarInventario = async () => {
    setConsultando(true);
    setMensagem('Consultando o inventário do Supabase…');
    try {
      const { resposta, dados } = await chamar({ acao: 'inventario' });
      if (!resposta.ok) throw new Error(dados.erro || 'Falha ao consultar o inventário.');
      setCodigos(Array.isArray(dados.codigos) ? dados.codigos : []);
      setMensagem(`${dados.total || 0} produto(s) com imagens encontrados no Supabase. Nenhuma alteração foi feita.`);
    } catch (erro) {
      setMensagem(erro instanceof Error ? erro.message : 'Falha ao consultar o Supabase.');
    } finally {
      setConsultando(false);
    }
  };

  const simularPrimeiro = async () => {
    if (!codigos[0]) return;
    setMensagem(`Simulando ${codigos[0]}…`);
    const { resposta, dados } = await chamar({ acao: 'simular', codigo: codigos[0] });
    if (!resposta.ok) {
      setMensagem(`${codigos[0]}: ${dados.erro || 'falha na simulação'}`);
      return;
    }
    if (dados.ignorado) {
      setMensagem(`${codigos[0]}: ignorado com segurança — ${dados.motivo}`);
      return;
    }
    setMensagem(`${codigos[0]}: simulação aprovada; ${dados.imagens?.length || 0} imagem(ns) seriam restauradas. Nada foi alterado.`);
  };

  const restaurar = async () => {
    if (confirmacao !== CONFIRMACAO || codigos.length === 0) return;
    const concluidos = new Set<string>();
    try {
      const salvos = JSON.parse(localStorage.getItem(CHAVE_CONCLUIDOS) || '[]');
      if (Array.isArray(salvos)) salvos.forEach(codigo => concluidos.add(String(codigo)));
    } catch {}

    const pendentes = codigos.filter(codigo => !concluidos.has(codigo));
    parar.current = false;
    setExecutando(true);
    aoMudarOcupado(true);
    setResultados([]);
    setProgresso({ atual: 0, total: pendentes.length });
    const saidas: Resultado[] = [];

    for (let indice = 0; indice < pendentes.length; indice++) {
      if (parar.current) break;
      const codigo = pendentes[indice];
      setMensagem(`[${indice + 1}/${pendentes.length}] Verificando ${codigo}…`);
      let tentativa = 0;
      let finalizado = false;

      while (!finalizado && tentativa < 4 && !parar.current) {
        tentativa++;
        const { resposta, dados } = await chamar({ acao: 'restaurar', codigo, confirmacao: CONFIRMACAO });
        if (resposta.status === 429 && tentativa < 4) {
          setMensagem(`${codigo}: limite do Bling; aguardando 5 segundos…`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }

        const resultado: Resultado = resposta.ok
          ? dados
          : { codigo, erro: dados.erro || `HTTP ${resposta.status}` };
        saidas.push(resultado);
        setResultados([...saidas]);
        if (resposta.ok && (dados.restaurado || dados.ignorado)) {
          concluidos.add(codigo);
          try {
            localStorage.setItem(CHAVE_CONCLUIDOS, JSON.stringify([...concluidos]));
          } catch {}
        }
        finalizado = true;
      }

      setProgresso({ atual: indice + 1, total: pendentes.length });
      if (!parar.current) await new Promise(resolve => setTimeout(resolve, 1400));
    }

    const restaurados = saidas.filter(item => item.restaurado).length;
    const ignorados = saidas.filter(item => item.ignorado).length;
    const erros = saidas.filter(item => item.erro).length;
    setMensagem(parar.current
      ? `Interrompido com segurança. ${restaurados} restaurados, ${ignorados} preservados e ${erros} erros nesta execução.`
      : `Concluído: ${restaurados} restaurados, ${ignorados} já tinham imagem e ${erros} erros.`);
    setExecutando(false);
    aoMudarOcupado(false);
  };

  return (
    <section className="mt-6 rounded-2xl border border-red-200 bg-white p-6 shadow-sm md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-600">Recuperação emergencial</p>
          <h3 className="mt-2 text-lg font-bold text-slate-950">Restaurar imagens do Supabase</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Primeiro faça o inventário e simule. Na execução real, produtos que ainda possuem qualquer imagem no Bling são ignorados; somente produtos sem imagem recebem os arquivos já existentes no Supabase.
          </p>
        </div>
        <span className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-bold text-red-700">Sem Serper</span>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" onClick={consultarInventario} disabled={bloqueado || consultando || executando} className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
          {consultando ? 'Consultando…' : '1. Verificar Supabase'}
        </button>
        <button type="button" onClick={simularPrimeiro} disabled={bloqueado || executando || codigos.length === 0} className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700 hover:bg-blue-100 disabled:opacity-40">
          2. Simular primeiro produto
        </button>
      </div>

      <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <label className="block text-sm font-bold text-amber-950">
          Para liberar a restauração real, digite {CONFIRMACAO}
          <input value={confirmacao} onChange={evento => setConfirmacao(evento.target.value.toUpperCase())} disabled={executando} className="mt-2 w-full max-w-sm rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono font-normal text-slate-900" />
        </label>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" onClick={restaurar} disabled={bloqueado || executando || codigos.length === 0 || confirmacao !== CONFIRMACAO} className="rounded-xl bg-red-600 px-5 py-3 text-sm font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">
            3. Restaurar produtos sem imagem
          </button>
          {executando && (
            <button type="button" onClick={() => { parar.current = true; }} className="rounded-xl border border-red-300 bg-white px-5 py-3 text-sm font-bold text-red-700 hover:bg-red-50">
              Parar com segurança
            </button>
          )}
        </div>
      </div>

      <div aria-live="polite" className="mt-5 rounded-xl bg-slate-950 p-4 font-mono text-sm leading-6 text-emerald-300">
        {mensagem}
        {progresso.total > 0 && <div className="mt-2 text-slate-300">Progresso: {progresso.atual}/{progresso.total}</div>}
      </div>

      {resultados.some(item => item.erro) && (
        <details className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <summary className="cursor-pointer font-bold">Ver produtos com erro</summary>
          <ul className="mt-3 space-y-1 font-mono text-xs">
            {resultados.filter(item => item.erro).map(item => <li key={item.codigo}>{item.codigo}: {item.erro}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
