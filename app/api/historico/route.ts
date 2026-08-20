import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest, textoSeguro } from '@/lib/supabase-admin';

const camposProduto = 'id,codigo,nome,curta,marca,peso,largura,altura,profundidade,origem_medidas,fonte_medidas,imagens,status,revisado,enviado_em,created_at,updated_at';

function produtoValido(item: unknown) {
  const p = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  const codigo = textoSeguro(p.codigo, 80);
  const nome = textoSeguro(p.nome, 300);
  if (!codigo || !nome) return null;
  const imagens = ['img1', 'img2', 'img3', 'img4']
    .map(campo => textoSeguro(p[campo], 2000))
    .filter(url => /^https?:\/\//i.test(url));
  return {
    codigo, nome,
    curta: textoSeguro(p.curta, 136),
    marca: textoSeguro(p.marca, 120),
    peso: textoSeguro(p.peso, 40),
    largura: textoSeguro(p.largura, 40),
    altura: textoSeguro(p.altura, 40),
    profundidade: textoSeguro(p.profundidade, 40),
    origem_medidas: textoSeguro(p.origemMedidas, 30) || 'ESTIMADO',
    fonte_medidas: textoSeguro(p.fonteMedidas, 2000) || null,
    justificativa_medidas: textoSeguro(p.justificativaMedidas, 600) || null,
    imagens,
    revisado: p.revisado === true,
    status: p.enviadoBling === true ? 'ENVIADO' : p.revisado === true ? 'REVISADO' : 'REVISAO',
    enviado_em: p.enviadoEm ? textoSeguro(p.enviadoEm, 40) : null,
  };
}

export async function GET(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  const url = new URL(request.url);
  const busca = textoSeguro(url.searchParams.get('q'), 100).replace(/[^\p{L}\p{N} ._\/-]/gu, ' ');
  const pagina = Math.max(1, Number(url.searchParams.get('pagina')) || 1);
  const limite = Math.min(100, Math.max(10, Number(url.searchParams.get('limite')) || 30));
  const inicio = (pagina - 1) * limite;
  const filtro = busca
    ? `&or=(codigo.ilike.*${encodeURIComponent(busca)}*,nome.ilike.*${encodeURIComponent(busca)}*)`
    : '';
  try {
    const dados = await supabaseRest(
      `bling_produtos?select=${camposProduto}${filtro}&order=updated_at.desc&offset=${inicio}&limit=${limite}`,
      { method: 'GET' }
    );
    return Response.json({ produtos: dados, pagina, limite });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao consultar histórico.' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const corpo = await lerCorpoLimitado(request, 2 * 1024 * 1024);
    const recebido = JSON.parse(new TextDecoder().decode(corpo));
    const produtos = (Array.isArray(recebido?.produtos) ? recebido.produtos : [])
      .slice(0, 500).map(produtoValido).filter(Boolean);
    if (!produtos.length) return Response.json({ erro: 'Nenhum produto válido.' }, { status: 400 });
    const salvos = await supabaseRest('bling_produtos?on_conflict=codigo', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,missing=default,return=minimal' },
      body: JSON.stringify(produtos),
    });
    return Response.json({ salvos: produtos.length, dados: salvos });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao salvar histórico.' }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const corpo = await lerCorpoLimitado(request, 32 * 1024);
    const recebido = JSON.parse(new TextDecoder().decode(corpo));
    const codigo = textoSeguro(recebido?.codigo, 80);
    const produto = produtoValido(recebido?.produto);
    if (!codigo || !produto) return Response.json({ erro: 'Produto inválido.' }, { status: 400 });
    const [atualizado] = await supabaseRest(`bling_produtos?codigo=eq.${encodeURIComponent(codigo)}&select=${camposProduto}`, {
      method: 'PATCH', body: JSON.stringify(produto),
    });
    return Response.json({ produto: atualizado });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao atualizar histórico.' }, { status: 502 });
  }
}
