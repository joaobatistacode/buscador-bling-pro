'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { montarZip, type ArquivoZip } from './zip';
import { enviarProduto, type ResultadoEnvio } from './enviar-bling';

const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

// Medidas pedidas: a foto cabe em 350x350 e fica centralizada
// numa moldura branca de 420x420.
const LADO_MOLDURA = 420;
const LADO_FOTO = 350;

// Onde o histórico fica guardado no navegador. Sobrevive a queda de
// energia e a fechar o navegador: só some se o usuário limpar.
const CHAVE_HISTORICO = 'buscador-bling:resultados';

// Cada lote vira um ZIP separado. Um ZIP único com centenas de produtos
// fica grande demais para o navegador montar de uma vez só.
const PADRAO_POR_ZIP = 100;

const CAMPOS_IMAGEM = ['img1', 'img2', 'img3', 'img4'] as const;
type CampoImagem = (typeof CAMPOS_IMAGEM)[number];

const CORES_VARIANTES = new Set([
  'AMARELO', 'AMARELA', 'AZUL', 'BEGE', 'BRANCO', 'BRANCA', 'CINZA',
  'DOURADO', 'DOURADA', 'LARANJA', 'MARROM', 'NATURAL', 'PRETO', 'PRETA',
  'PRATA', 'ROSA', 'ROXO', 'ROXA', 'VERDE', 'VERMELHO', 'VERMELHA',
  'BK', 'BLK', 'BLUE', 'GRN', 'NAT', 'NT', 'NTS', 'RED', 'SB', 'SUNBURST', 'WH', 'WHT',
]);

const PALAVRAS_DESCARTAVEIS = new Set(['A', 'AS', 'COM', 'DA', 'DAS', 'DE', 'DO', 'DOS', 'E', 'EM', 'O', 'OS', 'PARA']);

const semInformacao = (valor: unknown) => {
  const texto = String(valor ?? '').trim().toUpperCase();
  return !texto || texto.includes('NÃO INFORMADO') || texto.startsWith('ERRO IA:');
};

interface ProdutoComMedidas {
  codigo?: unknown;
  nome?: unknown;
  peso?: unknown;
  largura?: unknown;
  altura?: unknown;
  profundidade?: unknown;
}

const temMedidasCompletas = (produto: ProdutoComMedidas) =>
  !semInformacao(produto?.peso) &&
  !semInformacao(produto?.largura) &&
  !semInformacao(produto?.altura) &&
  !semInformacao(produto?.profundidade);

const tokensDoProduto = (nome: string) => new Set(
  nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .match(/[A-Z0-9]+(?:[.-][A-Z0-9]+)*/g)
    ?.filter(token => token.length > 1 && !CORES_VARIANTES.has(token) && !PALAVRAS_DESCARTAVEIS.has(token))
    ?? []
);

// Reduz o histórico a poucos candidatos parecidos. A decisão final de que é
// o mesmo modelo físico continua sendo da IA, com regras conservadoras.
const selecionarReferencias = (nome: string, codigo: string, produtos: ProdutoComMedidas[]) => {
  const atuais = tokensDoProduto(nome);
  if (atuais.size === 0) return [];

  return produtos
    .filter(produto => String(produto.codigo) !== String(codigo) && temMedidasCompletas(produto))
    .map(produto => {
      const candidatos = tokensDoProduto(String(produto.nome || ''));
      const iguais = [...atuais].filter(token => candidatos.has(token)).length;
      const similaridade = (2 * iguais) / (atuais.size + candidatos.size || 1);
      return { produto, iguais, similaridade };
    })
    .filter(item => item.iguais >= 2 && item.similaridade >= 0.45)
    .sort((a, b) => b.similaridade - a.similaridade)
    .slice(0, 6)
    .map(({ produto }) => ({
      codigo: String(produto.codigo),
      nome: String(produto.nome),
      peso: String(produto.peso),
      largura: String(produto.largura),
      altura: String(produto.altura),
      profundidade: String(produto.profundidade),
    }));
};

// Nome de pasta/arquivo seguro em Windows, macOS e Linux.
const nomeSeguro = (texto: string) =>
  texto.replace(/[\\/:*?"<>|]/g, '-').trim() || 'sem-codigo';

const deuErro = (res: any) => String(res?.curta || '').startsWith('Erro IA:');

// Desenha a imagem já baixada dentro da moldura branca.
function enquadrar(blobOriginal: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    // URL de blob é do próprio navegador, então o canvas não fica bloqueado.
    const endereco = URL.createObjectURL(blobOriginal);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(endereco);

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

    img.onerror = () => {
      URL.revokeObjectURL(endereco);
      resolve(null);
    };

    img.src = endereco;
  });
}

// Baixa a imagem pelo nosso proxy e devolve ela na moldura branca.
// Em caso de falha devolve o motivo, para o diagnóstico do ZIP.
async function montarImagem(url: string): Promise<{ blob: Blob | null; erro?: string }> {
  let resposta: Response;

  try {
    resposta = await fetch(`/api/imagem?url=${encodeURIComponent(url)}`);
  } catch (e: any) {
    return { blob: null, erro: `falha de rede: ${e.message}` };
  }

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    const dica = resposta.status === 404
      ? ' (a rota /api/imagem não existe no site publicado)'
      : '';
    return { blob: null, erro: `HTTP ${resposta.status}${dica} ${detalhe.slice(0, 140)}`.trim() };
  }

  const original = await resposta.blob();
  const blob = await enquadrar(original);

  if (!blob) {
    return { blob: null, erro: 'o navegador não conseguiu abrir a imagem' };
  }

  return { blob };
}

export default function Home() {
  const router = useRouter();
  const [textoColado, setTextoColado] = useState('');
  const [apiKeyGemini, setApiKeyGemini] = useState('');
  const [apiKeyImg, setApiKeyImg] = useState('');
  const [resultados, setResultados] = useState<any[]>([]);
  const [processando, setProcessando] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const [log, setLog] = useState('');
  const [aviso, setAviso] = useState('');
  const [progresso, setProgresso] = useState({ atual: 0, total: 0 });
  const [porZip, setPorZip] = useState(PADRAO_POR_ZIP);

  // Integração com o Bling
  const [bling, setBling] = useState({ conectado: false, configurado: false });
  const [enviandoBling, setEnviandoBling] = useState(false);
  const [sobrescrever, setSobrescrever] = useState(false);
  const [unidadeMedida, setUnidadeMedida] = useState(1);
  const [envios, setEnvios] = useState<ResultadoEnvio[]>([]);

  // Pedido de parada: o botão marca aqui e o laço encerra no próximo produto.
  const pararRef = useRef(false);

  // Recupera o que já tinha sido processado numa sessão anterior.
  useEffect(() => {
    try {
      const salvo = localStorage.getItem(CHAVE_HISTORICO);
      if (!salvo) return;

      const dados = JSON.parse(salvo);
      if (Array.isArray(dados) && dados.length > 0) {
        setResultados(dados);
        setAviso(
          `${dados.length} produto(s) recuperados da sessão anterior. ` +
          `Você pode baixar o ZIP direto, sem reprocessar.`
        );
      }
    } catch {
      // Histórico corrompido não deve travar a página.
    }
  }, []);

  // Descobre se já existe conexão com o Bling e lê o retorno da autorização.
  useEffect(() => {
    fetch('/api/bling/estado')
      .then(r => r.json())
      .then(setBling)
      .catch(() => {});

    const situacao = new URLSearchParams(window.location.search).get('bling');
    if (situacao === 'conectado') {
      setAviso('Conectado ao Bling.');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (situacao) {
      setAviso(`Não deu para conectar ao Bling — ${situacao}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const desconectarBling = async () => {
    await fetch('/api/bling/estado', { method: 'DELETE' });
    setBling(b => ({ ...b, conectado: false }));
    setAviso('Desconectado do Bling.');
  };

  // Percorre os produtos mandando (ou simulando) para o Bling.
  const mandarParaBling = async (produtos: any[], simular: boolean) => {
    if (produtos.length === 0) return;

    setEnviandoBling(true);
    pararRef.current = false;
    setEnvios([]);
    setAviso('');

    const saidas: ResultadoEnvio[] = [];

    for (let i = 0; i < produtos.length; i++) {
      if (pararRef.current) {
        setLog(`Interrompido em ${i} de ${produtos.length}.`);
        break;
      }

      const saida = await enviarProduto(produtos[i], {
        simular,
        sobrescrever,
        unidadeMedida,
        enquadrar: montarImagem,
        aoAndar: (mensagem) => setLog(`[${i + 1}/${produtos.length}] ${mensagem}`),
      });

      saidas.push(saida);
      setEnvios([...saidas]);
    }

    setEnviandoBling(false);

    const okey = saidas.filter(s => s.enviado).length;
    const falhos = saidas.filter(s => s.erro).length;
    setLog(
      simular
        ? `Simulação concluída em ${saidas.length} produto(s). Confira abaixo o que seria alterado.`
        : `Envio concluído: ${okey} atualizados no Bling, ${falhos} com erro.`
    );
  };

  // Grava a cada produto: se faltar energia, no máximo um produto se perde.
  const salvarHistorico = (dados: any[]) => {
    try {
      localStorage.setItem(CHAVE_HISTORICO, JSON.stringify(dados));
    } catch {
      setAviso(
        'Atenção: o histórico não coube no armazenamento do navegador. ' +
        'Baixe o ZIP do que já foi feito e limpe o histórico antes de continuar.'
      );
    }
  };

  const limparHistorico = () => {
    if (!confirm('Isso apaga todos os produtos já processados. Confirma?')) return;
    localStorage.removeItem(CHAVE_HISTORICO);
    setResultados([]);
    setAviso('');
    setLog('Histórico apagado.');
  };

  const alterarSelecaoImagem = (
    indiceProduto: number,
    campo: CampoImagem,
    selecionar: boolean
  ) => {
    const proximos = resultados.map((produto, indice) => {
      if (indice !== indiceProduto) return produto;

      const excluidas = { ...(produto.imagensExcluidas || {}) };

      if (selecionar) {
        const urlOriginal = excluidas[campo];
        if (!urlOriginal) return produto;

        delete excluidas[campo];
        return { ...produto, [campo]: urlOriginal, imagensExcluidas: excluidas };
      }

      const urlAtual = produto[campo];
      if (!urlAtual) return produto;

      excluidas[campo] = urlAtual;
      return { ...produto, [campo]: '', imagensExcluidas: excluidas };
    });

    setResultados(proximos);
    salvarHistorico(proximos);
    setEnvios([]);
    setAviso(
      selecionar
        ? 'Imagem restaurada. Faça uma nova simulação antes de enviar.'
        : 'Imagem removida do envio. Ela pode ser restaurada antes de enviar.'
    );
  };

  const iniciarProcessamento = async () => {
    if (!apiKeyGemini) {
      alert("Insira sua chave do Gemini.");
      return;
    }

    const linhas = textoColado.trim().split('\n');
    if (linhas.length === 0 || linhas[0] === "") return;

    setProcessando(true);
    setAviso('');
    pararRef.current = false;
    setProgresso({ atual: 0, total: linhas.length });

    // Mantém o que já existe e vai atualizando por código.
    const porCodigo = new Map<string, any>(resultados.map(r => [r.codigo, r]));
    let pulados = 0;
    let cotaAcabou = false;

    for (let i = 0; i < linhas.length; i++) {
      if (pararRef.current) {
        setLog(`Interrompido em ${i} de ${linhas.length}. O que já foi feito está salvo.`);
        break;
      }

      const partes = linhas[i].split('\t');
      const codigo = partes.length > 1 ? partes[0] : `TEMP-${i}`;
      const nome = partes.length > 1 ? partes[1] : partes[0];

      // Produtos completos são pulados. Os antigos que vieram sem peso ou
      // medidas voltam para a IA, mas conservam as imagens já escolhidas.
      const anterior = porCodigo.get(codigo);
      if (anterior && !deuErro(anterior) && temMedidasCompletas(anterior)) {
        pulados++;
        setProgresso({ atual: i + 1, total: linhas.length });
        continue;
      }

      const referencias = selecionarReferencias(nome, codigo, [...porCodigo.values()]);

      // Se a cota estourar, espera o tempo que o Google pediu e tenta o
      // mesmo produto de novo. Três recusas seguidas significam que a cota
      // do dia acabou, e aí não adianta insistir.
      let dados: any = null;

      for (let volta = 1; volta <= 3; volta++) {
        if (pararRef.current) break;

        setLog(`[${i + 1}/${linhas.length}] Processando: ${nome}`);

        try {
          const res = await fetch('/api/processar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nome,
              apiKey: apiKeyGemini,
              apiKeyImg,
              referencias,
              // Ao completar uma ficha antiga, não gasta nova busca de imagem.
              buscarImagens: !anterior,
            })
          });
          dados = await res.json();
        } catch (e: any) {
          setLog(`Erro de rede em ${nome}: ${e.message}`);
          break;
        }

        if (!dados?.cotaExcedida) break;

        if (volta === 3) {
          cotaAcabou = true;
          break;
        }

        const segundos = Math.max(5, Number(dados.esperarSegundos) || 60);
        for (let resta = segundos; resta > 0; resta--) {
          if (pararRef.current) break;
          setLog(
            `Cota da IA atingida. Aguardando ${resta}s para tentar de novo ` +
            `(${nome}). Tentativa ${volta} de 3.`
          );
          await espera(1000);
        }
      }

      if (cotaAcabou) {
        setAviso(
          'A cota diária gratuita do Gemini acabou (500 requisições por dia). ' +
          'Tudo que já foi processado está salvo: você pode baixar o ZIP agora e, ' +
          'amanhã, colar a mesma lista e clicar em Iniciar — os prontos serão pulados ' +
          'e só os que faltam vão ser processados.'
        );
        setLog(`Parado em ${i} de ${linhas.length} por falta de cota. Nada foi perdido.`);
        break;
      }

      if (dados && !(anterior && !deuErro(anterior) && deuErro(dados))) {
        const valorDaFicha = (campo: 'peso' | 'largura' | 'altura' | 'profundidade') =>
          anterior && !semInformacao(anterior[campo]) ? anterior[campo] : dados[campo] || "";
        const fichaComplementada = anterior &&
          ['peso', 'largura', 'altura', 'profundidade'].some(campo => !semInformacao(anterior[campo]));

        porCodigo.set(codigo, {
          ...(anterior || {}),
          codigo,
          nome,
          curta: anterior?.curta || dados.curta || "",
          longa: anterior?.longa || dados.longa || "",
          marca: anterior && !semInformacao(anterior.marca)
            ? anterior.marca
            : dados.marca || "",
          peso: valorDaFicha('peso'),
          largura: valorDaFicha('largura'),
          altura: valorDaFicha('altura'),
          profundidade: valorDaFicha('profundidade'),
          origemMedidas: fichaComplementada
            ? 'COMPLEMENTADO'
            : dados.origemMedidas || anterior?.origemMedidas || "",
          codigoReferencia: dados.codigoReferencia || "",
          justificativaMedidas: dados.justificativaMedidas || "",
          img1: anterior ? anterior.img1 || "" : dados.imagens?.[0] || "",
          img2: anterior ? anterior.img2 || "" : dados.imagens?.[1] || "",
          img3: anterior ? anterior.img3 || "" : dados.imagens?.[2] || "",
          img4: anterior ? anterior.img4 || "" : dados.imagens?.[3] || "",
        });

        const lista = [...porCodigo.values()];
        setResultados(lista);
        salvarHistorico(lista);
      }
      setProgresso({ atual: i + 1, total: linhas.length });

      // Respiro entre produtos para não estourar o limite por minuto da IA.
      if (i < linhas.length - 1) await espera(1500);
    }

    setProcessando(false);

    const lista = [...porCodigo.values()];
    const comErro = lista.filter(deuErro).length;
    const semImagem = lista.filter(r => !r.img1).length;

    if (!cotaAcabou) {
      setLog(
        `Lote concluído: ${lista.length} produtos no total` +
        (pulados > 0 ? ` (${pulados} já estavam prontos e foram pulados)` : '') +
        `. ${comErro} com falha na descrição, ${semImagem} sem imagem.`
      );
    }
  };

  const exportarCSV = () => {
    // Ponto e vírgula para o Excel separar as colunas corretamente
    const cabecalho =
      "Código;Produto;Marca;Peso;Largura;Altura;Profundidade;Origem das medidas;Código de referência;" +
      "Descrição Curta;Descrição;Imagem 1;Imagem 2;Imagem 3;Imagem 4\n";

    const aspas = (valor: string) => `"${(valor || "").replace(/"/g, '""')}"`;

    const linhasCSV = resultados.map(r => [
      r.codigo, r.nome, r.marca, r.peso, r.largura, r.altura, r.profundidade,
      r.origemMedidas, r.codigoReferencia,
      r.curta, r.longa, r.img1, r.img2, r.img3, r.img4
    ].map(aspas).join(";")).join("\n");

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
    pararRef.current = false;

    const tamanhoLote = Math.max(1, Number(porZip) || PADRAO_POR_ZIP);
    const totalPartes = Math.ceil(resultados.length / tamanhoLote);
    const codificador = new TextEncoder();
    let totalImagens = 0;
    let falhas = 0;

    for (let parte = 0; parte < totalPartes; parte++) {
      if (pararRef.current) {
        setLog(`Download interrompido na parte ${parte + 1} de ${totalPartes}.`);
        break;
      }

      const fatia = resultados.slice(parte * tamanhoLote, (parte + 1) * tamanhoLote);
      const arquivos: ArquivoZip[] = [];
      const diagnostico: string[] = [];

      for (let i = 0; i < fatia.length; i++) {
        if (pararRef.current) break;

        const res = fatia[i];
        const codigo = nomeSeguro(res.codigo);
        setLog(
          `Parte ${parte + 1}/${totalPartes} — produto ${i + 1}/${fatia.length}: ${codigo}`
        );

        const urls = [res.img1, res.img2, res.img3, res.img4].filter(Boolean);
        let numero = 1;

        for (const url of urls) {
          const { blob, erro } = await montarImagem(url);
          if (blob) {
            arquivos.push({
              caminho: `${codigo}/${codigo}_${numero}.jpg`,
              dados: new Uint8Array(await blob.arrayBuffer())
            });
            numero++;
            totalImagens++;
          } else {
            falhas++;
            diagnostico.push(`[${codigo}] ${erro}\n   url: ${url}`);
          }
        }

        const texto =
          `CÓDIGO: ${res.codigo}\n` +
          `PRODUTO: ${res.nome}\n` +
          `MARCA: ${res.marca}\n\n` +
          `=== MEDIDAS (estimadas pela IA — confira antes de cadastrar) ===\n` +
          `PESO: ${res.peso}\n` +
          `LARGURA: ${res.largura}\n` +
          `ALTURA: ${res.altura}\n` +
          `PROFUNDIDADE: ${res.profundidade}\n\n` +
          `ORIGEM: ${res.origemMedidas === 'REAPROVEITADO'
            ? `reaproveitado do código ${res.codigoReferencia}`
            : res.origemMedidas === 'COMPLEMENTADO'
              ? 'ficha anterior complementada pela IA'
              : 'estimativa da IA'}\n` +
          `OBSERVAÇÃO: ${res.justificativaMedidas || 'Confira as medidas antes de cadastrar.'}\n\n` +
          `=== DESCRIÇÃO CURTA ===\n${res.curta}\n\n` +
          `=== DESCRIÇÃO LONGA ===\n${res.longa}\n`;

        arquivos.push({
          caminho: `${codigo}/${codigo}_descricao.txt`,
          // "\uFEFF" no começo faz o Bloco de Notas abrir os acentos corretamente.
          dados: codificador.encode("\uFEFF" + texto)
        });
      }

      if (diagnostico.length > 0) {
        arquivos.push({
          caminho: `_imagens_que_falharam.txt`,
          dados: codificador.encode(
            "\uFEFFImagens que não puderam ser baixadas e o motivo:\n\n" + diagnostico.join("\n\n") + "\n"
          )
        });
      }

      setLog(`Compactando parte ${parte + 1} de ${totalPartes}...`);
      const nomeZip = totalPartes === 1
        ? 'produtos_bling.zip'
        : `produtos_bling_parte${parte + 1}de${totalPartes}.zip`;
      baixarArquivo(montarZip(arquivos), nomeZip);

      // Uma pausa dá tempo do navegador gravar o arquivo e liberar memória.
      await espera(1500);
    }

    setBaixando(false);
    setLog(
      `Pacote pronto: ${resultados.length} pastas em ${totalPartes} arquivo(s) ZIP, ` +
      `${totalImagens} imagens em 420x420. ` +
      (falhas > 0
        ? `${falhas} falharam — veja _imagens_que_falharam.txt dentro do ZIP.`
        : `Nenhuma falha.`)
    );
  };

  const ocupado = processando || baixando || enviandoBling;

  const sairAplicacao = async () => {
    await fetch('/api/acesso/sair', { method: 'POST' }).catch(() => null);
    router.replace('/login');
    router.refresh();
  };

  return (
    <main className="p-6 md:p-10 max-w-7xl mx-auto">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Enriquecedor Bling PRO</h1>
          <p className="text-gray-600 mt-1">
            Gera descrição curta, descrição longa e busca 4 imagens para cada produto.
          </p>
        </div>
        <button
          type="button"
          onClick={sairAplicacao}
          className="shrink-0 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          Sair
        </button>
      </header>

      {aviso && (
        <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-4 mb-6 text-sm">
          {aviso}
        </div>
      )}

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

        <div className="flex flex-wrap items-end gap-3 mt-4">
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

          {ocupado && (
            <button
              onClick={() => { pararRef.current = true; }}
              className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition-colors"
            >
              Parar
            </button>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Produtos por ZIP
            </label>
            <input
              type="number"
              min={1}
              value={porZip}
              onChange={(e) => setPorZip(Number(e.target.value))}
              disabled={ocupado}
              className="w-28 p-2 border border-gray-300 rounded-lg text-gray-900 bg-white text-sm"
            />
          </div>

          <button
            onClick={limparHistorico}
            disabled={ocupado || resultados.length === 0}
            className="px-4 py-2.5 text-sm text-gray-600 hover:text-red-600 underline disabled:opacity-40 disabled:no-underline"
          >
            Limpar histórico
          </button>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Cada produto é salvo no navegador assim que fica pronto, então uma queda de energia
          não faz perder o lote: ao reabrir a página, tudo volta e o ZIP pode ser baixado de novo.
          Reprocessar a mesma lista pula o que já está pronto e não gasta créditos à toa.
        </p>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Enviar para o Bling</h2>
            <p className="text-sm text-gray-600">
              Atualiza os produtos que já existem no seu Bling, procurando pelo código.
            </p>
          </div>

          {!bling.configurado ? (
            <span className="text-sm text-amber-700 bg-amber-50 border border-amber-300 rounded px-3 py-1.5">
              Falta configurar BLING_CLIENT_ID e BLING_CLIENT_SECRET na Vercel
            </span>
          ) : bling.conectado ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-green-700 bg-green-50 border border-green-300 rounded px-3 py-1.5">
                Conectado
              </span>
              <button onClick={desconectarBling} className="text-sm text-gray-600 underline hover:text-red-600">
                desconectar
              </button>
            </div>
          ) : (
            <a
              href="/api/bling/autorizar"
              className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg font-semibold text-sm"
            >
              Conectar ao Bling
            </a>
          )}
        </div>

        {bling.conectado && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <button
                onClick={() => mandarParaBling(resultados.slice(0, 1), true)}
                disabled={ocupado || resultados.length === 0}
                className="px-5 py-2.5 bg-slate-600 hover:bg-slate-700 text-white rounded-lg font-semibold text-sm disabled:opacity-50"
              >
                1. Simular o primeiro
              </button>

              <button
                onClick={() => mandarParaBling(resultados.slice(0, 1), false)}
                disabled={ocupado || resultados.length === 0}
                className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-semibold text-sm disabled:opacity-50"
              >
                2. Enviar só o primeiro
              </button>

              <button
                onClick={() => {
                  if (confirm(`Isso vai alterar ${resultados.length} produtos no seu Bling de verdade. Confirma?`)) {
                    mandarParaBling(resultados, false);
                  }
                }}
                disabled={ocupado || resultados.length === 0}
                className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm disabled:opacity-50"
              >
                3. Enviar todos ({resultados.length})
              </button>

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={sobrescrever}
                  onChange={(e) => setSobrescrever(e.target.checked)}
                  disabled={ocupado}
                  className="w-4 h-4"
                />
                Sobrescrever o que já está preenchido no Bling
              </label>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Unidade das dimensões
                </label>
                <select
                  value={unidadeMedida}
                  onChange={(e) => setUnidadeMedida(Number(e.target.value))}
                  disabled={ocupado}
                  className="p-2 border border-gray-300 rounded-lg text-gray-900 bg-white text-sm"
                >
                  <option value={0}>0 — metros</option>
                  <option value={1}>1 — centímetros</option>
                  <option value={2}>2 — milímetros</option>
                </select>
              </div>
            </div>

            <p className="text-xs text-gray-500 mt-3">
              Siga na ordem: simule, confira, mande um produto só, veja no Bling se ficou certo,
              e só então envie o lote. Sem marcar &quot;sobrescrever&quot;, marca, peso e dimensões
              só entram nos campos que estiverem vazios no Bling — as descrições sempre são atualizadas.
              A unidade escolhida vale apenas para produtos que ainda não têm dimensões cadastradas;
              nos demais, a unidade que já está no Bling é respeitada.
            </p>
          </>
        )}
      </section>

      <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm min-h-[56px] flex items-center mb-6">
        {log || (resultados.length > 0
          ? `${resultados.length} produto(s) no histórico. Pronto para baixar.`
          : "Pronto para processar.")}
      </div>

      {envios.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
          <h3 className="font-bold text-gray-900 mb-3">Resultado do envio</h3>
          <div className="space-y-2 max-h-96 overflow-y-auto text-sm">
            {envios.map((e, i) => (
              <div key={i} className="border-b border-gray-100 pb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-gray-900">{e.codigo}</span>
                  {e.erro ? (
                    <span className="text-red-600">falhou</span>
                  ) : e.simulado ? (
                    <span className="text-slate-600">simulado</span>
                  ) : e.enviado ? (
                    <span className="text-green-700">atualizado</span>
                  ) : (
                    <span className="text-gray-500">sem alteração</span>
                  )}
                </div>

                {e.erro && <div className="text-red-600 text-xs mt-1">{e.erro}</div>}
                {e.aviso && <div className="text-gray-600 text-xs mt-1">{e.aviso}</div>}

                {e.alterados && e.alterados.length > 0 && (
                  <div className="text-xs text-gray-700 mt-1">
                    Alterar: {e.alterados.join(', ')}
                  </div>
                )}
                {e.ignorados && e.ignorados.length > 0 && (
                  <div className="text-xs text-amber-700 mt-1">
                    Não alterado: {e.ignorados.join('; ')}
                  </div>
                )}
                {e.avisosBling && e.avisosBling.length > 0 && (
                  <div className="text-xs text-amber-700 mt-1">
                    Bling avisou: {e.avisosBling.join('; ')}
                  </div>
                )}
                {e.corpo && (
                  <details className="mt-1">
                    <summary className="text-xs text-blue-600 cursor-pointer">
                      ver o que seria enviado
                    </summary>
                    <pre className="text-[11px] bg-gray-50 p-2 rounded mt-1 overflow-x-auto text-gray-800">
                      {JSON.stringify(e.corpo, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {resultados.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-blue-50 border-b border-blue-100 text-sm text-blue-900">
            Use <strong>×</strong> para não enviar uma imagem. Se mudar de ideia, use{' '}
            <strong>↶ restaurar</strong>. A imagem original não é apagada.
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="p-3 font-semibold text-gray-700">Código</th>
                  <th className="p-3 font-semibold text-gray-700">Nome</th>
                  <th className="p-3 font-semibold text-gray-700">Imagens</th>
                  <th className="p-3 font-semibold text-gray-700">Ficha</th>
                  <th className="p-3 font-semibold text-gray-700">Descrição Curta</th>
                  <th className="p-3 font-semibold text-gray-700">Descrição Longa</th>
                </tr>
              </thead>
              <tbody>
                {resultados.map((res, index) => {
                  const falhou = deuErro(res);
                  return (
                    <tr key={index} className="border-b border-gray-100 align-top hover:bg-gray-50">
                      <td className="p-3 text-gray-900 font-mono">{res.codigo}</td>
                      <td className="p-3 text-gray-900 min-w-[180px]">{res.nome}</td>
                      <td className="p-3">
                        <div className="grid grid-cols-2 gap-1.5 w-[150px]">
                          {CAMPOS_IMAGEM.map((campo, i) => {
                            const img = res[campo];
                            const removida = res.imagensExcluidas?.[campo];

                            if (img) {
                              return (
                                <div key={campo} className="relative w-[70px] h-[70px]">
                                  <a href={img} target="_blank" rel="noreferrer">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={img}
                                      alt={`${res.nome} ${i + 1}`}
                                      className="w-[70px] h-[70px] object-cover rounded border border-gray-200 hover:border-blue-500 transition-colors"
                                    />
                                  </a>
                                  <button
                                    type="button"
                                    onClick={() => alterarSelecaoImagem(index, campo, false)}
                                    disabled={ocupado}
                                    aria-label={`Remover imagem ${i + 1} de ${res.nome} do envio`}
                                    title="Não enviar esta imagem"
                                    className="absolute -right-1.5 -top-1.5 w-6 h-6 rounded-full bg-red-600 hover:bg-red-700 text-white font-bold leading-none shadow disabled:opacity-50"
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            }

                            if (removida) {
                              return (
                                <button
                                  key={campo}
                                  type="button"
                                  onClick={() => alterarSelecaoImagem(index, campo, true)}
                                  disabled={ocupado}
                                  aria-label={`Restaurar imagem ${i + 1} de ${res.nome}`}
                                  title="Restaurar esta imagem"
                                  className="w-[70px] h-[70px] flex flex-col items-center justify-center text-red-700 text-xs bg-red-50 border border-dashed border-red-300 rounded hover:bg-red-100 disabled:opacity-50"
                                >
                                  <span className="text-lg leading-none" aria-hidden="true">↶</span>
                                  restaurar
                                </button>
                              );
                            }

                            return (
                              <div
                                key={campo}
                                className="w-[70px] h-[70px] flex items-center justify-center text-gray-400 text-xs bg-gray-50 border border-dashed border-gray-300 rounded"
                              >
                                vazio
                              </div>
                            );
                          })}
                        </div>
                      </td>
                      <td className="p-3 text-xs text-gray-700 whitespace-nowrap">
                        <div><span className="text-gray-500">Marca:</span> {res.marca}</div>
                        <div><span className="text-gray-500">Peso:</span> {res.peso}</div>
                        <div><span className="text-gray-500">L:</span> {res.largura}</div>
                        <div><span className="text-gray-500">A:</span> {res.altura}</div>
                        <div><span className="text-gray-500">P:</span> {res.profundidade}</div>
                        {res.origemMedidas && (
                          <div className={`mt-2 whitespace-normal rounded px-2 py-1 ${
                            res.origemMedidas === 'REAPROVEITADO'
                              ? 'bg-green-50 text-green-800'
                              : 'bg-amber-50 text-amber-800'
                          }`} title={res.justificativaMedidas || undefined}>
                            {res.origemMedidas === 'REAPROVEITADO'
                              ? `Mesmas medidas do código ${res.codigoReferencia}`
                              : res.origemMedidas === 'COMPLEMENTADO'
                                ? 'Ficha anterior complementada — confira'
                                : 'Estimativa da IA — confira'}
                          </div>
                        )}
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
