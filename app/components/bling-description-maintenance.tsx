'use client';

import { useMemo, useRef, useState } from 'react';

const CHAVE_CONCLUIDOS = 'buscador-bling:descricao-sem-obs-concluidos';
const INTERVALO_ENTRE_PRODUTOS = 1400;

interface Props {
  bloqueado: boolean;
  aoMudarOcupado: (ocupado: boolean) => void;
}

interface Simulacao {
  codigo: string;
  descricaoAtual: string;
  descricaoNova: string;
}

const espera = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const extrairCodigos = (texto: string) => [...new Set(texto
  .split(/\r?\n/)
  .map(linha => linha.trim().split(/[\t;,]/)[0]?.trim())
  .filter((codigo): codigo is string => Boolean(codigo))
)];

const lerConcluidos = () => {
  try {
    const dados = JSON.parse(localStorage.getItem(CHAVE_CONCLUIDOS) || '[]');
    return new Set<string>(Array.isArray(dados) ? dados.map(String) : []);
  } catch {
    return new Set<string>();
  }
};

export function BlingDescriptionMaintenance({ bloqueado, aoMudarOcupado }: Props) {
  const [texto, setTexto] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [executando, setExecutando] = useState(false);
  const [simulacao, setSimulacao] = useState<Simulacao | null>(null);
  const [mensagem, setMensagem] = useState('');
  const [progresso, setProgresso] = useState({ atual: 0, total: 0, corrigidos: 0, falhas: 0 });
  const [falhas, setFalhas] = useState<string[]>([]);
  const pararRef = useRef(false);
  const codigos = useMemo(() => extrairCodigos(texto), [texto]);

  const chamar = async (codigo: string, simular: boolean) => {
    const resposta = await fetch('/api/bling/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo, simular, somenteDescricaoComplementar: true }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) {
      const erro = new Error(dados.erro || `HTTP ${resposta.status}`);
      Object.assign(erro, { status: resposta.status });
      throw erro;
    }
    return dados;
  };

  const simularPrimeiro = async () => {
    if (!codigos[0]) return;
    setMensagem(`Simulando o código ${codigos[0]}…`);
    setSimulacao(null);
    try {
      const dados = await chamar(codigos[0], true);
      setSimulacao({
        codigo: codigos[0],
        descricaoAtual: dados.descricaoAtual || '(vazia)',
        descricaoNova: dados.descricaoNova || 'SEM OBS',
      });
      setMensagem('Simulação concluída. Nenhum produto foi alterado.');
    } catch (erro: unknown) {
      setMensagem(erro instanceof Error ? erro.message : 'Falha na simulação.');
    }
  };

  const iniciar = async () => {
    if (codigos.length === 0 || confirmacao.trim().toUpperCase() !== 'SEM OBS') return;
    const concluidos = lerConcluidos();
    const pendentes = codigos.filter(codigo => !concluidos.has(codigo));
    pararRef.current = false;
    setExecutando(true);
    aoMudarOcupado(true);
    setFalhas([]);
    setProgresso({ atual: 0, total: pendentes.length, corrigidos: 0, falhas: 0 });

    let corrigidos = 0;
    const erros: string[] = [];

    for (let indice = 0; indice < pendentes.length; indice++) {
      if (pararRef.current) break;
      const codigo = pendentes[indice];
      setMensagem(`[${indice + 1}/${pendentes.length}] Corrigindo ${codigo}…`);
      let sucesso = false;

      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          await chamar(codigo, false);
          sucesso = true;
          break;
        } catch (erro: unknown) {
          const status = typeof erro === 'object' && erro && 'status' in erro
            ? Number(erro.status)
            : 0;
          if (status === 429 && tentativa < 3) {
            setMensagem(`Limite do Bling atingido. Aguardando 5 segundos para repetir ${codigo}…`);
            await espera(5000);
            continue;
          }
          const detalhe = erro instanceof Error ? erro.message : 'erro desconhecido';
          erros.push(`${codigo}: ${detalhe}`);
          break;
        }
      }

      if (sucesso) {
        concluidos.add(codigo);
        corrigidos++;
        localStorage.setItem(CHAVE_CONCLUIDOS, JSON.stringify([...concluidos]));
      }

      setFalhas([...erros]);
      setProgresso({
        atual: indice + 1,
        total: pendentes.length,
        corrigidos,
        falhas: erros.length,
      });
      if (indice < pendentes.length - 1 && !pararRef.current) {
        await espera(INTERVALO_ENTRE_PRODUTOS);
      }
    }

    setExecutando(false);
    aoMudarOcupado(false);
    setMensagem(pararRef.current
      ? `Interrompido com segurança. ${corrigidos} produto(s) corrigidos nesta execução.`
      : `Concluído: ${corrigidos} corrigido(s) e ${erros.length} falha(s).`);
  };

  const limparProgresso = () => {
    localStorage.removeItem(CHAVE_CONCLUIDOS);
    setProgresso({ atual: 0, total: 0, corrigidos: 0, falhas: 0 });
    setFalhas([]);
    setMensagem('Progresso salvo removido. A próxima execução verificará todos os códigos novamente.');
  };

  return (
    <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700">Manutenção excepcional</p>
          <h3 className="mt-2 text-lg font-bold text-slate-950">Corrigir descrição complementar em massa</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            Cole os códigos dos produtos já enviados. Esta operação preserva o cadastro inteiro e troca somente a descrição complementar por “SEM OBS”.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-amber-800">{codigos.length} código(s)</span>
      </div>

      <label className="mt-5 block text-sm font-bold text-slate-800">
        Códigos dos produtos
        <textarea
          value={texto}
          onChange={evento => setTexto(evento.target.value)}
          disabled={executando}
          rows={7}
          placeholder={"16060\n17986\n17932"}
          className="mt-2 w-full rounded-xl border border-amber-300 bg-white p-3 font-mono text-sm font-normal text-slate-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 disabled:bg-slate-100"
        />
      </label>

      {simulacao && (
        <div className="mt-4 grid gap-3 rounded-xl border border-emerald-200 bg-white p-4 text-sm md:grid-cols-2">
          <p><strong>{simulacao.codigo} — atual:</strong><br />{simulacao.descricaoAtual}</p>
          <p><strong>Depois da correção:</strong><br />{simulacao.descricaoNova}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <button
          type="button"
          onClick={simularPrimeiro}
          disabled={bloqueado || executando || codigos.length === 0}
          className="rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-sm font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-40"
        >
          Simular primeiro código
        </button>
        <label className="text-xs font-bold uppercase tracking-wide text-slate-600">
          Digite SEM OBS para confirmar
          <input
            value={confirmacao}
            onChange={evento => setConfirmacao(evento.target.value)}
            disabled={executando}
            className="mt-1 block w-44 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-slate-900"
          />
        </label>
        {!executando ? (
          <button
            type="button"
            onClick={iniciar}
            disabled={bloqueado || codigos.length === 0 || confirmacao.trim().toUpperCase() !== 'SEM OBS'}
            className="rounded-lg bg-amber-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-amber-800 disabled:opacity-40"
          >
            Corrigir {codigos.length} produto(s)
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { pararRef.current = true; }}
            className="rounded-lg border border-red-300 bg-white px-5 py-2.5 text-sm font-bold text-red-700"
          >
            Parar com segurança
          </button>
        )}
        <button type="button" onClick={limparProgresso} disabled={executando} className="px-3 py-2.5 text-xs font-bold text-slate-500 disabled:opacity-40">
          Limpar progresso salvo
        </button>
      </div>

      {progresso.total > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex justify-between text-xs font-bold text-slate-600">
            <span>{progresso.corrigidos} corrigidos • {progresso.falhas} falhas</span>
            <span>{progresso.atual} de {progresso.total}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white">
            <div className="h-full bg-amber-600 transition-all" style={{ width: `${(progresso.atual / progresso.total) * 100}%` }} />
          </div>
        </div>
      )}

      {mensagem && <p aria-live="polite" className="mt-4 rounded-lg bg-slate-950 p-3 font-mono text-xs text-emerald-300">{mensagem}</p>}
      {falhas.length > 0 && (
        <details className="mt-3 rounded-lg border border-red-200 bg-white p-3">
          <summary className="cursor-pointer text-xs font-bold text-red-700">Ver produtos com falha ({falhas.length})</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-red-700">{falhas.join('\n')}</pre>
        </details>
      )}
      <p className="mt-4 text-xs leading-5 text-amber-900">
        Mantenha esta página aberta. Se interromper, os códigos concluídos ficam salvos neste navegador e serão pulados na retomada.
      </p>
    </section>
  );
}
