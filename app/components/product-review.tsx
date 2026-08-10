'use client';

import { useMemo, useState } from 'react';
import { CAMPOS_IMAGEM, type CampoImagem, type ProdutoResultado } from '../produtos';

interface ProductReviewProps {
  produtos: ProdutoResultado[];
  ocupado: boolean;
  aoAlterar: (indice: number, campo: keyof ProdutoResultado, valor: string) => void;
  aoAlterarImagem: (indice: number, campo: CampoImagem, selecionar: boolean) => void;
  aoDefinirImagem: (indice: number, campo: CampoImagem, url: string) => void;
}

const semInformacao = (valor: unknown) => {
  const texto = String(valor ?? '').trim().toUpperCase();
  return !texto || texto.includes('NÃO INFORMADO') || texto.startsWith('ERRO IA:');
};

export function ProductReview({
  produtos,
  ocupado,
  aoAlterar,
  aoAlterarImagem,
  aoDefinirImagem,
}: ProductReviewProps) {
  const [busca, setBusca] = useState('');
  const [selecionado, setSelecionado] = useState(0);
  const [urlsEmEdicao, setUrlsEmEdicao] = useState<Record<string, string>>({});
  const [erroImagem, setErroImagem] = useState('');

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase('pt-BR');
    return produtos
      .map((produto, indice) => ({ produto, indice }))
      .filter(({ produto }) => !termo ||
        produto.codigo.toLocaleLowerCase('pt-BR').includes(termo) ||
        produto.nome.toLocaleLowerCase('pt-BR').includes(termo));
  }, [busca, produtos]);

  const indiceDentroDaLista = Math.min(selecionado, Math.max(produtos.length - 1, 0));
  const indiceSelecionado = filtrados.some(item => item.indice === indiceDentroDaLista)
    ? indiceDentroDaLista
    : filtrados[0]?.indice ?? indiceDentroDaLista;
  const produto = produtos[indiceSelecionado];
  if (!produto) return null;

  const fichaIncompleta = ['peso', 'largura', 'altura', 'profundidade']
    .some(campo => semInformacao(produto[campo as keyof ProdutoResultado]));

  const aplicarImagemManual = (campo: CampoImagem) => {
    const chave = `${indiceSelecionado}-${campo}`;
    const url = String(urlsEmEdicao[chave] ?? produto[campo] ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      setErroImagem('Cole um endereço completo começando com http:// ou https://.');
      return;
    }
    aoDefinirImagem(indiceSelecionado, campo, url);
    setErroImagem('');
    setUrlsEmEdicao(atuais => {
      const proximas = { ...atuais };
      delete proximas[chave];
      return proximas;
    });
  };

  return (
    <div className="grid min-h-[640px] overflow-hidden rounded-2xl border border-slate-200 bg-white lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50 lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-200 p-4">
          <label htmlFor="buscar-produto" className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Localizar produto
          </label>
          <input
            id="buscar-produto"
            type="search"
            value={busca}
            onChange={evento => setBusca(evento.target.value)}
            placeholder="Código ou nome"
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          <p className="mt-2 text-xs text-slate-500">{filtrados.length} de {produtos.length} produtos</p>
        </div>

        <div className="max-h-72 overflow-y-auto p-2 lg:max-h-[550px]">
          {filtrados.map(({ produto: item, indice }) => {
            const ativo = indice === indiceSelecionado;
            const incompleto = semInformacao(item.peso) || semInformacao(item.largura) ||
              semInformacao(item.altura) || semInformacao(item.profundidade);
            return (
              <button
                key={`${item.codigo}-${indice}`}
                type="button"
                onClick={() => setSelecionado(indice)}
                className={`mb-1 w-full rounded-lg border px-3 py-3 text-left transition ${
                  ativo
                    ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
                    : 'border-transparent text-slate-700 hover:border-slate-200 hover:bg-white'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold">{item.codigo}</span>
                  {incompleto && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${ativo ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-800'}`}>
                      conferir
                    </span>
                  )}
                </span>
                <span className={`mt-1 block truncate text-sm ${ativo ? 'text-blue-50' : 'text-slate-600'}`}>
                  {item.nome}
                </span>
              </button>
            );
          })}
          {filtrados.length === 0 && (
            <p className="p-5 text-center text-sm text-slate-500">Nenhum produto encontrado.</p>
          )}
        </div>
      </aside>

      <div className="min-w-0 p-5 md:p-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-5">
          <div>
            <p className="font-mono text-xs font-bold uppercase tracking-wider text-blue-600">{produto.codigo}</p>
            <h3 className="mt-1 text-xl font-bold text-slate-950">{produto.nome}</h3>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${
            fichaIncompleta ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
          }`}>
            {fichaIncompleta ? 'Ficha para conferir' : 'Ficha completa'}
          </span>
        </div>

        <div className="mb-7">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="text-sm font-bold text-slate-900">Imagens selecionadas</h4>
            <span className="text-xs text-slate-500">420×420 • produto em até 350×350</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {CAMPOS_IMAGEM.map((campo, indice) => {
              const imagem = produto[campo];
              const removida = produto.imagensExcluidas?.[campo];
              if (imagem) {
                return (
                  <div key={campo} className="group relative aspect-square overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <a href={imagem} target="_blank" rel="noreferrer" className="block h-full w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imagem} alt={`${produto.nome} ${indice + 1}`} className="h-full w-full object-contain p-2" />
                    </a>
                    <button
                      type="button"
                      onClick={() => aoAlterarImagem(indiceSelecionado, campo, false)}
                      disabled={ocupado}
                      aria-label={`Remover imagem ${indice + 1}`}
                      className="absolute right-2 top-2 rounded-full bg-slate-950/80 px-2 py-1 text-xs font-bold text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
                    >
                      Remover
                    </button>
                  </div>
                );
              }
              if (removida) {
                return (
                  <button
                    key={campo}
                    type="button"
                    onClick={() => aoAlterarImagem(indiceSelecionado, campo, true)}
                    disabled={ocupado}
                    className="aspect-square rounded-xl border border-dashed border-blue-300 bg-blue-50 p-3 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                  >
                    ↶ Restaurar imagem {indice + 1}
                  </button>
                );
              }
              return (
                <div key={campo} className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-400">
                  Sem imagem
                </div>
              );
            })}
          </div>

          <details className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
            <summary className="cursor-pointer text-sm font-bold text-blue-800">
              Adicionar ou substituir uma imagem manualmente
            </summary>
            <p className="mt-2 text-xs leading-5 text-blue-900">
              Abra a foto encontrada, copie o endereço da imagem e cole em uma das posições abaixo.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {CAMPOS_IMAGEM.map((campo, indice) => {
                const chave = `${indiceSelecionado}-${campo}`;
                return (
                  <div key={campo} className="rounded-lg border border-blue-200 bg-white p-3">
                    <label htmlFor={`imagem-manual-${indiceSelecionado}-${campo}`} className="text-xs font-bold uppercase tracking-wide text-slate-600">
                      Imagem {indice + 1}
                    </label>
                    <div className="mt-2 flex gap-2">
                      <input
                        id={`imagem-manual-${indiceSelecionado}-${campo}`}
                        type="url"
                        value={urlsEmEdicao[chave] ?? produto[campo] ?? ''}
                        onChange={evento => setUrlsEmEdicao(atuais => ({
                          ...atuais,
                          [chave]: evento.target.value,
                        }))}
                        placeholder="https://site.com/foto.jpg"
                        disabled={ocupado}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
                      />
                      <button
                        type="button"
                        onClick={() => aplicarImagemManual(campo)}
                        disabled={ocupado}
                        className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40"
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {erroImagem && <p role="alert" className="mt-3 text-xs font-semibold text-red-700">{erroImagem}</p>}
          </details>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {([
            ['marca', 'Marca'],
            ['peso', 'Peso'],
            ['largura', 'Largura'],
            ['altura', 'Altura'],
            ['profundidade', 'Profundidade'],
          ] as const).map(([campo, rotulo]) => (
            <label key={campo} className="text-xs font-bold uppercase tracking-wide text-slate-500">
              {rotulo}
              <input
                value={produto[campo] || ''}
                onChange={evento => aoAlterar(indiceSelecionado, campo, evento.target.value)}
                disabled={ocupado}
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
              />
            </label>
          ))}
        </div>

        {produto.origemMedidas && (
          <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
            <strong className="text-slate-800">Origem das medidas:</strong>{' '}
            {produto.origemMedidas === 'REAPROVEITADO'
              ? `reaproveitadas do código ${produto.codigoReferencia}`
              : produto.origemMedidas === 'COMPLEMENTADO'
                ? 'ficha anterior complementada pela IA'
                : 'estimativa da IA'}
            {produto.justificativaMedidas ? ` — ${produto.justificativaMedidas}` : ''}
          </div>
        )}

        <div className="mt-6 grid gap-5 xl:grid-cols-2">
          <label className="text-sm font-bold text-slate-900">
            Descrição curta
            <textarea
              value={produto.curta || ''}
              onChange={evento => aoAlterar(indiceSelecionado, 'curta', evento.target.value)}
              disabled={ocupado}
              rows={5}
              className="mt-2 w-full resize-y rounded-xl border border-slate-300 bg-white p-3 text-sm font-normal leading-6 text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
            />
          </label>
          <label className="text-sm font-bold text-slate-900">
            Descrição longa
            <textarea
              value={produto.longa || ''}
              onChange={evento => aoAlterar(indiceSelecionado, 'longa', evento.target.value)}
              disabled={ocupado}
              rows={10}
              className="mt-2 w-full resize-y rounded-xl border border-slate-300 bg-white p-3 text-sm font-normal leading-6 text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
