'use client';
import { useState } from 'react';

export default function Home() {
  const [textoColado, setTextoColado] = useState('');
  const [apiKeyGemini, setApiKeyGemini] = useState('');
  const [resultados, setResultados] = useState<any[]>([]);
  const [processando, setProcessando] = useState(false);
  const [log, setLog] = useState('');
  const [progresso, setProgresso] = useState({ atual: 0, total: 0 });

  const iniciarProcessamento = async () => {
    if (!apiKeyGemini) {
      alert("Insira sua chave do Gemini.");
      return;
    }

    const linhas = textoColado.trim().split('\n');
    if (linhas.length === 0 || linhas[0] === "") return;

    setProcessando(true);
    setProgresso({ atual: 0, total: linhas.length });
    let novosResultados = [];

    for (let i = 0; i < linhas.length; i++) {
      let partes = linhas[i].split('\t'); 
      let codigo = partes.length > 1 ? partes[0] : `TEMP-${i}`;
      let nome = partes.length > 1 ? partes[1] : partes[0];

      setLog(`[${i + 1}/${linhas.length}] Processando: ${nome}`);
      
      try {
        // Agora o frontend apenas pede pro backend fazer o trabalho pesado!
        const res = await fetch('/api/processar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome, apiKey: apiKeyGemini })
        });
        
        const dados = await res.json();

        novosResultados.push({
          codigo,
          nome,
          curta: dados.curta || "",
          longa: dados.longa || "",
          img1: dados.imagens[0], img2: dados.imagens[1], img3: dados.imagens[2], img4: dados.imagens[3]
        });
        
        setResultados([...novosResultados]); 
        setProgresso({ atual: i + 1, total: linhas.length });
        
      } catch (e: any) {
        setLog(`Erro no produto ${nome}: ${e.message}`);
      }
    }
    
    setProcessando(false);
    setLog("Lote concluído com sucesso!");
  };

  const exportarCSV = () => {
    const cabecalho = "Código,Produto,Descrição Curta,Descrição,Imagem 1,Imagem 2,Imagem 3,Imagem 4\n";
    const linhasCSV = resultados.map(r => 
      `"${r.codigo}","${r.nome}","${r.curta.replace(/"/g, '""')}","${r.longa.replace(/"/g, '""')}","${r.img1}","${r.img2}","${r.img3}","${r.img4}"`
    ).join("\n");
    
    const blob = new Blob([cabecalho + linhasCSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "produtos_enriquecidos_bling.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <main className="p-8 max-w-5xl mx-auto font-sans">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Enriquecedor Bling PRO (Vercel)</h1>
      
      <div className="mb-6 space-y-4">
        <input 
          type="password" 
          placeholder="Chave da API do Gemini" 
          value={apiKeyGemini}
          onChange={(e) => setApiKeyGemini(e.target.value)}
          className="w-full p-3 border rounded text-black"
        />
        <textarea
          placeholder="Cole as colunas do Excel aqui (Código e Nome) - Max 400 linhas"
          value={textoColado}
          onChange={(e) => setTextoColado(e.target.value)}
          rows={6}
          className="w-full p-3 border rounded text-black font-mono"
        />
      </div>

      <div className="flex gap-4 mb-6">
        <button 
          onClick={iniciarProcessamento} 
          disabled={processando || !textoColado.trim()}
          className="px-6 py-2 bg-blue-600 text-white rounded font-bold disabled:opacity-50"
        >
          {processando ? `Processando ${progresso.atual}/${progresso.total}...` : 'Iniciar'}
        </button>
        
        <button 
          onClick={exportarCSV} 
          disabled={resultados.length === 0}
          className="px-6 py-2 bg-green-600 text-white rounded font-bold disabled:opacity-50"
        >
          Baixar CSV
        </button>
      </div>

      <div className="bg-gray-900 text-green-400 p-4 rounded font-mono min-h-[60px] mb-6">
        {log || "Pronto para rodar no backend..."}
      </div>

      {resultados.length > 0 && (
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="bg-gray-100 border-b">
              <th className="p-2 text-black">Código</th>
              <th className="p-2 text-black">Nome</th>
              <th className="p-2 text-black">Status Imagens</th>
            </tr>
          </thead>
          <tbody>
            {resultados.map((res, index) => (
              <tr key={index} className="border-b">
                <td className="p-2 text-black">{res.codigo}</td>
                <td className="p-2 text-black">{res.nome}</td>
                <td className="p-2">
                  {res.img1 ? <span className="text-green-600">✓ OK</span> : <span className="text-red-500">✕ Vazio</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}