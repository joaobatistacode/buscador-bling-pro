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

const MAX_HTML = 2_000_000;
const MAX_BYTES_IMAGEM = 512 * 1024;
const MAX_CANDIDATAS_VERIFICADAS = 36;
const AREA_MINIMA = 160_000;
const MAIOR_LADO_MINIMO = 400;
const AREA_PREFERIDA = 250_000;
const MAIOR_LADO_PREFERIDO = 600;

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

const normalizarReferencia = (valor: string) => valor
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export function referenciasCriticasProduto(termo: string) {
  const semFrequencias = normalizarReferencia(termo)
    .replace(/\b\d+(?:\s+\d+)?(?:KHZ|MHZ|GHZ|HZ)\b/g, ' ');
  const palavras = semFrequencias.split(' ').filter(Boolean);
  const unidades = new Set([
    'HZ', 'KHZ', 'MHZ', 'GHZ', 'MM', 'CM', 'M', 'G', 'KG', 'ML', 'L', 'V', 'W', 'UN',
    'UND', 'PC', 'PCT', 'CX', 'CJ', 'KIT', 'COM', 'SEM', 'POR', 'PARA', 'COR',
  ]);
  const sufixosCor = new Set([
    'PT', 'PTO', 'BR', 'BCO', 'CZ', 'CZA', 'PR', 'VM', 'AZ', 'AZL', 'VD', 'AM', 'AMA',
    'LR', 'LJA', 'RS', 'RSA', 'RX', 'MR', 'MRM', 'BEG', 'DOU', 'CH', 'TR',
  ]);
  const referencias = new Set<string>();

  palavras.forEach((palavra, indice) => {
    if (!/\d/.test(palavra)) return;
    referencias.add(palavra);
    const anterior = palavras[indice - 1];
    const proximo = palavras[indice + 1];
    // Prefixos antes do número continuam protegidos: PT-467, EP 02, TH-101.
    if (anterior && /^[A-Z]{1,3}$/.test(anterior) && !unidades.has(anterior)) referencias.add(anterior);
    // Depois do número, abreviações de cor descrevem a variação e não o modelo.
    // Ex.: TH-101 PT deve aceitar páginas cujo título contenha apenas TH-101.
    if (proximo && /^[A-Z]{1,3}$/.test(proximo) &&
        !unidades.has(proximo) && !sufixosCor.has(proximo)) referencias.add(proximo);
  });

  return palavras.filter((palavra, indice) => referencias.has(palavra) && palavras.indexOf(palavra) === indice);
}

export function referenciaCompativel(texto: string, termo: string) {
  const referencias = referenciasCriticasProduto(termo);
  if (!referencias.length) return true;
  const normalizado = normalizarReferencia(texto);
  const palavras = new Set(normalizado.split(' ').filter(Boolean));
  const compacto = normalizado.replace(/\s+/g, '');
  const numericas = referencias.filter(referencia => /\d/.test(referencia));
  return referencias.every(referencia => {
    if (palavras.has(referencia)) return true;
    if (/^[A-Z]{1,3}$/.test(referencia)) {
      return numericas.some(numero =>
        compacto.includes(`${referencia}${numero}`) || compacto.includes(`${numero}${referencia}`)
      );
    }
    return compacto.includes(referencia);
  });
}

const normalizarBuscaImagem = (nome: string) => nome
  .replace(/\bENCORD\b/gi, 'ENCORDOAMENTO')
  .replace(/\bS\/\s*FIO\b/gi, 'SEM FIO')
  .replace(/\bC\/\s*/gi, 'COM ')
  .replace(/\bS\/\s*/gi, 'SEM ')
  .replace(/\bVERM\b/gi, 'VERMELHO')
  .replace(/\bPTO\b/gi, 'PRETO')
  .replace(/\bBCO\b/gi, 'BRANCO')
  .replace(/\s+/g, ' ')
  .trim();

export const montarTermosImagem = (nome: string, sites: string[], limite: number): string[] => {
  const busca = normalizarBuscaImagem(nome);
  const palavras = busca.split(' ').filter(Boolean);
  const genericas = new Set([
    'MOUSE', 'SEM', 'FIO', 'COM', 'PARA', 'WIN', 'WINDOWS', 'GHZ', '2.4GHZ',
    'ALCANCE', 'METROS', 'METRO', 'UN', 'UNIDADE',
  ]);
  const referencias = referenciasCriticasProduto(busca);
  const conjuntoReferencias = new Set(referencias);
  const distintivas = palavras.filter(palavra =>
    conjuntoReferencias.has(normalizarReferencia(palavra)) ||
    (palavra.length > 2 && !genericas.has(palavra.toUpperCase()) && !/^\d+M$/i.test(palavra))
  );
  const termoPrincipal = distintivas.length >= 2 ? distintivas.join(' ') : busca;
  const termoEnxuto = distintivas
    .filter(palavra =>
      conjuntoReferencias.has(normalizarReferencia(palavra)) || palavra.length > 2 || /\d/.test(palavra)
    )
    .join(' ');

  // A consulta que o operador faria no Google deve ser sempre a primeira.
  // Aspas em cada pedaço de uma referência composta (ex.: "PT" "467")
  // reduzem demais o recall e não aceitam naturalmente PT467 / PT-467 / PT 467.
  // A compatibilidade do modelo é conferida depois, nos resultados e na página.
  const genericos = [busca, termoEnxuto || termoPrincipal];
  const consultasDeSites = sites.map(site => `${termoEnxuto || termoPrincipal} site:${site}`);
  const consultas = [...genericos, ...consultasDeSites];

  return [...new Set(consultas.map(termo => termo.trim()).filter(Boolean))].slice(0, limite);
};

export function identificacaoPagina(html: string, pagina: string) {
  const partes = [pagina];
  for (const item of html.matchAll(/<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi)) {
    partes.push(limpar(item[1]).slice(0, 500));
    if (partes.length >= 6) break;
  }
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const atributos = lerAtributos(tag[0]);
    const tipo = `${atributos.get('property') || ''} ${atributos.get('name') || ''}`;
    if (/(?:og:title|twitter:title|product:retailer_item_id|product:sku)/i.test(tipo)) {
      partes.push((atributos.get('content') || '').slice(0, 500));
    }
  }
  for (const item of html.matchAll(/["'](?:name|sku|mpn|model|productName|product_name)["']\s*:\s*["']([^"']+)["']/gi)) {
    partes.push(decodificarHtml(item[1]).slice(0, 500));
    if (partes.length >= 16) break;
  }
  return partes.join(' ');
}

const pareceDecorativa = (url: string) => /(?:^|[\/_\-.])(logo|icon|icone|sprite|banner|pixel|avatar|placeholder|loading|favicon)(?:[\/_\-.]|$)/i.test(url);
const pareceMiniatura = (url: string) =>
  /(?:^|[\/_\-.])(?:thumb|thumbnail|miniatura|small|tiny|lowres|_xs|_sm)(?:[\/_\-.]|$)/i.test(url) ||
  /[?&](?:w|width|h|height)=(?:[1-4]?\d{1,2})(?=&|#|$)/i.test(url);

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

function coletarImagensEstruturadas(valor: unknown, saida: string[], contextoImagem = false) {
  if (saida.length >= 80 || valor === null || valor === undefined) return;
  if (typeof valor === 'string') {
    if (contextoImagem && /^(?:https?:)?\/\//i.test(valor)) saida.push(valor);
    return;
  }
  if (Array.isArray(valor)) {
    valor.forEach(item => coletarImagensEstruturadas(item, saida, contextoImagem));
    return;
  }
  if (typeof valor !== 'object') return;
  const objeto = valor as Record<string, unknown>;
  for (const [chave, item] of Object.entries(objeto)) {
    const chaveImagem = /(?:image|imagem|photo|foto|gallery|galeria|media|picture)/i.test(chave);
    const chaveArquivo = /^(?:src|url|contentUrl|full|original|zoom|large|master)$/i.test(chave);
    const proximoContexto = contextoImagem || chaveImagem;
    if (typeof item === 'string') {
      if ((chaveImagem || (contextoImagem && chaveArquivo)) && /^(?:https?:)?\/\//i.test(item)) saida.push(item);
    } else if (typeof item === 'object' && item !== null) {
      coletarImagensEstruturadas(item, saida, proximoContexto);
    }
  }
}

export function extrairImagens(html: string, pagina: string, termo: string) {
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

  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const atributos = lerAtributos(script[1]);
    const tipo = (atributos.get('type') || '').toLowerCase();
    const id = (atributos.get('id') || '').toLowerCase();
    const corpo = script[2].trim();
    const pareceJson = tipo.includes('json') || id === '__next_data__' || id.includes('product-json');
    if (!pareceJson || corpo.length > 1_500_000) continue;
    try {
      const urls: string[] = [];
      coletarImagensEstruturadas(JSON.parse(corpo), urls);
      urls.forEach(url => adicionar(url, 'JSON_LD'));
    } catch { /* JSON embutido inválido não impede as outras estratégias. */ }
  }

  for (const bloco of html.matchAll(/["'](?:images?|gallery|galeria|media)["']\s*:\s*\[([\s\S]{0,120000}?)\]/gi)) {
    for (const item of bloco[1].matchAll(/["']((?:https?:)?\\?\/\\?\/[^"']+)["']/gi)) {
      adicionar(item[1], 'JSON_LD');
    }
  }

  for (const meta of html.matchAll(/<meta\b[^>]*>/gi)) {
    const atributos = lerAtributos(meta[0]);
    const tipo = atributos.get('property') || atributos.get('name') || '';
    if (/^(?:og:image(?::url)?|twitter:image(?::src)?)$/i.test(tipo)) adicionar(atributos.get('content') || '', 'META');
  }

  for (const tag of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const atributos = lerAtributos(tag[0]);
    const contexto = `${atributos.get('alt') || ''} ${atributos.get('title') || ''}`;
    const zoom = atributos.get('data-zoom-image') || atributos.get('data-zoom') ||
      atributos.get('data-large') || atributos.get('data-large-image') ||
      atributos.get('data-image-large') || atributos.get('data-full') ||
      atributos.get('data-full-image') || atributos.get('data-original') ||
      atributos.get('data-original-src') || atributos.get('data-image');
    if (zoom) adicionar(zoom, 'ZOOM', contexto);
    const srcset = atributos.get('data-srcset') || atributos.get('srcset');
    if (srcset) adicionar(melhorSrcset(srcset), 'SRCSET', contexto);
    const src = atributos.get('data-src') || atributos.get('data-lazy-src') ||
      atributos.get('data-lazy') || atributos.get('data-thumb') || atributos.get('src');
    if (src) adicionar(src, 'HTML', contexto);
  }

  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const atributos = lerAtributos(tag[0]);
    const href = atributos.get('href') || '';
    const contexto = [
      atributos.get('class'), atributos.get('id'), atributos.get('rel'),
      atributos.get('data-fancybox'), atributos.get('data-gallery'), atributos.get('aria-label'),
    ].filter(Boolean).join(' ');
    if (/(?:gallery|galeria|product|produto|image|imagem|zoom|lightbox|swiper|slick|fancybox)/i.test(contexto) ||
        /\.(?:avif|webp|png|jpe?g)(?:[?#]|$)/i.test(href)) adicionar(href, 'ZOOM', contexto);
  }

  for (const casa of html.matchAll(/["'](?:zoom|zoomImage|large|largeImage|full|fullImage|original|originalSrc|master|imageUrl|image_url)["']\s*:\s*["']([^"']+)["']/gi)) adicionar(casa[1], 'ZOOM');
  return candidatas.sort((a, b) => b.pontuacao - a.pontuacao).slice(0, 80);
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
  if (candidata.largura && candidata.altura) {
    return { ...candidata, largura: candidata.largura, altura: candidata.altura };
  }
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
  imagem.largura * imagem.altura >= AREA_MINIMA &&
  Math.max(imagem.largura, imagem.altura) >= MAIOR_LADO_MINIMO
);

const tamanhoPreferido = (imagem: CandidataImagem) => Boolean(
  imagem.largura && imagem.altura &&
  imagem.largura * imagem.altura >= AREA_PREFERIDA &&
  Math.max(imagem.largura, imagem.altura) >= MAIOR_LADO_PREFERIDO
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
  const ordenadas = [...porUrl.values()]
    .filter(item => !pareceDecorativa(item.url))
    .sort((a, b) => b.pontuacao - a.pontuacao);
  const comDimensoes = ordenadas.filter(item => item.largura && item.altura && tamanhoAceitavel(item));
  const semDimensoes = ordenadas.filter(item => !item.largura || !item.altura);
  const paraVerificar = [
    ...comDimensoes.slice(0, 20),
    ...semDimensoes.slice(0, Math.max(0, MAX_CANDIDATAS_VERIFICADAS - Math.min(20, comDimensoes.length))),
  ];
  const verificadas = (await Promise.all(paraVerificar.map(verificarImagem)))
    .filter((item): item is ImagemVerificada => Boolean(item && tamanhoAceitavel(item)))
    .sort((a, b) => {
      const areaA = (a.largura || 0) * (a.altura || 0);
      const areaB = (b.largura || 0) * (b.altura || 0);
      const preferenciaA = tamanhoPreferido(a) ? 100 : 0;
      const preferenciaB = tamanhoPreferido(b) ? 100 : 0;
      return (preferenciaB + b.pontuacao + Math.min(areaB / 100_000, 30)) -
        (preferenciaA + a.pontuacao + Math.min(areaA / 100_000, 30));
    });

  const escolhidas = new Map<string, CandidataImagem>();
  for (const imagem of verificadas) {
    const chave = chaveVisual(imagem.url);
    const anterior = escolhidas.get(chave);
    const area = (imagem.largura || 0) * (imagem.altura || 0);
    const areaAnterior = (anterior?.largura || 0) * (anterior?.altura || 0);
    if (!anterior || area > areaAnterior) escolhidas.set(chave, imagem);
  }
  const imagens = [...escolhidas.values()].slice(0, 24).map((imagem): ImagemPesquisada => ({
    url: imagem.url,
    paginaOrigem: imagem.paginaOrigem,
    largura: imagem.largura,
    altura: imagem.altura,
    origem: imagem.origem,
    metodo: imagem.metodo,
    qualidade: (imagem.largura || 0) * (imagem.altura || 0) >= 1_000_000 ? 'ALTA' : 'BOA',
  }));
  return {
    imagens,
    diagnostico: {
      candidatasRecebidas: candidatas.length,
      candidatasUnicas: porUrl.size,
      candidatasVerificadas: paraVerificar.length,
      comDimensoesDoSerper: paraVerificar.filter(item => item.largura && item.altura).length,
      aprovadas: imagens.length,
    },
  };
}

async function lerPagina(url: string, termo: string) {
  try {
    const resposta = await fetchSeguro(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalogoJB/2.0)', Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(7_000) });
    if (!resposta.ok || !String(resposta.headers.get('content-type')).includes('text/html')) return null;
    const html = new TextDecoder('utf-8', { fatal: false }).decode(await lerCorpoLimitado(resposta, MAX_HTML));
    const paginaFinal = resposta.url || url;
    const texto = limpar(html);
    return {
      texto: texto.slice(0, 12_000),
      imagens: extrairImagens(html, paginaFinal, termo),
      url: paginaFinal,
      referenciaConfirmada: referenciaCompativel(identificacaoPagina(html, paginaFinal), termo),
    };
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

export async function buscarImagensComGaleria(
  termo: string,
  chave: string,
  referenciaProduto = termo,
  permitirBuscaWeb = false
) {
  const dados = await chamarSerper('images', { q: termo, gl: 'br', hl: 'pt-br', num: 20 }, chave);
  const itens: ItemSerper[] = Array.isArray(dados.images) ? dados.images : [];
  const paginasCandidatas = [...new Set<string>(itens.map(item => String(item.link || item.sourceUrl || '')).filter(url => /^https?:\/\//i.test(url)))].slice(0, 6);
  const diretas: CandidataImagem[] = itens.filter(item => referenciaCompativel(
    `${String(item.title || '')} ${String(item.snippet || '')} ${String(item.link || item.sourceUrl || '')}`,
    referenciaProduto
  )).map((item): CandidataImagem => ({
    url: String(item.imageUrl || ''),
    paginaOrigem: String(item.link || item.sourceUrl || ''),
    largura: Number(item.imageWidth) > 0 ? Number(item.imageWidth) : null,
    altura: Number(item.imageHeight) > 0 ? Number(item.imageHeight) : null,
    origem: 'SERPER',
    metodo: 'SERPER',
    pontuacao: 60 - (pareceMiniatura(String(item.imageUrl || '')) ? 90 : 0),
  })).filter(item => /^https?:\/\//i.test(item.url));

  const primeiraPaginaLida = paginasCandidatas[0] ? await lerPagina(paginasCandidatas[0], referenciaProduto) : null;
  const primeiraPagina = primeiraPaginaLida?.referenciaConfirmada ? primeiraPaginaLida : null;
  const paginasLidas = primeiraPagina ? [primeiraPagina] : [];
  if (primeiraPagina) {
    const galeriaPrincipal = await selecionarImagens(primeiraPagina.imagens);
    if (galeriaPrincipal.imagens.length >= 4) {
      return {
        urls: galeriaPrincipal.imagens.map(imagem => imagem.url),
        detalhes: galeriaPrincipal.imagens,
        diagnostico: {
          ...galeriaPrincipal.diagnostico,
          modo: 'GALERIA_UNICA',
          paginaGaleria: primeiraPagina.url,
          paginasDescartadasReferencia: 0,
        },
        paginas: paginasCandidatas,
        paginasAbertas: 1,
        resultados: itens.length,
      };
    }
  }

  const paginasRestantesLidas = (await Promise.all(
    paginasCandidatas.slice(1).map(url => lerPagina(url, referenciaProduto))
  )).filter((pagina): pagina is NonNullable<typeof pagina> => Boolean(pagina));
  const paginasRestantes = paginasRestantesLidas.filter(pagina => pagina.referenciaConfirmada);
  paginasLidas.push(...paginasRestantes);
  const galeriasRestantes = await Promise.all(
    paginasRestantes.map(pagina => selecionarImagens(pagina.imagens))
  );
  const indiceGaleriaCompleta = galeriasRestantes.findIndex(galeria => galeria.imagens.length >= 4);
  if (indiceGaleriaCompleta >= 0) {
    const galeria = galeriasRestantes[indiceGaleriaCompleta];
    const pagina = paginasRestantes[indiceGaleriaCompleta];
    return {
      urls: galeria.imagens.map(imagem => imagem.url),
      detalhes: galeria.imagens,
      diagnostico: {
        ...galeria.diagnostico,
        modo: 'GALERIA_UNICA',
        paginaGaleria: pagina.url,
        paginasDescartadasReferencia: Number(Boolean(primeiraPaginaLida && !primeiraPagina)) +
          paginasRestantesLidas.filter(item => !item.referenciaConfirmada).length,
      },
      paginas: paginasCandidatas,
      paginasAbertas: Number(Boolean(primeiraPaginaLida)) + paginasRestantesLidas.length,
      resultados: itens.length,
    };
  }

  let selecao = await selecionarImagens([...paginasLidas.flatMap(pagina => pagina.imagens), ...diretas]);
  let paginasWebAbertas = 0;
  let paginasWebDescartadas = 0;
  let paginasWebDescobertas: string[] = [];
  let resultadosWeb = 0;
  let falhaBuscaWeb = false;

  // O Google comum pode encontrar a página correta mesmo quando a aba Imagens
  // não a entrega ao Serper. Nesse caso, abrimos os resultados orgânicos e
  // extraímos a galeria da página, mantendo a mesma validação de referência.
  if (permitirBuscaWeb && selecao.imagens.length < 4 && !/\bsite:/i.test(termo)) {
    try {
      const dadosWeb = await chamarSerper('search', {
        q: termo.replace(/"/g, ''), gl: 'br', hl: 'pt-br', num: 8,
      }, chave);
      const itensWeb: ItemSerper[] = [
        ...(Array.isArray(dadosWeb.shopping) ? dadosWeb.shopping : []),
        ...(Array.isArray(dadosWeb.organic) ? dadosWeb.organic : []),
      ];
      resultadosWeb = itensWeb.length;
      paginasWebDescobertas = [...new Set<string>(itensWeb
        .map(item => String(item.link || item.sourceUrl || ''))
        .filter(url => /^https?:\/\//i.test(url) && !paginasCandidatas.includes(url))
      )].slice(0, 6);
      const paginasWebLidas = (await Promise.all(
        paginasWebDescobertas.map(url => lerPagina(url, referenciaProduto))
      )).filter((pagina): pagina is NonNullable<typeof pagina> => Boolean(pagina));
      paginasWebAbertas = paginasWebLidas.length;
      const paginasWebConfirmadas = paginasWebLidas.filter(pagina => pagina.referenciaConfirmada);
      paginasWebDescartadas = paginasWebLidas.length - paginasWebConfirmadas.length;

      for (const pagina of paginasWebConfirmadas) {
        const galeria = await selecionarImagens(pagina.imagens);
        if (galeria.imagens.length >= 4) {
          return {
            urls: galeria.imagens.map(imagem => imagem.url),
            detalhes: galeria.imagens,
            diagnostico: {
              ...galeria.diagnostico,
              modo: 'GALERIA_WEB',
              paginaGaleria: pagina.url,
              paginasDescartadasReferencia: Number(Boolean(primeiraPaginaLida && !primeiraPagina)) +
                paginasRestantesLidas.filter(item => !item.referenciaConfirmada).length +
                paginasWebDescartadas,
              resultadosWeb,
              paginasWebAbertas,
            },
            paginas: [...paginasCandidatas, ...paginasWebDescobertas],
            paginasAbertas: Number(Boolean(primeiraPaginaLida)) + paginasRestantesLidas.length + paginasWebAbertas,
            resultados: itens.length + resultadosWeb,
          };
        }
      }

      const diretasWeb: CandidataImagem[] = itensWeb.filter(item =>
        referenciaCompativel(
          `${String(item.title || '')} ${String(item.snippet || '')} ${String(item.link || item.sourceUrl || '')}`,
          referenciaProduto
        ) && /^https?:\/\//i.test(String(item.imageUrl || ''))
      ).map((item): CandidataImagem => ({
        url: String(item.imageUrl || ''),
        paginaOrigem: String(item.link || item.sourceUrl || ''),
        largura: Number(item.imageWidth) > 0 ? Number(item.imageWidth) : null,
        altura: Number(item.imageHeight) > 0 ? Number(item.imageHeight) : null,
        origem: 'SERPER',
        metodo: 'SERPER',
        pontuacao: 55 - (pareceMiniatura(String(item.imageUrl || '')) ? 90 : 0),
      }));
      selecao = await selecionarImagens([
        ...paginasLidas.flatMap(pagina => pagina.imagens),
        ...paginasWebConfirmadas.flatMap(pagina => pagina.imagens),
        ...diretas,
        ...diretasWeb,
      ]);
    } catch {
      // Uma falha no fallback não deve apagar opções válidas da busca de imagens.
      falhaBuscaWeb = true;
    }
  }

  return {
    urls: selecao.imagens.map(imagem => imagem.url),
    detalhes: selecao.imagens,
    diagnostico: {
      ...selecao.diagnostico,
      modo: 'COMBINADO',
      paginaGaleria: null,
      paginasDescartadasReferencia: Number(Boolean(primeiraPaginaLida && !primeiraPagina)) +
        paginasRestantesLidas.filter(item => !item.referenciaConfirmada).length + paginasWebDescartadas,
      resultadosWeb,
      paginasWebAbertas,
      falhaBuscaWeb,
    },
    paginas: [...paginasCandidatas, ...paginasWebDescobertas],
    paginasAbertas: Number(Boolean(primeiraPaginaLida)) + paginasRestantesLidas.length + paginasWebAbertas,
    resultados: itens.length + resultadosWeb,
  };
}
