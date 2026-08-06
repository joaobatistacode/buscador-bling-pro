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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return new Response('A origem recusou a imagem.', { status: res.status });
    }

    const tipo = res.headers.get('content-type') || '';
    if (!tipo.startsWith('image/')) {
      return new Response('O endereço não devolveu uma imagem.', { status: 415 });
    }

    return new Response(await res.arrayBuffer(), {
      headers: {
        'Content-Type': tipo,
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (e: any) {
    return new Response(`Falha ao baixar: ${e.message}`, { status: 502 });
  }
}
