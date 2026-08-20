const cabecalhos = () => {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const chave = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !chave) throw new Error('Supabase não configurado na Vercel.');
  return {
    url,
    headers: {
      apikey: chave,
      Authorization: `Bearer ${chave}`,
      'Content-Type': 'application/json',
    },
  };
};

export async function supabaseRest(
  caminho: string,
  init: RequestInit = {},
  timeout = 12_000
) {
  const { url, headers } = cabecalhos();
  const resposta = await fetch(`${url}/rest/v1/${caminho}`, {
    ...init,
    headers: { ...headers, Prefer: 'return=representation', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeout),
    cache: 'no-store',
  });
  const texto = await resposta.text();
  const dados = texto ? JSON.parse(texto) : null;
  if (!resposta.ok) {
    throw new Error(String(dados?.message || dados?.hint || `Supabase HTTP ${resposta.status}`));
  }
  return dados;
}

export const textoSeguro = (valor: unknown, limite = 500) =>
  String(valor ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, limite);
