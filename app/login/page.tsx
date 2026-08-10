'use client';

import { FormEvent, useState } from 'react';

export default function Login() {
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function entrar(evento: FormEvent) {
    evento.preventDefault();
    setErro('');
    setEnviando(true);

    try {
      const resposta = await fetch('/api/acesso/entrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha }),
      });
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível entrar.');

      const retorno = new URLSearchParams(window.location.search).get('retorno') || '/';
      window.location.href = retorno.startsWith('/') && !retorno.startsWith('//') ? retorno : '/';
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível entrar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10 bg-slate-950">
      <section className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-7">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-blue-600">Acesso individual</p>
          <h1 className="text-2xl font-bold text-slate-900">Enriquecedor Bling PRO</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">Digite sua senha para acessar os produtos e as integrações.</p>
        </div>

        <form onSubmit={entrar} className="space-y-4">
          <div>
            <label htmlFor="senha" className="mb-1.5 block text-sm font-semibold text-slate-800">Senha</label>
            <input
              id="senha"
              name="senha"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={senha}
              onChange={evento => setSenha(evento.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-3 text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          {erro && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erro}</p>}
          <button
            type="submit"
            disabled={enviando}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
          >
            {enviando ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}
