import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nome, apiKey } = body;

    // A busca de imagens no Mercado Livre roda no navegador (app/page.tsx),
    // pois o ML bloqueia pedidos vindos de servidores como a Vercel.

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
      longa: descLonga
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
