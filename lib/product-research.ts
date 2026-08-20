export interface FonteProduto { titulo: string; url: string; trecho: string }
interface ItemSerper { title?: unknown; link?: unknown; sourceUrl?: unknown; snippet?: unknown; imageUrl?: unknown }

const limpar = (texto: string) => texto
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/\s+/g, ' ')
  .trim();

const urlPublica = (valor: string) => {
  try {
    const url = new URL(valor);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || host === 'localhost' || host.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    return url;
  } catch { return null; }
};

const absoluta = (valor: string, base: string) => {
  try { const url = new URL(valor, base); return urlPublica(url.href)?.href || ''; } catch { return ''; }
};

function extrairImagens(html: string, pagina: string) {
  const candidatas: string[] = [];
  const padroes = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/gi,
    /<(?:img|source)[^>]+(?:src|data-src|data-zoom-image|data-large|data-original)=["']([^"']+)["']/gi,
    /"image"\s*:\s*"(https?:\\?\/\\?\/[^"\\]+(?:\\.[^"\\]*)?)"/gi,
  ];
  for (const padrao of padroes) {
    let casa: RegExpExecArray | null;
    while ((casa = padrao.exec(html)) && candidatas.length < 80) {
      const bruto = casa[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
      const url = absoluta(bruto, pagina);
      if (url && !/logo|icon|sprite|banner|pixel|avatar/i.test(url) && !candidatas.includes(url)) candidatas.push(url);
    }
  }
  return candidatas;
}

async function lerPagina(url: string) {
  if (!urlPublica(url)) return null;
  try {
    const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalogoJB/1.0)' }, redirect: 'follow', signal: AbortSignal.timeout(7_000) });
    if (!resposta.ok || !String(resposta.headers.get('content-type')).includes('text/html')) return null;
    const bytes = new Uint8Array(await resposta.arrayBuffer()).slice(0, 1_200_000);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { texto: limpar(html).slice(0, 12_000), imagens: extrairImagens(html, resposta.url || url), url: resposta.url || url };
  } catch { return null; }
}

async function chamarSerper(endpoint: 'search' | 'images', corpo: object, chave: string) {
  const resposta = await fetch(`https://google.serper.dev/${endpoint}`, { method: 'POST', headers: { 'X-API-KEY': chave, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(8_000) });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(String(dados.message || dados.error || `Serper HTTP ${resposta.status}`));
  return dados;
}

export async function pesquisarEspecificacoes(nome: string, chave: string): Promise<FonteProduto[]> {
  if (!chave) return [];
  try {
    const dados = await chamarSerper('search', { q: `"${nome}" peso dimensões ficha técnica`, gl: 'br', hl: 'pt-br', num: 6 }, chave);
    const resultados: ItemSerper[] = Array.isArray(dados.organic) ? dados.organic.slice(0, 5) : [];
    const paginas = await Promise.all(resultados.slice(0, 3).map(r => lerPagina(String(r.link || ''))));
    return resultados.map((r, indice: number) => ({ titulo: String(r.title || '').slice(0, 200), url: String(r.link || '').slice(0, 2000), trecho: [String(r.snippet || ''), paginas[indice]?.texto || ''].join(' ').slice(0, 7000) })).filter((f: FonteProduto) => f.url && f.trecho);
  } catch { return []; }
}

export async function buscarImagensComGaleria(termo: string, chave: string) {
  const dados = await chamarSerper('images', { q: termo, gl: 'br', hl: 'pt-br', num: 12 }, chave);
  const itens: ItemSerper[] = Array.isArray(dados.images) ? dados.images : [];
  const diretas = itens.map(item => String(item.imageUrl || '')).filter((url: string) => /^https?:\/\//i.test(url));
  const paginas: string[] = [...new Set<string>(itens.map(item => String(item.link || item.sourceUrl || '')).filter((url: string) => /^https?:\/\//i.test(url)))].slice(0, 3);
  const galerias = await Promise.all(paginas.map(lerPagina));
  const urls = [...galerias.flatMap(p => p?.imagens || []), ...diretas];
  return { urls: [...new Set(urls)].slice(0, 24), paginas, resultados: itens.length };
}
