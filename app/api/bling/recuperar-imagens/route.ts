/* eslint-disable @typescript-eslint/no-explicit-any -- respostas externas do Bling não possuem tipos publicados */
import { BLING_API, tokenValido } from '../sessao';
import {
  lerCorpoLimitado,
  naoAutorizado,
  origemInvalida,
  origemPermitida,
  temAcesso,
} from '@/lib/acesso';

const BUCKET = 'produtos-bling';
const CODIGO_SEGURO = /^[a-zA-Z0-9._-]{1,100}$/;
const CONFIRMACAO_RESTAURACAO = 'RESTAURAR IMAGENS';

const CAMPOS_COPIAVEIS = [
  'nome', 'codigo', 'preco', 'tipo', 'situacao', 'formato', 'descricaoCurta',
  'dataValidade', 'unidade', 'pesoLiquido', 'pesoBruto', 'volumes',
  'itensPorCaixa', 'gtin', 'gtinEmbalagem', 'tipoProducao', 'condicao',
  'freteGratis', 'marca', 'descricaoComplementar', 'linkExterno', 'observacoes',
  'categoria', 'estoque', 'dimensoes', 'tributacao', 'linhaProduto',
] as const;

async function chamarBling(caminho: string, token: string, init?: RequestInit) {
  const resposta = await fetch(`${BLING_API}${caminho}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  return {
    ok: resposta.ok,
    status: resposta.status,
    corpo: await resposta.json().catch(() => null),
  };
}

function descreverErro(corpo: any, status: number) {
  const erro = corpo?.error;
  const campos = erro?.fields
    ?.map((campo: any) => `${campo.element || campo.field || '?'}: ${campo.msg || campo.message}`)
    .join(' | ');
  return [erro?.description || erro?.message || `HTTP ${status}`, campos]
    .filter(Boolean)
    .join(' — ');
}

function configuracaoSupabase() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) throw new Error('Supabase não configurado na Vercel.');
  return { url, chave };
}

async function listarStorage(prefixo: string, limite = 1000, offset = 0) {
  const { url, chave } = configuracaoSupabase();
  const resposta = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${chave}`,
      apikey: chave,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix: prefixo,
      limit: limite,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const corpo = await resposta.json().catch(() => null);
  if (!resposta.ok || !Array.isArray(corpo)) {
    throw new Error(`Não foi possível listar o Supabase (HTTP ${resposta.status}).`);
  }
  return corpo as Array<{ name?: string; id?: string | null; metadata?: unknown }>;
}

async function listarCodigos() {
  const codigos: string[] = [];
  const limite = 1000;
  for (let offset = 0; offset < 10_000; offset += limite) {
    const pagina = await listarStorage('', limite, offset);
    for (const item of pagina) {
      const nome = String(item.name || '').trim();
      if (CODIGO_SEGURO.test(nome)) codigos.push(nome);
    }
    if (pagina.length < limite) break;
  }
  return [...new Set(codigos)].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
}

async function imagensDoProduto(codigo: string) {
  const itens = await listarStorage(codigo, 100, 0);
  const expressao = new RegExp(`^${codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.(?:jpe?g|png)$`, 'i');
  const nomes = itens
    .map(item => String(item.name || '').split('/').pop() || '')
    .map(nome => ({ nome, numero: Number(nome.match(expressao)?.[1] || 0) }))
    .filter(item => item.numero > 0)
    .sort((a, b) => a.numero - b.numero)
    .slice(0, 4);

  const { url } = configuracaoSupabase();
  return nomes.map(({ nome }) =>
    `${url}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(codigo)}/${encodeURIComponent(nome)}`
  );
}

function produtoTemImagem(produto: any) {
  const imagens = produto?.midia?.imagens;
  return [imagens?.externas, imagens?.internas, imagens?.imagensURL]
    .some(valor => Array.isArray(valor) && valor.length > 0);
}

function copiarProduto(produto: any) {
  const corpo: any = {};
  for (const campo of CAMPOS_COPIAVEIS) {
    if (produto[campo] !== undefined && produto[campo] !== null) corpo[campo] = produto[campo];
  }
  if (produto.categoria?.id) corpo.categoria = { id: produto.categoria.id };
  if (produto.linhaProduto?.id) corpo.linhaProduto = { id: produto.linhaProduto.id };
  return corpo;
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await lerCorpoLimitado(request, 64 * 1024);
  } catch {
    return Response.json({ erro: 'Requisição muito grande.' }, { status: 413 });
  }

  let dados: any;
  try {
    dados = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ erro: 'JSON inválido.' }, { status: 400 });
  }

  if (dados.acao === 'inventario') {
    try {
      const codigos = await listarCodigos();
      return Response.json({ codigos, total: codigos.length });
    } catch (erro) {
      return Response.json(
        { erro: erro instanceof Error ? erro.message : 'Falha ao consultar o Supabase.' },
        { status: 502 }
      );
    }
  }

  const codigo = String(dados.codigo || '').trim();
  if (!CODIGO_SEGURO.test(codigo)) {
    return Response.json({ erro: 'Código de produto inválido.' }, { status: 400 });
  }
  if (!['simular', 'restaurar'].includes(dados.acao)) {
    return Response.json({ erro: 'Ação inválida.' }, { status: 400 });
  }
  if (dados.acao === 'restaurar' && dados.confirmacao !== CONFIRMACAO_RESTAURACAO) {
    return Response.json({ erro: 'Confirmação de restauração inválida.' }, { status: 400 });
  }

  let token: string | null;
  try {
    token = await tokenValido();
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Bling desconectado.' }, { status: 401 });
  }
  if (!token) return Response.json({ erro: 'Não está conectado ao Bling.' }, { status: 401 });

  let imagens: string[];
  try {
    imagens = await imagensDoProduto(codigo);
  } catch (erro) {
    return Response.json(
      { codigo, erro: erro instanceof Error ? erro.message : 'Falha ao listar as imagens.' },
      { status: 502 }
    );
  }
  if (imagens.length === 0) {
    return Response.json({ codigo, erro: 'Nenhuma imagem encontrada no Supabase.' }, { status: 404 });
  }

  const busca = await chamarBling(`/produtos?codigos[]=${encodeURIComponent(codigo)}&limite=2`, token);
  if (!busca.ok) {
    return Response.json(
      { codigo, erro: `Falha ao buscar no Bling: ${descreverErro(busca.corpo, busca.status)}` },
      { status: busca.status === 429 ? 429 : 502 }
    );
  }
  const exatos = (busca.corpo?.data || []).filter((produto: any) => String(produto.codigo) === codigo);
  if (exatos.length !== 1) {
    return Response.json(
      { codigo, erro: exatos.length ? 'Código duplicado no Bling.' : 'Produto não encontrado no Bling.' },
      { status: exatos.length ? 409 : 404 }
    );
  }

  const idProduto = exatos[0].id;
  const leitura = await chamarBling(`/produtos/${idProduto}`, token);
  if (!leitura.ok || !leitura.corpo?.data) {
    return Response.json(
      { codigo, erro: `Falha ao ler o produto: ${descreverErro(leitura.corpo, leitura.status)}` },
      { status: leitura.status === 429 ? 429 : 502 }
    );
  }
  const atual = leitura.corpo.data;
  if (produtoTemImagem(atual)) {
    return Response.json({ codigo, idProduto, ignorado: true, motivo: 'Produto já possui imagem no Bling.' });
  }

  if (dados.acao === 'simular') {
    return Response.json({ codigo, idProduto, simulado: true, imagens });
  }

  const corpo = copiarProduto(atual);
  corpo.midia = { imagens: { imagensURL: imagens.map(link => ({ link })) } };
  const atualizacao = await chamarBling(`/produtos/${idProduto}`, token, {
    method: 'PUT',
    body: JSON.stringify(corpo),
  });
  if (!atualizacao.ok) {
    return Response.json(
      { codigo, idProduto, erro: descreverErro(atualizacao.corpo, atualizacao.status) },
      { status: atualizacao.status === 429 ? 429 : 502 }
    );
  }

  return Response.json({
    codigo,
    idProduto,
    restaurado: true,
    imagensRestauradas: imagens.length,
    avisosBling: atualizacao.corpo?.data?.warnings || [],
  });
}
