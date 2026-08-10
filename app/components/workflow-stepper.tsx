export interface EtapaFluxo {
  numero: number;
  titulo: string;
  descricao: string;
}

interface WorkflowStepperProps {
  etapas: EtapaFluxo[];
  atual: number;
  podeAcessar: (numero: number) => boolean;
  aoSelecionar: (numero: number) => void;
}

export function WorkflowStepper({ etapas, atual, podeAcessar, aoSelecionar }: WorkflowStepperProps) {
  return (
    <nav aria-label="Etapas do processamento" className="grid gap-2 sm:grid-cols-5">
      {etapas.map(etapa => {
        const concluida = etapa.numero < atual;
        const ativa = etapa.numero === atual;
        const disponivel = podeAcessar(etapa.numero);

        return (
          <button
            key={etapa.numero}
            type="button"
            onClick={() => disponivel && aoSelecionar(etapa.numero)}
            disabled={!disponivel}
            aria-current={ativa ? 'step' : undefined}
            className={`group rounded-xl border p-3 text-left transition ${
              ativa
                ? 'border-blue-600 bg-blue-600 text-white shadow-md shadow-blue-200'
                : concluida && disponivel
                  ? 'border-emerald-200 bg-emerald-50 text-slate-800 hover:border-emerald-400'
                  : disponivel
                    ? 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50'
                    : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                ativa
                  ? 'bg-white text-blue-700'
                  : concluida && disponivel
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-200 text-slate-600'
              }`}>
                {concluida && disponivel ? '✓' : etapa.numero}
              </span>
              <span className="font-semibold">{etapa.titulo}</span>
            </span>
            <span className={`mt-2 hidden text-xs leading-5 lg:block ${ativa ? 'text-blue-100' : 'text-slate-500'}`}>
              {etapa.descricao}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
