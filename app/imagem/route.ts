// Proxy de imagem: o navegador bloqueia (CORS) desenhar no canvas imagens
// vindas de outros domínios, então elas passam por aqui e chegam como
// se fossem do nosso próprio site.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const alvo = searchParams.get('url');

  if (!alvo) {
    return new Response('Faltou o parâmetro url.', { status: 400 });
  }

  let destino: URL;
  try {
    destino = new URL(alvo);
  } catch {
    return new Response('URL inválida.', { status: 400 });
  }

  if (destino.protocol !== 'http:' && destino.protocol !== 'https:') {
    return new Response('Protocolo não permitido.', { status: 400 });
  }

  try {
    const res = await fetch(destino, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        // Vários sites recusam download sem Referer do próprio domínio.
        'Referer': destino.origin + '/',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      return new Response(`origem devolveu ${res.status}`, { status: 502 });
    }

    const corpo = await res.arrayBuffer();

    if (corpo.byteLength === 0) {
      return new Response('origem devolveu arquivo vazio', { status: 502 });
    }

    // Alguns servidores mandam content-type errado (octet-stream), então
    // confiamos na assinatura dos bytes quando o cabeçalho não ajuda.
    const tipoInformado = res.headers.get('content-type') || '';
    const tipo = tipoInformado.startsWith('image/')
      ? tipoInformado
      : detectarTipo(new Uint8Array(corpo));

    if (!tipo) {
      return new Response(`não é imagem (content-type: ${tipoInformado || 'vazio'})`, { status: 415 });
    }

    return new Response(corpo, {
      headers: {
        'Content-Type': tipo,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e: any) {
    return new Response(`falha ao baixar: ${e.message}`, { status: 502 });
  }
}

// Identifica o formato pelos primeiros bytes do arquivo.
function detectarTipo(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';

  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';

  return null;
}
