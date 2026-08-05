import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nome, apiKey } = body;

    const headersML = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    let imagensEncontradas = ["", "", "", ""];
    let busca = nome.replace(/ENCORD /g, "ENCORDOAMENTO ").replace(/C\/ /g, "COM ").replace(/S\/ /g, "SEM ");
    let palavras = busca.split(" ");

    let tentativas = [busca, palavras.slice(0, 4).join(" "), palavras.slice(0, 2).join(" ")];
    const debugML: any[] = [];

    for (let tentativa of tentativas) {
      if (!tentativa.trim()) continue;
      try {
        const urlBusca = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(tentativa)}&limit=1`;
        const resML = await fetch(urlBusca, { headers: headersML });
        const dadosML = await resML.json();

        debugML.push({
          tentativa,
          status: resML.status,
          resultados: dadosML.results?.length ?? 0,
          erro: dadosML.error || dadosML.message || null,
        });

        if (dadosML.results && dadosML.results.length > 0) {
          const idProduto = dadosML.results[0].id;
          const resAnuncio = await fetch(`https://api.mercadolibre.com/items/${idProduto}`, { headers: headersML });
          const dadosAnuncio = await resAnuncio.json();

          debugML.push({
            item: idProduto,
            statusItem: resAnuncio.status,
            temFotos: !!dadosAnuncio.pictures,
            erroItem: dadosAnuncio.error || dadosAnuncio.message || null,
          });

          if (dadosAnuncio.pictures) {
            imagensEncontradas = dadosAnuncio.pictures.slice(0, 4).map((f: any) => f.secure_url);
            while (imagensEncontradas.length < 4) imagensEncontradas.push("");
          }
          break;
        }
      } catch (e: any) {
        console.log("Tentativa ML falhou:", tentativa);
        debugML.push({ tentativa, excecao: e.message });
      }
    }

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
      debugML
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}