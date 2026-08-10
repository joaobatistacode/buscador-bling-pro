import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { lerCorpoLimitado, naoAutorizado, temAcesso } from '@/lib/acesso';

const LIMITE_IMAGEM = 8 * 1024 * 1024;
const MAX_REDIRECIONAMENTOS = 3;

function ipv4Privado(endereco: string) {
  const partes = endereco.split('.').map(Number);
  if (partes.length !== 4) return true;
  const [a, b] = partes;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function ipPrivado(endereco: string) {
  const normalizado = endereco.toLowerCase().split('%')[0];
  if (isIP(normalizado) === 4) return ipv4Privado(normalizado);
  if (isIP(normalizado) !== 6) return true;
  if (normalizado === '::' || normalizado === '::1' || normalizado.startsWith('fc') ||
      normalizado.startsWith('fd') || /^fe[89ab]/.test(normalizado)) return true;
  const mapeado = normalizado.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapeado ? ipv4Privado(mapeado[1]) : false;
}

async function validarDestino(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Protocolo não permitido.');
  if (url.username || url.password) throw new Error('URL com credenciais não permitida.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Destino não permitido.');
  }

  const enderecos = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!enderecos.length || enderecos.some(item => ipPrivado(item.address))) {
    throw new Error('Destino não permitido.');
  }
}

function detectarTipo(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  const caixa = String.fromCharCode(...bytes.slice(4, 8));
  const marca = String.fromCharCode(...bytes.slice(8, 12));
  if (caixa === 'ftyp' && (marca === 'avif' || marca === 'avis')) return 'image/avif';
  return null;
}

async function baixar(inicial: URL) {
  let destino = inicial;
  for (let tentativa = 0; tentativa <= MAX_REDIRECIONAMENTOS; tentativa++) {
    await validarDestino(destino);
    const res = await fetch(destino, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EnriquecedorBling/1.0)',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: `${destino.origin}/`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const local = res.headers.get('location');
      if (!local || tentativa === MAX_REDIRECIONAMENTOS) throw new Error('Redirecionamento inválido.');
      destino = new URL(local, destino);
      continue;
    }
    return res;
  }
  throw new Error('Redirecionamentos em excesso.');
}

export async function GET(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  const alvo = new URL(request.url).searchParams.get('url');
  if (!alvo) return new Response('Faltou o parâmetro url.', { status: 400 });

  let destino: URL;
  try {
    destino = new URL(alvo);
  } catch {
    return new Response('URL inválida.', { status: 400 });
  }

  try {
    const res = await baixar(destino);
    if (!res.ok) return new Response(`origem devolveu ${res.status}`, { status: 502 });

    let corpo: Uint8Array<ArrayBuffer>;
    try {
      corpo = await lerCorpoLimitado(new Request(request.url, { body: res.body, headers: res.headers, method: 'POST', duplex: 'half' } as RequestInit), LIMITE_IMAGEM);
    } catch {
      return new Response('imagem ultrapassa o limite de 8 MB', { status: 413 });
    }
    if (!corpo.byteLength) return new Response('origem devolveu arquivo vazio', { status: 502 });

    const detectado = detectarTipo(corpo);
    if (!detectado) return new Response('o arquivo recebido não é uma imagem aceita', { status: 415 });

    return new Response(corpo, {
      headers: { 'Content-Type': detectado, 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : 'erro desconhecido';
    return new Response(`falha ao baixar: ${mensagem}`, { status: 502 });
  }
}
