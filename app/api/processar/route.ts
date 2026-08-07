import { NextResponse } from 'next/server';

// Modelo "lite": cota gratuita bem maior que o flash normal, o que importa em lotes grandes.
const MODELO_GEMINI = 'gemini-flash-lite-latest';

const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

// Rede de segurança: às vezes a IA devolve HTML mesmo sendo instruída a não usar.
function limparHtml(texto: string): string {
  return texto
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    // Itens de lista viram uma linha começando com "-".
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*\/\s*li\s*>/gi, '')
    // Blocos ganham linha em branco antes e depois.
    .replace(/<\s*\/?\s*(p|div|h[1-6]|ul|ol|section)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Sobras de markdown, caso apareçam.
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    // No máximo uma linha em branco entre blocos.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Busca de imagens via Serper (resultados do Google Imagens).
// O Mercado Livre bloqueia acesso anônimo e a Custom Search JSON API do Google
// foi fechada para novos projetos, então esta é a fonte que resta funcionando.
async function buscarImagensSerper(termo: string, chaveSerper: string, debug: any[]): Promise<string[]> {
  let urls = ["", "", "", ""];
  try {
    const res = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: {
        'X-API-KEY': chaveSerper,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: termo, gl: 'br', hl: 'pt-br', num: 10 })
    });

    const dados = await res.json();

    debug.push({
      termo,
      status: res.status,
      resultados: dados.images?.length ?? 0,
      erro: dados.message || dados.error || null,
    });

    if (dados.images && dados.images.length > 0) {
      urls = dados.images.slice(0, 4).map((img: any) => img.imageUrl);
      while (urls.length < 4) urls.push("");
    }
  } catch (e: any) {
    debug.push({ termo, excecao: e.message });
  }
  return urls;
}

export interface Ficha {
  curta: string;
  longa: string;
  marca: string;
  peso: string;
  largura: string;
  altura: string;
  profundidade: string;
}

const FICHA_VAZIA = "NÃO INFORMADO";

// Resposta em JSON com campos fixos: bem mais confiável do que recortar texto.
const ESQUEMA = {
  type: "OBJECT",
  properties: {
    curta: { type: "STRING" },
    longa: { type: "STRING" },
    marca: { type: "STRING" },
    peso: { type: "STRING" },
    largura: { type: "STRING" },
    altura: { type: "STRING" },
    profundidade: { type: "STRING" },
  },
  required: ["curta", "longa", "marca", "peso", "largura", "altura", "profundidade"],
};

// O Gemini devolve 429 (cota) e 503 (sobrecarga) com frequência em lotes grandes,
// então tentamos algumas vezes antes de desistir do produto.
async function gerarDescricoes(nome: string, chave: string): Promise<Ficha> {
  const prompt = `Atue como um especialista em e-commerce brasileiro.
Produto: '${nome}'

Preencha os campos abaixo.

curta: descrição curta e atrativa, no máximo 2 linhas.

longa: descrição em TEXTO PURO, pronta para copiar e colar.
- NÃO use HTML nem markdown. Nada de <p>, <b>, <ul>, **, ##.
- 2 ou 3 parágrafos separados por uma linha em branco.
- Termine com uma seção iniciada pela linha "ESPECIFICAÇÕES TÉCNICAS:" e,
  abaixo, um item por linha no formato "- Rótulo: valor".

marca: o fabricante. Normalmente aparece no próprio nome do produto.

peso, largura, altura, profundidade: medidas do produto embalado,
com a unidade junto (exemplos: "250 g", "12 cm").

REGRA CRÍTICA para marca, peso, largura, altura e profundidade:
responda exatamente ${FICHA_VAZIA} quando não houver base concreta para
o valor. NÃO invente número nem marca. É muito melhor deixar
${FICHA_VAZIA} do que informar um dado errado, porque esses valores serão
usados para calcular frete.`;

  const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${chave}`;

  let ultimoErro = "";

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    const res = await fetch(urlGemini, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: ESQUEMA,
        },
      })
    });

    const dados = await res.json();

    if (!dados.error) {
      const resposta = dados.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!resposta) throw new Error("A IA respondeu vazio.");

      let bruto: any;
      try {
        bruto = JSON.parse(resposta);
      } catch {
        throw new Error("A IA respondeu num formato inesperado.");
      }

      const campo = (valor: any) => {
        const texto = limparHtml(String(valor ?? "").trim());
        return texto || FICHA_VAZIA;
      };

      return {
        curta: limparHtml(String(bruto.curta ?? "")),
        longa: limparHtml(String(bruto.longa ?? "")),
        marca: campo(bruto.marca),
        peso: campo(bruto.peso),
        largura: campo(bruto.largura),
        altura: campo(bruto.altura),
        profundidade: campo(bruto.profundidade),
      };
    }

    ultimoErro = dados.error.message;

    // 429 = cota, 503 = sobrecarga. Só vale a pena reesperar nesses casos.
    const vaiRetentar = (res.status === 429 || res.status === 503) && tentativa < 4;
    if (!vaiRetentar) break;

    await espera(tentativa * 2000);
  }

  throw new Error(ultimoErro || "Falha desconhecida na IA.");
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nome, apiKey, apiKeyImg } = body;

    // --- BUSCA DE IMAGENS ---
    let imagensEncontradas = ["", "", "", ""];
    const busca = nome.replace(/ENCORD /g, "ENCORDOAMENTO ").replace(/C\/ /g, "COM ").replace(/S\/ /g, "SEM ");
    const palavras = busca.split(" ");
    // Termos do mais específico ao mais genérico; para na primeira que trouxer imagem,
    // para não gastar créditos à toa.
    const tentativas = [busca, palavras.slice(0, 4).join(" "), palavras.slice(0, 2).join(" ")];
    const debugImg: any[] = [];

    if (apiKeyImg) {
      for (const tentativa of tentativas) {
        if (!tentativa.trim()) continue;
        const urls = await buscarImagensSerper(tentativa, apiKeyImg.trim(), debugImg);
        if (urls.some(u => u)) {
          imagensEncontradas = urls;
          break;
        }
      }
    } else {
      debugImg.push({ erro: "Chave da API Serper não foi preenchida no site." });
    }

    // --- DESCRIÇÕES E FICHA (GEMINI) ---
    let ficha: Ficha = {
      curta: "", longa: "",
      marca: FICHA_VAZIA, peso: FICHA_VAZIA,
      largura: FICHA_VAZIA, altura: FICHA_VAZIA, profundidade: FICHA_VAZIA,
    };

    try {
      ficha = await gerarDescricoes(nome, apiKey.trim());
    } catch (e: any) {
      console.log("Erro no Gemini:", e.message);
      ficha = { ...ficha, curta: `Erro IA: ${e.message}` };
    }

    return NextResponse.json({
      curta: ficha.curta,
      longa: ficha.longa,
      marca: ficha.marca,
      peso: ficha.peso,
      largura: ficha.largura,
      altura: ficha.altura,
      profundidade: ficha.profundidade,
      imagens: imagensEncontradas,
      debugImg
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
