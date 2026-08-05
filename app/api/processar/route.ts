import { NextResponse } from 'next/server';

// ID do mecanismo de pesquisa (Google Programmable Search Engine). Não é segredo.
const GOOGLE_CX = 'a4b6a7482ee7945a3';

// Busca de imagens via Google Custom Search API (o Mercado Livre e o DuckDuckGo
// pararam de funcionar sem cadastro/chave).
async function buscarImagensGoogle(termo: string, apiKeyImg: string, debug: any[]): Promise<string[]> {
  let urls = ["", "", "", ""];
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKeyImg}&cx=${GOOGLE_CX}&q=${encodeURIComponent(termo)}&searchType=image&num=4&gl=br&hl=pt-BR`;
    const res = await fetch(url);
    const dados = await res.json();

    debug.push({
      termo,
      status: res.status,
      resultados: dados.items?.length ?? 0,
      erro: dados.error?.message || null,
    });

    if (dados.items && dados.items.length > 0) {
      urls = dados.items.slice(0, 4).map((item: any) => item.link);
      while (urls.length < 4) urls.push("");
    }
  } catch (e: any) {
    debug.push({ termo, excecao: e.message });
  }
  return urls;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nome, apiKey, apiKeyImg } = body;

    // --- BUSCA DE IMAGENS ---
    let imagensEncontradas = ["", "", "", ""];
    const busca = nome.replace(/ENCORD /g, "ENCORDOAMENTO ").replace(/C\/ /g, "COM ").replace(/S\/ /g, "SEM ");
    const palavras = busca.split(" ");
    const tentativas = [busca, palavras.slice(0, 4).join(" "), palavras.slice(0, 2).join(" ")];
    const debugImg: any[] = [];

    if (apiKeyImg) {
      for (const tentativa of tentativas) {
        if (!tentativa.trim()) continue;
        const urls = await buscarImagensGoogle(tentativa, apiKeyImg.trim(), debugImg);
        if (urls.some(u => u)) {
          imagensEncontradas = urls;
          break;
        }
      }
    }

    // --- BUSCA NO GEMINI ---
    let descCurta = "";
    let descLonga = "";

    try {
      const chaveLimpa = apiKey.trim();
      const prompt = `Atue como um especialista em e-commerce. Crie para o produto '${nome}':\n1. Uma descrição curta (máximo 2 linhas, atrativa).\n2. Uma descrição longa em formato HTML (com <b>, <p>, e <ul> para especificações).\n\nRetorne EXATAMENTE no formato:\nCURTA: [texto]\nLONGA: [texto HTML]`;

      const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${chaveLimpa}`;

      const resGemini = await fetch(urlGemini, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const dadosGemini = await resGemini.json();

      if (dadosGemini.error) {
        throw new Error(dadosGemini.error.message);
      }

      const resposta = dadosGemini.candidates[0].content.parts[0].text;

      if (resposta.includes("LONGA:")) {
        const partes = resposta.split("LONGA:");
        descCurta = partes[0].replace("CURTA:", "").trim();
        descLonga = partes[1].trim();
      } else {
        descCurta = resposta.trim();
        descLonga = resposta.trim();
      }
    } catch (e: any) {
       console.log("Erro no Gemini:", e.message);
       descCurta = `Erro IA: ${e.message}`;
       descLonga = "";
    }

    return NextResponse.json({
      curta: descCurta,
      longa: descLonga,
      imagens: imagensEncontradas,
      debugImg
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
