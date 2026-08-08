import { BLING_API, tokenValido } from '../sessao';

// Campos que o PUT de produto aceita. O PUT do Bling substitui o produto
// inteiro, então precisamos reenviar o que já existe — mas só o que ele
// reconhece, senão a validação recusa a requisição.
const CAMPOS_COPIAVEIS = [
  'nome', 'codigo', 'preco', 'tipo', 'situacao', 'formato', 'descricaoCurta',
  'dataValidade', 'unidade', 'pesoLiquido', 'pesoBruto', 'volumes',
  'itensPorCaixa', 'gtin', 'gtinEmbalagem', 'tipoProducao', 'condicao',
  'freteGratis', 'marca', 'descricaoComplementar', 'linkExterno', 'observacoes',
  'categoria', 'estoque', 'dimensoes', 'tributacao', 'midia', 'linhaProduto',
] as const;

// O Bling limita a descrição curta; cortar aqui evita perder a requisição toda.
const LIMITE_DESCRICAO_CURTA = 255;

const vazio = (valor: any) =>
  valor === null || valor === undefined || valor === '' || valor === 0;

const semInformacao = (texto: any) => {
  const t = String(texto ?? '').trim();
  return !t || t.toUpperCase().includes('NÃO INFORMADO') || t.startsWith('Erro IA:');
};

// "250 g" -> 0.25 | "1,5 kg" -> 1.5 | "2kg" -> 2 | texto solto -> null
function paraQuilos(texto: any): number | null {
  if (semInformacao(texto)) return null;

  const limpo = String(texto).toLowerCase().replace(',', '.');
  const casa = limpo.match(/([\d.]+)\s*(kg|quilos?|g|gramas?)?/);
  if (!casa) return null;

  const numero = parseFloat(casa[1]);
  if (!isFinite(numero) || numero <= 0) return null;

  const unidade = casa[2] || '';
  // Sem unidade explícita não há como adivinhar sem risco de errar o frete.
  if (!unidade) return null;

  const emGramas = unidade.startsWith('g');
  const quilos = emGramas ? numero / 1000 : numero;

  return Math.round(quilos * 1000) / 1000;
}

// Converte para centímetros. Devolve null quando a unidade não está clara.
function paraCentimetros(texto: any): number | null {
  if (semInformacao(texto)) return null;

  const limpo = String(texto).toLowerCase().replace(',', '.');
  const casa = limpo.match(/([\d.]+)\s*(mm|cm|m|metros?|milimetros?|centimetros?)?/);
  if (!casa) return null;

  const numero = parseFloat(casa[1]);
  if (!isFinite(numero) || numero <= 0) return null;

  const unidade = casa[2] || '';
  if (!unidade) return null;

  let cm = numero;
  if (unidade.startsWith('mm') || unidade.startsWith('mili')) cm = numero / 10;
  else if (unidade === 'm' || unidade.startsWith('metro')) cm = numero * 100;

  return Math.round(cm * 100) / 100;
}

async function chamarBling(caminho: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BLING_API}${caminho}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const corpo = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, corpo };
}

function descreveErro(corpo: any, status: number): string {
  const erro = corpo?.error;
  if (!erro) return `HTTP ${status}`;

  const campos = erro.fields
    ?.map((c: any) => `${c.element || c.field || '?'}: ${c.msg || c.message}`)
    .join(' | ');

  return [erro.description || erro.message || `HTTP ${status}`, campos]
    .filter(Boolean)
    .join(' — ');
}

export async function POST(request: Request) {
  let token: string | null;
  try {
    token = await tokenValido();
  } catch (e: any) {
    return Response.json({ erro: e.message }, { status: 401 });
  }

  if (!token) {
    return Response.json({ erro: 'Não está conectado ao Bling.' }, { status: 401 });
  }

  const dados = await request.json();
  const {
    codigo, curta, longa, marca, peso, largura, altura, profundidade,
    imagens = [], simular = true, sobrescrever = false, unidadeMedida,
  } = dados;

  if (!codigo) {
    return Response.json({ erro: 'Faltou o código do produto.' }, { status: 400 });
  }

  // 1. Acha o produto pelo código.
  const busca = await chamarBling(
    `/produtos?codigos[]=${encodeURIComponent(codigo)}&limite=2`,
    token
  );

  if (!busca.ok) {
    return Response.json(
      { erro: `Não deu para buscar o produto: ${descreveErro(busca.corpo, busca.status)}` },
      { status: 502 }
    );
  }

  const achados = busca.corpo?.data || [];
  const exato = achados.filter((p: any) => String(p.codigo) === String(codigo));

  if (exato.length === 0) {
    return Response.json(
      { erro: `Nenhum produto com o código ${codigo} no seu Bling.` },
      { status: 404 }
    );
  }
  if (exato.length > 1) {
    return Response.json(
      { erro: `Há ${exato.length} produtos com o código ${codigo}. Não vou adivinhar qual atualizar.` },
      { status: 409 }
    );
  }

  const idProduto = exato[0].id;

  // 2. Lê o produto completo, que é a base do PUT.
  const leitura = await chamarBling(`/produtos/${idProduto}`, token);
  if (!leitura.ok) {
    return Response.json(
      { erro: `Não deu para ler o produto ${codigo}: ${descreveErro(leitura.corpo, leitura.status)}` },
      { status: 502 }
    );
  }

  const atual = leitura.corpo?.data;
  if (!atual) {
    return Response.json({ erro: `O Bling não devolveu o produto ${codigo}.` }, { status: 502 });
  }

  // 3. Copia o que já existe e sobrepõe apenas o que deve mudar.
  const corpo: any = {};
  for (const campo of CAMPOS_COPIAVEIS) {
    if (atual[campo] !== undefined && atual[campo] !== null) {
      corpo[campo] = atual[campo];
    }
  }
  if (atual.categoria?.id) corpo.categoria = { id: atual.categoria.id };
  if (atual.linhaProduto?.id) corpo.linhaProduto = { id: atual.linhaProduto.id };

  const alterados: string[] = [];
  const ignorados: string[] = [];

  // Descrições: é o objetivo do app, então sempre entram.
  if (!semInformacao(curta)) {
    corpo.descricaoCurta = String(curta).slice(0, LIMITE_DESCRICAO_CURTA);
    alterados.push('descricaoCurta');
  }
  if (!semInformacao(longa)) {
    corpo.descricaoComplementar = String(longa);
    alterados.push('descricaoComplementar');
  }

  // Ficha: por padrão só preenche o que está vazio no Bling, para não
  // apagar dado que você já conferiu na mão.
  const podeGravar = (campo: string, valorAtual: any) => {
    if (sobrescrever || vazio(valorAtual)) return true;
    ignorados.push(`${campo} (já preenchido no Bling)`);
    return false;
  };

  if (!semInformacao(marca) && podeGravar('marca', atual.marca)) {
    corpo.marca = String(marca);
    alterados.push('marca');
  }

  const kg = paraQuilos(peso);
  if (kg !== null) {
    if (podeGravar('pesoBruto', atual.pesoBruto)) {
      corpo.pesoBruto = kg;
      alterados.push('pesoBruto');
    }
    if (podeGravar('pesoLiquido', atual.pesoLiquido)) {
      corpo.pesoLiquido = kg;
      alterados.push('pesoLiquido');
    }
  } else if (!semInformacao(peso)) {
    ignorados.push(`peso "${peso}" (unidade não reconhecida)`);
  }

  // A unidade das dimensões no Bling é um código numérico. Reusar a do próprio
  // produto é o único jeito seguro; se ele não tiver, usamos a escolhida na tela.
  const unidadeDoProduto = atual.dimensoes?.unidadeMedida;
  const unidadeFinal = unidadeDoProduto ?? unidadeMedida;

  const medidas: Record<string, number> = {};
  for (const [nome, valor] of [['largura', largura], ['altura', altura], ['profundidade', profundidade]] as const) {
    const cm = paraCentimetros(valor);
    if (cm !== null) {
      if (podeGravar(nome, atual.dimensoes?.[nome])) medidas[nome] = cm;
    } else if (!semInformacao(valor)) {
      ignorados.push(`${nome} "${valor}" (unidade não reconhecida)`);
    }
  }

  if (Object.keys(medidas).length > 0) {
    if (unidadeFinal === undefined || unidadeFinal === null) {
      ignorados.push('dimensões (o produto não tem unidade de medida definida no Bling)');
    } else {
      corpo.dimensoes = { ...(atual.dimensoes || {}), ...medidas, unidadeMedida: unidadeFinal };
      alterados.push(`dimensões (${Object.keys(medidas).join(', ')})`);
    }
  }

  // Imagens: o Bling só aceita link, então aqui já chegam as URLs do Supabase.
  const links = (imagens as string[]).filter(Boolean);
  if (links.length > 0) {
    const jaTem = atual.midia?.imagens?.externas?.length > 0;
    if (sobrescrever || !jaTem) {
      corpo.midia = {
        ...(atual.midia || {}),
        imagens: { externas: links.map((link) => ({ link })) },
      };
      alterados.push(`${links.length} imagem(ns)`);
    } else {
      ignorados.push('imagens (o produto já tem imagens no Bling)');
    }
  }

  if (alterados.length === 0) {
    return Response.json({
      codigo, idProduto, enviado: false, alterados, ignorados,
      aviso: 'Nada a alterar neste produto.',
    });
  }

  // 4. Modo simular: mostra o que seria enviado e para aqui.
  if (simular) {
    return Response.json({
      codigo, idProduto, enviado: false, simulado: true,
      alterados, ignorados, corpo,
    });
  }

  const envio = await chamarBling(`/produtos/${idProduto}`, token, {
    method: 'PUT',
    body: JSON.stringify(corpo),
  });

  if (!envio.ok) {
    return Response.json(
      {
        codigo, idProduto, enviado: false, alterados, ignorados,
        erro: descreveErro(envio.corpo, envio.status),
      },
      { status: 502 }
    );
  }

  return Response.json({
    codigo, idProduto, enviado: true, alterados, ignorados,
    avisosBling: envio.corpo?.data?.warnings || [],
  });
}
