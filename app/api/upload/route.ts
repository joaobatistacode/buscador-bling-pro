// Sobe a imagem já tratada (420x420) para o Supabase Storage e devolve a URL
// pública. Isso é necessário porque a API do Bling só aceita imagem por link:
// não existe upload de arquivo nem base64 no cadastro de produto.
//
// O upload passa pelo servidor de propósito: a chave service_role não pode
// aparecer no navegador, senão qualquer um conseguiria escrever no bucket.

const BUCKET = 'produtos-bling';

export async function POST(request: Request) {
  const urlSupabase = process.env.SUPABASE_URL;
  const chaveServico = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!urlSupabase || !chaveServico) {
    return Response.json(
      { erro: 'Faltam as variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na Vercel.' },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const caminhoPedido = searchParams.get('caminho');

  if (!caminhoPedido) {
    return Response.json({ erro: 'Faltou o parâmetro caminho.' }, { status: 400 });
  }

  // Só letras, números, ponto, hífen, underscore e barra: evita que um código
  // de produto estranho vire um caminho inesperado dentro do bucket.
  const caminho = caminhoPedido.replace(/[^a-zA-Z0-9._\-/]/g, '-').replace(/\.{2,}/g, '-');

  const corpo = await request.arrayBuffer();
  if (corpo.byteLength === 0) {
    return Response.json({ erro: 'A imagem chegou vazia.' }, { status: 400 });
  }

  const destino = `${urlSupabase.replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${caminho}`;

  try {
    const res = await fetch(destino, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${chaveServico}`,
        'Content-Type': request.headers.get('content-type') || 'image/jpeg',
        // Reenviar o mesmo produto substitui a imagem em vez de dar erro.
        'x-upsert': 'true',
      },
      body: corpo,
    });

    if (!res.ok) {
      const detalhe = await res.text().catch(() => '');
      return Response.json(
        { erro: `Supabase recusou (${res.status}): ${detalhe.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const publica = `${urlSupabase.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${caminho}`;
    return Response.json({ url: publica });

  } catch (e: any) {
    return Response.json({ erro: `Falha no upload: ${e.message}` }, { status: 502 });
  }
}
