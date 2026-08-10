import {
  lerCorpoLimitado,
  naoAutorizado,
  origemInvalida,
  origemPermitida,
  temAcesso,
} from '@/lib/acesso';

// A imagem final continua sendo gerada no navegador em 420x420. Este endpoint
// apenas valida e envia o JPEG/PNG ao bucket privado de escrita.
const BUCKET = 'produtos-bling';
const LIMITE_IMAGEM = 2 * 1024 * 1024;
const CAMINHO_SEGURO = /^[a-zA-Z0-9._-]{1,100}\/[a-zA-Z0-9._-]{1,120}\.(?:jpe?g|png)$/i;

function assinaturaValida(corpo: Uint8Array, tipo: string) {
  if (tipo === 'image/jpeg') return corpo[0] === 0xff && corpo[1] === 0xd8;
  if (tipo === 'image/png') {
    return corpo[0] === 0x89 && corpo[1] === 0x50 && corpo[2] === 0x4e && corpo[3] === 0x47;
  }
  return false;
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();

  const urlSupabase = process.env.SUPABASE_URL;
  const chaveServico = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!urlSupabase || !chaveServico) {
    return Response.json(
      { erro: 'Faltam as variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na Vercel.' },
      { status: 500 }
    );
  }

  const caminho = new URL(request.url).searchParams.get('caminho') || '';
  if (!CAMINHO_SEGURO.test(caminho) || caminho.includes('..')) {
    return Response.json({ erro: 'Caminho de imagem inválido.' }, { status: 400 });
  }

  const tipo = (request.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (tipo !== 'image/jpeg' && tipo !== 'image/png') {
    return Response.json({ erro: 'Envie uma imagem JPEG ou PNG.' }, { status: 415 });
  }

  let corpo: Uint8Array<ArrayBuffer>;
  try {
    corpo = await lerCorpoLimitado(request, LIMITE_IMAGEM);
  } catch {
    return Response.json({ erro: 'A imagem ultrapassa o limite de 2 MB.' }, { status: 413 });
  }
  if (!corpo.byteLength) return Response.json({ erro: 'A imagem chegou vazia.' }, { status: 400 });
  if (!assinaturaValida(corpo, tipo)) {
    return Response.json({ erro: 'O conteúdo não corresponde ao formato informado.' }, { status: 415 });
  }

  const base = urlSupabase.replace(/\/$/, '');
  const destino = `${base}/storage/v1/object/${BUCKET}/${caminho}`;

  try {
    const res = await fetch(destino, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${chaveServico}`,
        'Content-Type': tipo,
        'x-upsert': 'true',
      },
      body: corpo,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detalhe = await res.text().catch(() => '');
      return Response.json(
        { erro: `Supabase recusou (${res.status}): ${detalhe.slice(0, 200)}` },
        { status: 502 }
      );
    }

    return Response.json({
      url: `${base}/storage/v1/object/public/${BUCKET}/${caminho}`,
    });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : 'erro desconhecido';
    return Response.json({ erro: `Falha no upload: ${mensagem}` }, { status: 502 });
  }
}
