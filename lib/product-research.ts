import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface FonteProduto { titulo: string; url: string; trecho: string }

export interface ImagemPesquisada {
  url: string;
  paginaOrigem: string;
  largura: number | null;
  altura: number | null;
  origem: 'GALERIA' | 'SERPER';
  metodo: 'ZOOM' | 'SRCSET' | 'JSON_LD' | 'META' | 'HTML' | 'SERPER';
  qualidade: 'ALTA' | 'BOA';
}

interface ItemSerper {
  title?: unknown; link?: unknown; sourceUrl?: unknown; snippet?: unknown;
  imageUrl?: unknown; imageWidth?: unknown; imageHeight?: unknown;
}

interface CandidataImagem {
  url: string;
  paginaOrigem: string;
  largura: number | null;
  altura: number | null;
  origem: ImagemPesquisada['origem'];
  metodo: ImagemPesquisada['metodo'];
  pontuacao: number;
}

type ImagemVerificada = Omit<CandidataImagem, 'largura' | 'altura'> & {
  largura: number;
  altura: number;
};

const MAX_HTML = 1_200_000;
const MAX_BYTES_IMAGEM = 512 * 1024;
const MAX_CANDIDATAS_VERIFICADAS = 20;

const limpar = (texto: string) => texto
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/\s+/g, ' ')
  .trim();

const decodificarHtml = (valor: string) => valor
  .replace(/\\u0026/gi, '&')
  .replace(/\\\//g, '/')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .trim();

const ipv4Privado = (endereco: string) => {
  const partes = endereco.split('.').map(Number);
  if (partes.length !== 4) return true;
  const [a, b] = partes;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
};

const ipPrivado = (endereco: string) => {
  const normalizado = endereco.toLowerCase().split('%')[0];
  if (isIP(normalizado) === 4) return ipv4Privado(normalizado);
  if (isIP(normalizado) !== 6) return true;
  if (normalizado === '::' || normalizado === '::1' || normalizado.startsWith('fc') ||
      normalizado.startsWith('fd') || /^fe[89ab]/.test(normalizado)) return true;
  const mapeado = normalizado.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapeado ? ipv4Privado(mapeado[1]) : false;
};

async function urlPublica(valor: string) {
  try {
    const url = new URL(valor);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    const enderecos = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!enderecos.length || enderecos.some(item => ipPrivado(item.address))) return null;
    return url;
  } catch { return null; }
}

async function fetchSeguro(inicial: string, opcoes: RequestInit) {
  let destino = await urlPublica(inicial);
  if (!destino) throw new Error('Destino não permitido.');
  for (let redirecionamento = 0; redirecionamento <= 3; redirecionamento++) {
    const resposta = await fetch(destino, { ...opcoes, redirect: 'manual' });
    if (resposta.status < 300 || resposta.status >= 400) return resposta;
    const local = resposta.headers.get('location');
    if (!local || redirecionamento === 3) throw new Error('Redirecionamento inválido.');
    destino = await urlPublica(new URL(local, destino).href);
    if (!destino) throw new Error('Destino não permitido.');
  }
  throw new Error('Redirecionamentos em excesso.');
}

const absoluta = (valor: string, base: string) => {
  try {
    const url = new URL(decodificarHtml(valor), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
};

const tokensProduto = (termo: string) => termo
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/)
  .filter(token => token.length >= 3 && !['com', 'sem', 'para', 'produto', 'site'].includes(token));

const pareceDecorativa = (url: string) => /(?:^|[\/_\-.])(logo|icon|icone|sprite|banner|pixel|avatar|placeholder|loading|favicon)(?:[\/_\-.]|$)/i.test(url);
const pareceMiniatura = (url: string) => /(?:thumb|thumbnail|miniatura|small|tiny|lowres|_xs(?:[_.-]|$)|_sm(?:[_.-]|$)|[?&](?:w|width|h|height)=(?:[1-4]?\d{1,2}))(?:[^a-z]|$)/i.test(url);

function lerAtributos(tag: string) {
  const atributos = new Map<string, string>();
  const padrao = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let casa: RegExpExecArray | null;
  while ((casa = padrao.exec(tag))) atributos.set(casa[1].toLowerCase(), casa[2] ?? casa[3] ?? casa[4] ?? '');
  return atributos;
}

function melhorSrcset(valor: string) {
  return valor.split(',').map(item => {
    const partes = item.trim().split(/\s+/);
    const medida = partes[1]?.match(/^(\d+)(?:w|x)$/i);
    return { url: partes[0] || '', medida: medida ? Number(medida[1]) : 0 };
  }).filter(item => item.url).sort((a, b) => b.medida - a.medida)[0]?.url || '';
}

function coletarImagensJsonLd(valor: unknown, saida: string[]) {
  if (saida.length >= 40 || valor === null || valor === undefined) return;
  if (typeof valor === 'string') {
    if (/^https?:\/\//i.test(valor)) saida.push(valor);
    return;
  }
  if (Array.isArray(valor)) {
    valor.forEach(item => coletarImagensJsonLd(item, saida));
    return;
  }
  if (typeof valor !== 'object') return;
  const objeto = valor as Record<string, unknown>;
  for (const [chave, item] of Object.entries(objeto)) {
    if (/^(?:image|images|contentUrl)$/i.test(chave)) coletarImagensJsonLd(item, saida);
    else if (typeof item === 'object' && item !== null) coletarImagensJsonLd(item, saida);
  }
}

function extrairImagens(html: string, pagina: string, termo: string) {
  const candidatas: CandidataImagem[] = [];
  const tokens = tokensProduto(termo);
  const adicionar = (bruto: string, metodo: CandidataImagem['metodo'], contexto = '') => {
    const url = absoluta(bruto, pagina);
    if (!url || pareceDecorativa(url)) return;
    const texto = `${url} ${contexto}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const relevancia = tokens.filter(token => texto.includes(token)).length;
    const base = { ZOOM: 120, SRCSET: 110, JSON_LD: 105, META: 80, HTML: 55, SERPER: 60 }[metodo];
    const pontuacao = base + relevancia * 8 - (pareceMiniatura(url) ? 90 : 0);
    const existente = candidatas.find(item => item.url === url);
    if (!existente) candidatas.push({ url, paginaOrigem: pagina, largura: null, altura: null, origem: 'GALERIA', metodo, pontuacao });
    else if (pontuacao > existente.pontuacao) Object.assign(existente, { metodo, pontuacao });
  };

  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    try {
      const urls: string[] = [];
      coletarImagensJsonLd(JSON.parse(script[1]), urls);
      urls.forEach(url => adicionar(url, 'JSON_LD'));
    } catch { /* JSON-LD inválido não impede as outras estratégias. */ }
  }

  for (const meta of html.matchAll(/<meta\b[^>]*>/gi)) {
    const atributos = lerAtributos(meta[0]);
    const tipo = atributos.get('property') || atributos.get('name') || '';
    if (/^(?:og:image(?::url)?|twitter:image(?::src)?)$/i.test(tipo)) adicionar(atributos.get('content') || '', 'META');
  }

  for (const tag of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const atributos = lerAtributos(tag[0]);
    const contexto = `${atributos.get('alt') || ''} ${atributos.get('title') || ''}`;
    const zoom = atributos.get('data-zoom-image') || atributos.get('data-large') ||
      atributos.get('data-large-image') || atributos.get('data-original');
    if (zoom) adicionar(zoom, 'ZOOM', contexto);
    const srcset = atributos.get('data-srcset') || atributos.get('srcset');
    if (srcset) adicionar(melhorSrcset(srcset), 'SRCSET', contexto);
    const src = atributos.get('data-src') || atributos.get('data-lazy-src') || atributos.get('src');
    if (src) adicionar(src, 'HTML', contexto);
  }

  for (const casa of html.matchAll(/["'](?:zoom|zoomImage|largeImage|fullImage|original|imageUrl)["']\s*:\s*["']([^"']+)["']/gi)) adicionar(casa[1], 'ZOOM');
  return candidatas.sort((a, b) => b.pontuacao - a.pontuacao).slice(0, 40);
}

async function lerCorpoLimitado(resposta: Response, limite: number) {
  const leitor = resposta.body?.getReader();
  if (!leitor) return new Uint8Array();
  const partes: Uint8Array[] = [];
  let total = 0;
  while (total < limite) {
    const { done, value } = await leitor.read();
    if (done || !value) break;
    const parte = value.slice(0, limite - total);
    partes.push(parte);
    total += parte.length;
  }
  await leitor.cancel().catch(() => undefined);
  const unificado = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) { unificado.set(parte, posicao); posicao += parte.length; }
  return unificado;
}

function dimensoesImagem(bytes: Uint8Array): { largura: number; altura: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { largura: view.getUint32(16), altura: view.getUint32(20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { largura: bytes[6] | (bytes[7] << 8), altura: bytes[8] | (bytes[9] << 8) };
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const tipo = String.fromCharCode(...bytes.slice(12, 16));
    if (tipo === 'VP8X') return { largura: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), altura: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (tipo === 'VP8L') return { largura: 1 + (((bytes[21] & 0x3f) << 8) | bytes[20]), altura: 1 + (((bytes[23] & 0x0f) << 10) | (bytes[22] << 2) | ((bytes[21] & 0xc0) >> 6)) };
    if (tipo === 'VP8 ') {
      for (let i = 20; i + 6 < bytes.length; i++) {
        if (bytes[i] === 0x9d && bytes[i + 1] === 0x01 && bytes[i + 2] === 0x2a) {
          return { largura: (bytes[i + 3] | (bytes[i + 4] << 8)) & 0x3fff, altura: (bytes[i + 5] | (bytes[i + 6] << 8)) & 0x3fff };
        }
      }
    }
  }
  if (bytes.length >= 32 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 4; i + 12 <= bytes.length; i++) {
      if (String.fromCharCode(...bytes.slice(i, i + 4)) !== 'ispe') continue;
      const largura = view.getUint32(i + 4);
      const altura = view.getUint32(i + 8);
      if (largura > 0 && altura > 0 && largura < 100_000 && altura < 100_000) return { largura, altura };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let posicao = 2;
    while (posicao + 8 < bytes.length) {
      if (bytes[posicao] !== 0xff) { posicao++; continue; }
      const marcador = bytes[posicao + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marcador)) {
        return { altura: (bytes[posicao + 5] << 8) | bytes[posicao + 6], largura: (bytes[posicao + 7] << 8) | bytes[posicao + 8] };
      }
      const tamanho = (bytes[posicao + 2] << 8) | bytes[posicao + 3];
      if (tamanho < 2) break;
      posicao += tamanho + 2;
    }
  }
  return null;
}

async function verificarImagem(candidata: CandidataImagem): Promise<ImagemVerificada | null> {
  try {
    const resposta = await fetchSeguro(candidata.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CatalogoJB/2.0)',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: candidata.paginaOrigem,
        Range: `bytes=0-${MAX_BYTES_IMAGEM - 1}`,
      },
      signal: AbortSignal.timeout(7_000),
    });
    if (!resposta.ok || !String(resposta.headers.get('content-type')).toLowerCase().startsWith('image/')) return null;
    const dimensoes = dimensoesImagem(await lerCorpoLimitado(resposta, MAX_BYTES_IMAGEM));
    return dimensoes ? { ...candidata, largura: dimensoes.largura, altura: dimensoes.altura } : null;
  } catch { return null; }
}

const tamanhoAceitavel = (imagem: CandidataImagem) => Boolean(
  imagem.largura && imagem.altura &&
  imagem.largura * imagem.altura >= 250_000 &&
  Math.max(imagem.largura, imagem.altura) >= 600
);

const chaveVisual = (url: string) => {
  try {
    const valor = new URL(url);
    ['w', 'width', 'h', 'height', 'resize', 'quality', 'q'].forEach(chave => valor.searchParams.delete(chave));
    return `${valor.hostname}${valor.pathname}`.toLowerCase();
  } catch { return url.toLowerCase(); }
};

async function selecionarImagens(candidatas: CandidataImagem[]) {
  const porUrl = new Map<string, CandidataImagem>();
  for (const candidata of candidatas) {
    const anterior = porUrl.get(candidata.url);
    if (!anterior || candidata.pontuacao > anterior.pontuacao) porUrl.set(candidata.url, candidata);
  }
  const paraVerificar = [...porUrl.values()]
    .filter(item => !pareceDecorativa(item.url) && !pareceMiniatura(item.url))
    .sort((a, b) => b.pontuacao - a.pontuacao)
    .slice(0, MAX_CANDIDATAS_VERIFICADAS);
  const verificadas = (await Promise.all(paraVerificar.map(verificarImagem)))
    .filter((item): item is ImagemVerificada => Boolean(item && tamanhoAceitavel(item)))
    .sort((a, b) => {
      const areaA = (a.largura || 0) * (a.altura || 0);
      const areaB = (b.largura || 0) * (b.altura || 0);
      return (b.pontuacao + Math.min(areaB / 100_000, 30)) - (a.pontuacao + Math.min(areaA / 100_000, 30));
    });

  const escolhidas = new Map<string, CandidataImagem>();
  for (const imagem of verificadas) {
    const chave = chaveVisual(imagem.url);
    const anterior = escolhidas.get(chave);
    const area = (imagem.largura || 0) * (imagem.altura || 0);
    const areaAnterior = (anterior?.largura || 0) * (anterior?.altura || 0);
    if (!anterior || area > areaAnterior) escolhidas.set(chave, imagem);
  }
  return [...escolhidas.values()].slice(0, 24).map((imagem): ImagemPesquisada => ({
    url: imagem.url,
    paginaOrigem: imagem.paginaOrigem,
    largura: imagem.largura,
    altura: imagem.altura,
    origem: imagem.origem,
    metodo: imagem.metodo,
    qualidade: (imagem.largura || 0) * (imagem.altura || 0) >= 1_000_000 ? 'ALTA' : 'BOA',
  }));
}

async function lerPagina(url: string, termo: string) {
  try {
    const resposta = await fetchSeguro(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalogoJB/2.0)', Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(7_000) });
    if (!resposta.ok || !String(resposta.headers.get('content-type')).includes('text/html')) return null;
    const html = new TextDecoder('utf-8', { fatal: false }).decode(await lerCorpoLimitado(resposta, MAX_HTML));
    const paginaFinal = resposta.url || url;
    return { texto: limpar(html).slice(0, 12_000), imagens: extrairImagens(html, paginaFinal, termo), url: paginaFinal };
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
    const paginas = await Promise.all(resultados.slice(0, 3).map(r => lerPagina(String(r.link || ''), nome)));
    return resultados.map((r, indice: number) => ({ titulo: String(r.title || '').slice(0, 200), url: String(r.link || '').slice(0, 2000), trecho: [String(r.snippet || ''), paginas[indice]?.texto || ''].join(' ').slice(0, 7000) })).filter((f: FonteProduto) => f.url && f.trecho);
  } catch { return []; }
}

export async function buscarImagensComGaleria(termo: string, chave: string) {
  const dados = await chamarSerper('images', { q: termo, gl: 'br', hl: 'pt-br', num: 12 }, chave);
  const itens: ItemSerper[] = Array.isArray(dados.images) ? dados.images : [];
  const paginasCandidatas = [...new Set<string>(itens.map(item => String(item.link || item.sourceUrl || '')).filter(url => /^https?:\/\//i.test(url)))].slice(0, 4);
  const paginasLidas = (await Promise.all(paginasCandidatas.map(url => lerPagina(url, termo)))).filter((pagina): pagina is NonNullable<typeof pagina> => Boolean(pagina));
  const diretas: CandidataImagem[] = itens.map((item): CandidataImagem => ({
    url: String(item.imageUrl || ''),
    paginaOrigem: String(item.link || item.sourceUrl || ''),
    largura: Number(item.imageWidth) > 0 ? Number(item.imageWidth) : null,
    altura: Number(item.imageHeight) > 0 ? Number(item.imageHeight) : null,
    origem: 'SERPER',
    metodo: 'SERPER',
    pontuacao: 60 - (pareceMiniatura(String(item.imageUrl || '')) ? 90 : 0),
  })).filter(item => /^https?:\/\//i.test(item.url));
  const detalhes = await selecionarImagens([...paginasLidas.flatMap(pagina => pagina.imagens), ...diretas]);
  return {
    urls: detalhes.map(imagem => imagem.url),
    detalhes,
    paginas: paginasCandidatas,
    paginasAbertas: paginasLidas.length,
    resultados: itens.length,
  };
}
