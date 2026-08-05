import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nome, apiKey } = body;

    // --- 1. BUSCA NO MERCADO LIVRE (Conexão Direta Oficial) ---
    let imagensEncontradas = ["", "", "", ""];
    let busca = nome.replace(/ENCORD /g, "ENCORDOAMENTO ").replace(/C\/ /g, "COM ").replace(/S\/ /g, "SEM ");
    let palavras = busca.split(" ");
    
    let tentativas = [busca, palavras.slice(0, 4).join(" "), palavras.slice(0, 2).join(" ")];

    for (let tentativa of tentativas) {
      if (!tentativa.trim()) continue;
      try {
        // Chamando a API real diretamente (O backend do Next.js não tem bloqueio CORS)
        const urlBusca = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(tentativa)}&limit=1`;
        const resML = await fetch(urlBusca);
        const dadosML = await resML.json();

        if (dadosML.results && dadosML.results.length > 0) {
          const idProduto = dadosML.results[0].id;
          const resAnuncio = await fetch(`https://api.mercadolibre.com/items/${idProduto}`);
          const dadosAnuncio = await resAnuncio.json();
          
          if (dadosAnuncio.pictures) {
            imagensEncontradas = dadosAnuncio.pictures.slice(0, 4).map((f: any) => f.secure_url);
            while (imagensEncontradas.length < 4) imagensEncontradas.push("");
          }
          break; // Achou a foto, para de tentar nomes menores
        }
      } catch (e) {
        console.log("Tentativa ML falhou:", tentativa);
      }
    }

    // --- 2. BUSCA NO GEMINI (Com a tag -latest corrigida) ---
    let descCurta = "";
    let descLonga = "";
    
    try {
      const chaveLimpa = apiKey.trim();
      const prompt = `Atue como um especialista em e-commerce. Crie para o produto '${nome}':\n1. Uma descrição curta (máximo 2 linhas, atrativa).\n2. Uma descrição longa em formato HTML (com <b>, <p>, e <ul> para especificações).\n\nRetorne EXATAMENTE no formato:\nCURTA: [texto]\nLONGA: [texto HTML]`;
      
      // Ajustado para gemini-1.5-flash-latest, que é a rota suportada na sua chave!
      const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${chaveLimpa}`;
      
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

    // Retorna para o Frontend
    return NextResponse.json({
      curta: descCurta,
      longa: descLonga,
      imagens: imagensEncontradas
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}