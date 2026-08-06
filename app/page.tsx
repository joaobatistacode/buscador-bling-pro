'use client';
import { useState } from 'react';
import { montarZip, type ArquivoZip } from './zip';

const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

// Medidas pedidas: a foto cabe em 350x350 e fica centralizada
// numa moldura branca de 420x420.
const LADO_MOLDURA = 420;
const LADO_FOTO = 350;

// Nome de pasta/arquivo seguro em Windows, macOS e Linux.
const nomeSeguro = (texto: string) =>
  texto.replace(/[\\/:*?"<>|]/g, '-').trim() || 'sem-codigo';

// Baixa a imagem pelo nosso proxy e devolve ela já na moldura branca.
function montarImagem(url: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = LADO_MOLDURA;
      canvas.height = LADO_MOLDURA;

      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, LADO_MOLDURA, LADO_MOLDURA);

      // Encaixa dentro de 350x350 sem distorcer a proporção original.
      const escala = Math.min(LADO_FOTO / img.width, LADO_FOTO / img.height);
      const largura = img.width * escala;
      const altura = img.height * escala;

      ctx.drawImage(
        img,
        (LADO_MOLDURA - largura) / 2,
        (LADO_MOLDURA - altura) / 2,
        largura,
        altura
      );

      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    };

    img.onerror = () => resolve(null);
    img.src = `/api/imagem?url=${encodeURIComponent(url)}`;
  });
}

export default function Home() {
  const [textoColado, setTextoColado] = useState('');
  const [apiKeyGemini, setApiKeyGemini] = useState('');
  const [apiKeyImg, setApiKeyImg] = useState('');
  const [resultados, setResultados] = useState<any[]>([]);
  const [processando, setProcessando] = useState(false);
  const [baixando, setBaixando] = useState(false);
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
    const novosResultados = [];

    for (let i = 0; i < linhas.length; i++) {
      const partes = linhas[i].split('\t');
      const codigo = partes.length > 1 ? partes[0] : `TEMP-${i}`;
      const nome = partes.length > 1 ? partes[1] : partes[0];

      setLog(`[${i + 1}/${linhas.length}] Processando: ${nome}`);

      try {
        const res = await fetch('/api/processar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome, apiKey: apiKeyGemini, apiKeyImg })
        });

        const dados = await res.json();

        novosResultados.push({
          codigo,
          nome,
          curta: dados.curta || "",
          longa: dados.longa || "",
          img1: dados.imagens?.[0] || "", img2: dados.imagens?.[1] || "", img3: dados.imagens?.[2] || "", img4: dados.imagens?.[3] || ""
        });

        setResultados([...novosResultados]);
        setProgresso({ atual: i + 1, total: linhas.length });

      } catch (e: any) {
        setLog(`Erro no produto ${nome}: ${e.message}`);
      }

      // Respiro entre produtos para não estourar o limite por minuto da IA.
      if (i < linhas.length - 1) await espera(1500);
    }

    setProcessando(false);

    const comErro = novosResultados.filter(r => r.curta.startsWith("Erro IA:")).length;
    const semImagem = novosResultados.filter(r => !r.img1).length;
    setLog(
      `Lote concluído: ${novosResultados.length} produtos. ` +
      `${comErro} com falha na descrição, ${semImagem} sem imagem.`
    );
  };

  const exportarCSV = () => {
    // Ponto e vírgula para o Excel separar as colunas corretamente
    const cabecalho = "Código;Produto;Descrição Curta;Descrição;Imagem 1;Imagem 2;Imagem 3;Imagem 4\n";

    const linhasCSV = resultados.map(r =>
      `"${r.codigo}";"${r.nome}";"${r.curta.replace(/"/g, '""')}";"${r.longa.replace(/"/g, '""')}";"${r.img1}";"${r.img2}";"${r.img3}";"${r.img4}"`
    ).join("\n");

    // "\uFEFF" na frente avisa o Excel que é UTF-8, consertando os acentos
    const blob = new Blob(["\uFEFF" + cabecalho + linhasCSV], { type: 'text/csv;charset=utf-8;' });
    baixarArquivo(blob, "produtos_enriquecidos_bling.csv");
  };

  const baixarArquivo = (blob: Blob, nomeArquivo: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", nomeArquivo);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const baixarPacote = async () => {
    setBaixando(true);
    const arquivos: ArquivoZip[] = [];
    const codificador = new TextEncoder();
    let totalImagens = 0;
    let falhas = 0;

    for (let i = 0; i < resultados.length; i++) {
      const res = resultados[i];
      const codigo = nomeSeguro(res.codigo);
      setLog(`Montando pacote [${i + 1}/${resultados.length}]: ${codigo}`);

      const urls = [res.img1, res.img2, res.img3, res.img4].filter(Boolean);
      let numero = 1;

      for (const url of urls) {
        const blob = await montarImagem(url);
        if (blob) {
          arquivos.push({
            caminho: `${codigo}/${codigo}_${numero}.jpg`,
            dados: new Uint8Array(await blob.arrayBuffer())
          });
          numero++;
          totalImagens++;
        } else {
          falhas++;
        }
      }

      const texto =
        `CÓDIGO: ${res.codigo}\n` +
        `PRODUTO: ${res.nome}\n\n` +
        `=== DESCRIÇÃO CURTA ===\n${res.curta}\n\n` +
        `=== DESCRIÇÃO LONGA ===\n${res.longa}\n`;

      arquivos.push({
        caminho: `${codigo}/${codigo}_descricao.txt`,
        // "\uFEFF" no começo faz o Bloco de Notas abrir os acentos corretamente.
        dados: codificador.encode("\uFEFF" + texto)
      });
    }

    setLog("Compactando o arquivo...");
    baixarArquivo(montarZip(arquivos), "produtos_bling.zip");

    setBaixando(false);
    setLog(
      `Pacote pronto: ${resultados.length} pastas, ${totalImagens} imagens em 420x420. ` +
      (falhas > 0 ? `${falhas} imagem(ns) não puderam ser baixadas.` : `Nenhuma falha.`)
    );
  };

  const ocupado = processando || baixando;

  return (
    <main className="p-6 md:p-10 max-w-7xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Enriquecedor Bling PRO</h1>
        <p className="text-gray-600 mt-1">
          Gera descrição curta, descrição longa e busca 4 imagens para cada produto.
        </p>
      </header>

      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Chave da API do Gemini
            </label>
            <input
              type="password"
              placeholder="Cole aqui a chave do Gemini"
              value={apiKeyGemini}
              onChange={(e) => setApiKeyGemini(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-lg text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Chave da API Serper <span className="font-normal text-gray-500">(busca de imagens)</span>
            </label>
            <input
              type="password"
              placeholder="Cole aqui a chave do serper.dev"
              value={apiKeyImg}
              onChange={(e) => setApiKeyImg(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-lg text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <label className="block text-sm font-semibold text-gray-700 mb-1">
          Produtos <span className="font-normal text-gray-500">(cole do Excel: código na 1ª coluna, nome na 2ª)</span>
        </label>
        <textarea
          placeholder={"16504\tENCORD UKULELE SG NAILON SOPRANO 10981\n16503\tSPEAKON FEMEA ROXTONE 4 PINOS RP-017 PRETO"}
          value={textoColado}
          onChange={(e) => setTextoColado(e.target.value)}
          rows={6}
          className="w-full p-3 border border-gray-300 rounded-lg text-gray-900 bg-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <div className="flex flex-wrap gap-3 mt-4">
          <button
            onClick={iniciarProcessamento}
            disabled={ocupado || !textoColado.trim()}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:hover:bg-blue-600"
          >
            {processando ? `Processando ${progresso.atual}/${progresso.total}...` : 'Iniciar'}
          </button>

          <button
            onClick={baixarPacote}
            disabled={ocupado || resultados.length === 0}
            className="px-6 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:hover:bg-purple-600"
          >
            {baixando ? 'Montando pacote...' : 'Baixar pastas (ZIP)'}
          </button>

          <button
            onClick={exportarCSV}
            disabled={ocupado || resultados.length === 0}
            className="px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:hover:bg-green-600"
          >
            Baixar CSV
          </button>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          O ZIP traz uma pasta por código do produto, com as imagens em {LADO_MOLDURA}x{LADO_MOLDURA}px
          (foto de até {LADO_FOTO}x{LADO_FOTO}px centralizada em fundo branco) e um .txt com as descrições.
        </p>
      </section>

      <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm min-h-[56px] flex items-center mb-6">
        {log || "Pronto para processar."}
      </div>

      {resultados.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="p-3 font-semibold text-gray-700">Código</th>
                  <th className="p-3 font-semibold text-gray-700">Nome</th>
                  <th className="p-3 font-semibold text-gray-700">Imagens</th>
                  <th className="p-3 font-semibold text-gray-700">Descrição Curta</th>
                  <th className="p-3 font-semibold text-gray-700">Descrição Longa</th>
                </tr>
              </thead>
              <tbody>
                {resultados.map((res, index) => {
                  const falhou = res.curta.startsWith("Erro IA:");
                  return (
                    <tr key={index} className="border-b border-gray-100 align-top hover:bg-gray-50">
                      <td className="p-3 text-gray-900 font-mono">{res.codigo}</td>
                      <td className="p-3 text-gray-900 min-w-[180px]">{res.nome}</td>
                      <td className="p-3">
                        <div className="grid grid-cols-2 gap-1.5 w-[150px]">
                          {[res.img1, res.img2, res.img3, res.img4].map((img, i) =>
                            img ? (
                              <a key={i} href={img} target="_blank" rel="noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={img}
                                  alt={`${res.nome} ${i + 1}`}
                                  className="w-[70px] h-[70px] object-cover rounded border border-gray-200 hover:border-blue-500 transition-colors"
                                />
                              </a>
                            ) : (
                              <div
                                key={i}
                                className="w-[70px] h-[70px] flex items-center justify-center text-gray-400 text-xs bg-gray-50 border border-dashed border-gray-300 rounded"
                              >
                                vazio
                              </div>
                            )
                          )}
                        </div>
                      </td>
                      <td className={`p-3 max-w-xs ${falhou ? 'text-red-600' : 'text-gray-900'}`}>
                        {res.curta}
                      </td>
                      <td className="p-3 text-gray-700 max-w-md">
                        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">
                          {res.longa}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
