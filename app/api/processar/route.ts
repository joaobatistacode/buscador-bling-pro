import { NextResponse } from 'next/server';

const headersNav = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Busca de imagens via DuckDuckGo (não é API oficial, mas não exige cadastro/chave).
// O Mercado Livre passou a bloquear (403) qualquer busca anônima, então trocamos a fonte.
async function buscarImagensDDG(termo: string, debug: any[]): Promise<string[]> {
  let urls = ["", "", "", ""];
  try {
    const resToken = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(termo)}`, { headers: headersNav });
    const html = await resToken.text();
    const match = html.match(/vqd=['"]([\d-]+)['"]/) || html.match(/vqd=([\d-]+)&/);

    if (!match) {
      debug.push({ termo, etapa: 'token', statusToken: resToken.status, erro: 'vqd não encontrado' });
      return urls;
    }
    const vqd = match[1];

    const resImgs = await fetch(
      `https://duckduckgo.com/i.js?l=br-pt&o=json&q=${encodeURIComponent(termo)}&vqd=${vqd}&f=,,,,,&p=1`,
      { headers: { ...headersNav, Referer: 'https://duckduckgo.com/' } }
    );
    const dados = await resImgs.json();

    debug.push({
      termo,
      statusImgs: resImgs.status,
      resultados: dados.results?.length ?? 0,
      erro: dados.error || null,
    });

    if (dados.results && dados.results.length > 0) {
      urls = dados.results.slice(0, 4).map((r: any) => r.image);
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
    const { nome, apiKey } = body;

    // --- BUSCA DE IMAGENS ---
    let imagensEncontradas = ["", "", "", ""];
    const busca = nome.replace(/ENCORD /g, "ENCORDOAMENTO ").replace(/C\/ /g, "COM ").replace(/S\/ /g, "SEM ");
    const palavras = busca.split(" ");
    const tentativas = [busca, palavras.slice(0, 4).join(" "), palavras.slice(0, 2).join(" ")];
    const debugImg: any[] = [];

    for (const tentativa of tentativas) {
      if (!tentativa.trim()) continue;
      const urls = await buscarImagensDDG(tentativa, debugImg);
      if (urls.some(u => u)) {
        imagensEncontradas = urls;
        break;
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
