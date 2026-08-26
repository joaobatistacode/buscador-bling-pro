'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { montarZip, type ArquivoZip } from './zip';
import { enviarProduto, type ResultadoEnvio } from './enviar-bling';
import { ProductReview } from './components/product-review';
import { WorkflowStepper, type EtapaFluxo } from './components/workflow-stepper';
import { produtoComErro, produtoSemFotos, type CampoImagem, type ProdutoResultado } from './produtos';
import { DashboardView, HistoryView, TasksView } from './components/operations-hub';
import { CategoryAdminView } from './components/category-admin';

const espera = (ms: number) => new Promise(r => setTimeout(r, ms));

// Medidas pedidas: a foto cabe em 350x350 e fica centralizada
// numa moldura branca de 420x420.
const LADO_MOLDURA = 420;
const LADO_FOTO = 350;

// Onde o histórico fica guardado no navegador. Sobrevive a queda de
// energia e a fechar o navegador: só some se o usuário limpar.
const CHAVE_HISTORICO = 'buscador-bling:resultados';
const CHAVE_GEMINI_SESSAO = 'buscador-bling:gemini';
const CHAVE_SERPER_SESSAO = 'buscador-bling:serper';
const CHAVE_SITES_IMAGENS = 'buscador-bling:sites-imagens';
const CHAVE_LIMITE_CONSULTAS_IMAGENS = 'buscador-bling:limite-consultas-imagens';
const SITES_IMAGENS_PADRAO = 'madeiramadeira.com.br';
const LIMITE_CONSULTAS_IMAGENS_PADRAO = 3;

// Cada lote vira um ZIP separado. Um ZIP único com centenas de produtos
// fica grande demais para o navegador montar de uma vez só.
const PADRAO_POR_ZIP = 100;

const ETAPAS: EtapaFluxo[] = [
  { numero: 1, titulo: 'Importar', descricao: 'Cole a lista e confira o lote.' },
  { numero: 2, titulo: 'Processar', descricao: 'Gere imagens, descrições e ficha técnica.' },
  { numero: 3, titulo: 'Revisar', descricao: 'Confira e edite produto por produto.' },
  { numero: 4, titulo: 'Aprovar', descricao: 'Valide o lote antes de qualquer envio.' },
  { numero: 5, titulo: 'Enviar', descricao: 'Simule e envie os produtos ao Bling.' },
];

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

const deuErro = (produto: ProdutoResultado) => produtoComErro(produto);
const temFichaCompleta = (produto: ProdutoResultado | undefined) => Boolean(
  produto && !semInformacao(produto.curta) && temMedidasCompletas(produto)
);

const erroDeChaveGemini = (dados: unknown) => {
  const resposta = dados && typeof dados === 'object'
    ? dados as Record<string, unknown>
    : {};
  return /(?:API key not valid|API_KEY_INVALID|invalid API key)/i.test(
    String(resposta.curta || resposta.error || '')
  );
};

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
  const [visaoAtual, setVisaoAtual] = useState<'dashboard' | 'fluxo' | 'categorias' | 'historico' | 'tarefas' | 'configuracoes'>('fluxo');
  const [etapaAtual, setEtapaAtual] = useState(1);
  const [loteAprovado, setLoteAprovado] = useState(false);
  const [textoColado, setTextoColado] = useState('');
  const [apiKeyGemini, setApiKeyGemini] = useState('');
  const [apiKeyImg, setApiKeyImg] = useState('');
  const [sitesImagens, setSitesImagens] = useState(SITES_IMAGENS_PADRAO);
  const [limiteConsultasImagens, setLimiteConsultasImagens] = useState(LIMITE_CONSULTAS_IMAGENS_PADRAO);
  const [resultados, setResultados] = useState<ProdutoResultado[]>([]);
  const [processando, setProcessando] = useState(false);
  const [buscandoImagens, setBuscandoImagens] = useState(false);
  const [buscandoDescricoes, setBuscandoDescricoes] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const [log, setLog] = useState('');
  const [aviso, setAviso] = useState('');
  const [progresso, setProgresso] = useState({ atual: 0, total: 0 });
  const [porZip, setPorZip] = useState(PADRAO_POR_ZIP);

  // Integração com o Bling
  const [bling, setBling] = useState({ conectado: false, configurado: false });
  const [telegram, setTelegram] = useState({ configurado: false });
  const [testandoTelegram, setTestandoTelegram] = useState(false);
  const [enviandoBling, setEnviandoBling] = useState(false);
  const [sobrescrever, setSobrescrever] = useState(false);
  const [unidadeMedida, setUnidadeMedida] = useState(1);
  const [envios, setEnvios] = useState<ResultadoEnvio[]>([]);

  // Pedido de parada: o botão marca aqui e o laço encerra no próximo produto.
  const pararRef = useRef(false);
  const sincronizarRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recupera o que já tinha sido processado numa sessão anterior.
  useEffect(() => {
    const quadro = requestAnimationFrame(() => {
      setApiKeyGemini(sessionStorage.getItem(CHAVE_GEMINI_SESSAO) || '');
      setApiKeyImg(sessionStorage.getItem(CHAVE_SERPER_SESSAO) || '');
      setSitesImagens(localStorage.getItem(CHAVE_SITES_IMAGENS) || SITES_IMAGENS_PADRAO);
      setLimiteConsultasImagens(Math.min(12, Math.max(1,
        Number(localStorage.getItem(CHAVE_LIMITE_CONSULTAS_IMAGENS)) || LIMITE_CONSULTAS_IMAGENS_PADRAO
      )));
    });

    try {
      const salvo = localStorage.getItem(CHAVE_HISTORICO);
      if (salvo) {
        const dados = JSON.parse(salvo);
        if (Array.isArray(dados) && dados.length > 0) {
          setResultados(dados);
          fetch('/api/historico', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ produtos: dados }),
          }).catch(() => null);
          setAviso(
            `${dados.length} produto(s) recuperados da sessão anterior. ` +
            `Você pode baixar o ZIP direto, sem reprocessar.`
          );
        }
      }
    } catch {
      // Histórico corrompido não deve travar a página.
    }
    return () => cancelAnimationFrame(quadro);
  }, []);

  // Descobre se já existe conexão com o Bling e lê o retorno da autorização.
  useEffect(() => {
    fetch('/api/bling/estado')
      .then(r => r.json())
      .then(setBling)
      .catch(() => {});

    fetch('/api/notificacao/telegram')
      .then(r => r.json())
      .then(dados => setTelegram({ configurado: dados.configurado === true }))
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

  const testarTelegram = async () => {
    setTestandoTelegram(true);
    try {
      const resposta = await fetch('/api/notificacao/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo: 'teste' }),
      });
      const dados = await resposta.json().catch(() => ({}));
      setAviso(resposta.ok
        ? 'Notificação de teste enviada. Confira o Telegram no celular.'
        : `Não foi possível testar o Telegram — ${dados.erro || `HTTP ${resposta.status}`}`);
    } catch (erro) {
      setAviso(`Não foi possível testar o Telegram — ${erro instanceof Error ? erro.message : 'falha de rede'}`);
    } finally {
      setTestandoTelegram(false);
    }
  };

  const salvarConfiguracoes = () => {
    sessionStorage.setItem(CHAVE_GEMINI_SESSAO, apiKeyGemini);
    sessionStorage.setItem(CHAVE_SERPER_SESSAO, apiKeyImg);
    localStorage.setItem(CHAVE_SITES_IMAGENS, sitesImagens);
    localStorage.setItem(CHAVE_LIMITE_CONSULTAS_IMAGENS, String(limiteConsultasImagens));
    setAviso('Configurações salvas. As chaves valem nesta sessão; sites e limite de consultas ficam neste navegador.');
    setVisaoAtual('fluxo');
  };

  const cancelarConfiguracoes = () => {
    setApiKeyGemini(sessionStorage.getItem(CHAVE_GEMINI_SESSAO) || '');
    setApiKeyImg(sessionStorage.getItem(CHAVE_SERPER_SESSAO) || '');
    setSitesImagens(localStorage.getItem(CHAVE_SITES_IMAGENS) || SITES_IMAGENS_PADRAO);
    setLimiteConsultasImagens(Math.min(12, Math.max(1,
      Number(localStorage.getItem(CHAVE_LIMITE_CONSULTAS_IMAGENS)) || LIMITE_CONSULTAS_IMAGENS_PADRAO
    )));
    setVisaoAtual('fluxo');
  };

  // Percorre os produtos mandando (ou simulando) para o Bling.
  const mandarParaBling = async (produtos: ProdutoResultado[], simular: boolean) => {
    if (produtos.length === 0) return;

    setEnviandoBling(true);
    pararRef.current = false;
    setEnvios([]);
    setAviso('');

    const saidas: ResultadoEnvio[] = [];
    const inicioEnvio = Date.now();

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

    if (!simular) {
      const enviados = new Set(saidas.filter(s => s.enviado).map(s => s.codigo));
      if (enviados.size > 0) {
        try {
          const respostaContadores = await fetch('/api/dashboard/registrar-envios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigos: Array.from(enviados) }),
          });
          const dadosContadores = await respostaContadores.json().catch(() => ({}));
          if (!respostaContadores.ok) {
            throw new Error(dadosContadores.erro || `HTTP ${respostaContadores.status}`);
          }
        } catch (erro) {
          setAviso(
            `Os produtos foram enviados ao Bling, mas os contadores do painel não foram atualizados — ${
              erro instanceof Error ? erro.message : 'falha de rede'
            }`
          );
        }
      }
      const atualizados = resultados.map(produto => enviados.has(produto.codigo)
        ? { ...produto, enviadoBling: true, enviadoEm: new Date().toISOString() }
        : produto);
      setResultados(atualizados);
      salvarHistorico(atualizados);

      if (telegram.configurado) {
        const tipo = pararRef.current ? 'envio_interrompido' : falhos > 0 ? 'envio_com_alertas' : 'envio_concluido';
        fetch('/api/notificacao/telegram', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tipo, total: produtos.length, enviados: okey, erros: falhos, processados: saidas.length, duracaoSegundos: Math.round((Date.now() - inicioEnvio) / 1000), codigosErro: saidas.filter(s => s.erro).slice(0, 8).map(s => s.codigo) }),
        }).catch(() => null);
      }
    }
  };

  // Grava a cada produto: se faltar energia, no máximo um produto se perde.
  const salvarHistorico = (dados: ProdutoResultado[]) => {
    try {
      localStorage.setItem(CHAVE_HISTORICO, JSON.stringify(dados));
      if (sincronizarRef.current) clearTimeout(sincronizarRef.current);
      sincronizarRef.current = setTimeout(() => {
        fetch('/api/historico', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ produtos: dados }),
        }).catch(() => null);
      }, 800);
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
    setLoteAprovado(false);
    setEtapaAtual(1);
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
    setLoteAprovado(false);
    setEnvios([]);
    setAviso(
      selecionar
        ? 'Imagem restaurada. Faça uma nova simulação antes de enviar.'
        : 'Imagem removida do envio. Ela pode ser restaurada antes de enviar.'
    );
  };

  const atualizarResultado = (
    indiceProduto: number,
    campo: keyof ProdutoResultado,
    valor: string
  ) => {
    const proximos = resultados.map((produto, indice) =>
      indice === indiceProduto ? { ...produto, [campo]: valor } : produto
    );
    setResultados(proximos);
    salvarHistorico(proximos);
    setEnvios([]);
    setLoteAprovado(false);
  };

  const marcarRevisado = (indiceProduto: number, revisado: boolean) => {
    const proximos = resultados.map((produto, indice) => indice === indiceProduto ? { ...produto, revisado } : produto);
    setResultados(proximos);
    salvarHistorico(proximos);
    setEnvios([]);
    setLoteAprovado(false);
  };

  const removerDaRevisao = (indices: number[]) => {
    const selecionados = new Set(indices);
    const removidos = resultados.filter((_, indice) => selecionados.has(indice));
    if (removidos.length === 0) return;

    const proximos = resultados.filter((_, indice) => !selecionados.has(indice));
    if (proximos.length > 0) {
      setResultados(proximos);
      salvarHistorico(proximos);
    } else {
      localStorage.removeItem(CHAVE_HISTORICO);
      setResultados([]);
      setEtapaAtual(1);
    }
    setEnvios([]);
    setLoteAprovado(false);
    setAviso(
      `${removidos.length} produto(s) retirado(s) da revisão e do lote de envio. ` +
      `Nenhum cadastro foi excluído ou alterado no Bling; eles continuam disponíveis no Histórico.`
    );
  };

  const definirImagemManual = (
    indiceProduto: number,
    campo: CampoImagem,
    url: string
  ) => {
    const proximos = resultados.map((produto, indice) => {
      if (indice !== indiceProduto) return produto;
      const excluidas = { ...(produto.imagensExcluidas || {}) };
      delete excluidas[campo];
      return { ...produto, [campo]: url, imagensExcluidas: excluidas };
    });
    setResultados(proximos);
    salvarHistorico(proximos);
    setEnvios([]);
    setLoteAprovado(false);
    setAviso('Imagem manual aplicada. Faça uma nova simulação antes de enviar ao Bling.');
  };

  const buscarImagensNovamente = async (indices: number[]) => {
    const unicos = [...new Set(indices)].filter(indice => resultados[indice]);
    if (unicos.length === 0) return;
    if (!apiKeyImg) {
      setAviso('Configure a chave do Serper antes de buscar novas imagens.');
      setVisaoAtual('configuracoes');
      return;
    }

    setBuscandoImagens(true);
    setAviso('');
    pararRef.current = false;
    let proximos = resultados;
    let concluidos = 0;

    for (let posicao = 0; posicao < unicos.length; posicao++) {
      if (pararRef.current) break;
      const indice = unicos[posicao];
      const produto = proximos[indice];
      setLog(`[${posicao + 1}/${unicos.length}] Buscando novas imagens: ${produto.nome}`);

      try {
        const resposta = await fetch('/api/processar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome: produto.nome,
            apiKeyImg,
            sitesPreferenciais: sitesImagens
              .split(/[\n,]+/)
              .map(site => site.trim())
              .filter(Boolean),
            limiteConsultasImagens,
            somenteImagens: true,
          }),
        });
        const dados = await resposta.json();
        if (!resposta.ok) throw new Error(dados.error || 'Falha ao consultar o Serper.');

        proximos = proximos.map((item, itemIndice) => itemIndice === indice
          ? {
              ...item,
              imagensSugeridas: Array.isArray(dados.imagens) ? dados.imagens : [],
              imagensSugeridasDetalhes: Array.isArray(dados.imagensDetalhes) ? dados.imagensDetalhes : [],
            }
          : item);
        setResultados(proximos);
        salvarHistorico(proximos);
        concluidos++;
      } catch (erro: unknown) {
        const mensagem = erro instanceof Error ? erro.message : 'Erro desconhecido.';
        setLog(`Falha ao buscar imagens de ${produto.codigo}: ${mensagem}`);
      }
    }

    setBuscandoImagens(false);
    setLoteAprovado(false);
    setEnvios([]);
    setLog(pararRef.current
      ? `Busca interrompida com segurança: ${concluidos} de ${unicos.length} produto(s) concluídos.`
      : `Nova busca concluída para ${concluidos} produto(s). Abra cada produto e escolha até 4 imagens.`);
  };

  const buscarDescricoesNovamente = async (indices: number[]) => {
    const unicos = [...new Set(indices)].filter(indice => resultados[indice]);
    if (unicos.length === 0) return;
    if (!apiKeyGemini) {
      setAviso('Configure uma chave válida do Gemini antes de buscar as descrições.');
      setVisaoAtual('configuracoes');
      return;
    }

    setBuscandoDescricoes(true);
    setAviso('');
    pararRef.current = false;
    let proximos = resultados;
    let concluidos = 0;
    let falhas = 0;

    for (let posicao = 0; posicao < unicos.length; posicao++) {
      if (pararRef.current) break;
      const indice = unicos[posicao];
      const produto = proximos[indice];
      setLog(`[${posicao + 1}/${unicos.length}] Buscando descrição: ${produto.nome}`);

      let dados: Record<string, unknown> | null = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        if (pararRef.current) break;
        try {
          const resposta = await fetch('/api/processar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nome: produto.nome,
              apiKey: apiKeyGemini,
              somenteDescricao: true,
            }),
          });
          dados = await resposta.json();
          if (!resposta.ok) throw new Error(String(dados?.error || 'Falha ao consultar o Gemini.'));
        } catch (erro: unknown) {
          dados = { error: erro instanceof Error ? erro.message : 'Erro de rede.' };
        }

        if (erroDeChaveGemini(dados)) {
          setAviso('A chave do Gemini foi recusada. Corrija a chave em Configurações e tente novamente; nenhuma descrição existente foi apagada.');
          pararRef.current = true;
          break;
        }
        if (dados?.cotaExcedida !== true) break;
        if (tentativa === 3) {
          setAviso('A cota do Gemini continua indisponível. As descrições já concluídas foram salvas e as demais ficaram intactas.');
          pararRef.current = true;
          break;
        }

        const segundos = Math.max(5, Number(dados.esperarSegundos) || 60);
        for (let resta = segundos; resta > 0; resta--) {
          if (pararRef.current) break;
          setLog(`Cota da IA atingida. Aguardando ${resta}s para tentar novamente (${produto.nome}).`);
          await espera(1000);
        }
      }

      const curta = String(dados?.curta || '').trim();
      if (!pararRef.current && curta && !curta.toUpperCase().startsWith('ERRO IA:')) {
        proximos = proximos.map((item, itemIndice) => itemIndice === indice
          ? { ...item, curta, revisado: false }
          : item);
        setResultados(proximos);
        salvarHistorico(proximos);
        concluidos++;
      } else if (!pararRef.current) {
        falhas++;
      }

      if (!pararRef.current && posicao < unicos.length - 1) await espera(1500);
    }

    setBuscandoDescricoes(false);
    setLoteAprovado(false);
    setEnvios([]);
    setLog(pararRef.current
      ? `Busca de descrições interrompida com segurança: ${concluidos} de ${unicos.length} concluída(s).`
      : `Descrições concluídas: ${concluidos} atualizada(s)${falhas ? ` e ${falhas} com falha` : ''}. Revise os textos antes de aprovar.`);
  };

  const aplicarImagensSugeridas = (indiceProduto: number, urls: string[]) => {
    if (urls.length === 0) return;
    const proximos = resultados.map((produto, indice) => indice === indiceProduto
      ? {
          ...produto,
          img1: urls[0] || '',
          img2: urls[1] || '',
          img3: urls[2] || '',
          img4: urls[3] || '',
          imagensSugeridas: undefined,
          imagensSugeridasDetalhes: undefined,
          imagensExcluidas: {},
        }
      : produto);
    setResultados(proximos);
    salvarHistorico(proximos);
    setLoteAprovado(false);
    setEnvios([]);
    setAviso(`${urls.length} nova(s) imagem(ns) aplicada(s). Faça uma nova simulação antes de enviar ao Bling.`);
  };

  const iniciarProcessamento = async () => {
    const linhas = textoColado.trim().split('\n');
    if (linhas.length === 0 || linhas[0] === "") return;

    // Descobre antes de começar se existe alguma ficha que realmente precisa
    // do Gemini. Lotes que só precisam de imagens podem continuar com o Serper.
    const porCodigo = new Map<string, ProdutoResultado>(resultados.map(r => [r.codigo, r]));
    const precisaGemini = linhas.some((linha, indice) => {
      const partes = linha.split('\t');
      const codigo = partes.length > 1 ? partes[0] : `TEMP-${indice}`;
      return !temFichaCompleta(porCodigo.get(codigo));
    });
    if (precisaGemini && !apiKeyGemini) {
      alert("Insira uma chave válida do Gemini para corrigir as fichas incompletas.");
      return;
    }

    const inicioProcessamento = Date.now();
    setProcessando(true);
    setAviso('');
    pararRef.current = false;
    setProgresso({ atual: 0, total: linhas.length });

    // Mantém o que já existe e vai atualizando por código.
    let pulados = 0;
    let cotaAcabou = false;
    let chaveGeminiInvalida = false;

    for (let i = 0; i < linhas.length; i++) {
      if (pararRef.current) {
        setLog(`Interrompido em ${i} de ${linhas.length}. O que já foi feito está salvo.`);
        break;
      }

      const partes = linhas[i].split('\t');
      const codigo = partes.length > 1 ? partes[0] : `TEMP-${i}`;
      const nome = partes.length > 1 ? partes[1] : partes[0];

      // Produtos completos são pulados. Os antigos que vieram sem peso,
      // medidas ou foto voltam ao processamento e preservam o que já está pronto.
      const anterior = porCodigo.get(codigo);
      const temImagemAnterior = Boolean(anterior && [
        anterior.img1, anterior.img2, anterior.img3, anterior.img4,
      ].some(Boolean));
      const fichaAnteriorCompleta = temFichaCompleta(anterior);
      if (fichaAnteriorCompleta && temImagemAnterior) {
        pulados++;
        setProgresso({ atual: i + 1, total: linhas.length });
        continue;
      }
      const buscarSomenteImagens = fichaAnteriorCompleta && !temImagemAnterior;

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
              apiKey: buscarSomenteImagens ? '' : apiKeyGemini,
              apiKeyImg,
              sitesPreferenciais: sitesImagens
                .split(/[\n,]+/)
                .map(site => site.trim())
                .filter(Boolean),
              limiteConsultasImagens,
              // Uma ficha já correta nunca volta ao Gemini apenas porque a
              // imagem está ausente. Assim cada serviço completa só seu campo.
              somenteImagens: buscarSomenteImagens,
              referencias,
              // Qualquer imagem anterior bloqueia a busca automática e fica preservada.
              preservarImagensExistentes: temImagemAnterior,
              buscarImagens: !temImagemAnterior,
            })
          });
          dados = await res.json();
        } catch (e: any) {
          setLog(`Erro de rede em ${nome}: ${e.message}`);
          break;
        }

        if (!buscarSomenteImagens && erroDeChaveGemini(dados)) {
          chaveGeminiInvalida = true;
          setAviso(
            'A chave do Gemini foi recusada. Abra Configurações, substitua somente a chave do Gemini, ' +
            'salve e inicie o mesmo lote novamente. Produtos e imagens já corretos serão preservados.'
          );
          setLog(`Processamento interrompido no primeiro erro de credencial (${nome}). Nada pronto foi apagado.`);
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

      if (chaveGeminiInvalida) break;

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
          (['peso', 'largura', 'altura', 'profundidade'] as const)
            .some(campo => !semInformacao(anterior[campo]));

        porCodigo.set(codigo, {
          ...(anterior || {}),
          codigo,
          nome,
          curta: anterior?.curta || dados.curta || "",
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
          fonteMedidas: dados.fonteMedidas || anterior?.fonteMedidas || "",
          img1: anterior?.img1 || dados.imagens?.[0] || "",
          img2: anterior?.img2 || dados.imagens?.[1] || "",
          img3: anterior?.img3 || dados.imagens?.[2] || "",
          img4: anterior?.img4 || dados.imagens?.[3] || "",
        });

        const lista = [...porCodigo.values()];
        setResultados(lista);
        salvarHistorico(lista);
      }
      setProgresso({ atual: i + 1, total: linhas.length });

      // Respiro entre produtos para não estourar o limite por minuto da IA.
      if (i < linhas.length - 1) await espera(1500);
    }

    const lista = [...porCodigo.values()];
    const comErro = lista.filter(deuErro).length;
    const semImagem = lista.filter(r => !r.img1).length;

    if (!cotaAcabou && !chaveGeminiInvalida) {
      setLog(
        `Lote concluído: ${lista.length} produtos no total` +
        (pulados > 0 ? ` (${pulados} já estavam prontos e foram pulados)` : '') +
        `. ${comErro} com falha na descrição, ${semImagem} sem imagem.`
      );
    }

    if (!cotaAcabou && !chaveGeminiInvalida && !pararRef.current && telegram.configurado) {
      try {
        const respostaNotificacao = await fetch('/api/notificacao/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo: 'processamento_concluido',
            total: lista.length,
            prontos: lista.length - comErro,
            erros: comErro,
            semImagem,
            pulados,
            duracaoSegundos: Math.round((Date.now() - inicioProcessamento) / 1000),
          }),
        });
        if (!respostaNotificacao.ok) {
          const falha = await respostaNotificacao.json().catch(() => ({}));
          setAviso(`Produtos prontos, mas a notificação falhou — ${falha.erro || `HTTP ${respostaNotificacao.status}`}`);
        }
      } catch (erro) {
        setAviso(`Produtos prontos, mas a notificação falhou — ${erro instanceof Error ? erro.message : 'falha de rede'}`);
      }
    }

    setProcessando(false);
    if (lista.length > 0) {
      setLoteAprovado(false);
      setEtapaAtual(3);
    }
  };

  const exportarCSV = () => {
    // Ponto e vírgula para o Excel separar as colunas corretamente
    const cabecalho =
      "Código;Produto;Marca;Peso;Largura;Altura;Profundidade;Origem das medidas;Código de referência;Fonte das medidas;" +
      "Descrição Curta;Imagem 1;Imagem 2;Imagem 3;Imagem 4\n";

    const aspas = (valor: unknown) => `"${String(valor || "").replace(/"/g, '""')}"`;

    const linhasCSV = resultados.map(r => [
      r.codigo, r.nome, r.marca, r.peso, r.largura, r.altura, r.profundidade,
      r.origemMedidas, r.codigoReferencia, r.fonteMedidas,
      r.curta, r.img1, r.img2, r.img3, r.img4
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

        const urls = [res.img1, res.img2, res.img3, res.img4]
          .filter((url): url is string => Boolean(url));
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
            : res.origemMedidas === 'REAL'
              ? `fonte real: ${res.fonteMedidas}`
            : res.origemMedidas === 'COMPLEMENTADO'
              ? 'ficha anterior complementada pela IA'
              : 'estimativa da IA'}\n` +
          `OBSERVAÇÃO: ${res.justificativaMedidas || 'Confira as medidas antes de cadastrar.'}\n\n` +
          `=== DESCRIÇÃO CURTA ===\n${res.curta}\n`;

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

  const ocupado = processando || buscandoImagens || buscandoDescricoes || baixando || enviandoBling;

  const sairAplicacao = async () => {
    await fetch('/api/acesso/sair', { method: 'POST' }).catch(() => null);
    router.replace('/login');
    router.refresh();
  };

  const linhasImportadas = textoColado.trim()
    ? textoColado.trim().split('\n').filter(linha => linha.trim()).length
    : 0;
  const comErro = resultados.filter(deuErro).length;
  const semImagem = resultados.filter(produtoSemFotos).length;
  const medidasParaConferir = resultados.filter(produto =>
    !['REAL', 'REAPROVEITADO'].includes(String(produto.origemMedidas))
  ).length;

  const podeAcessarEtapa = (numero: number) => {
    if (numero === 1) return true;
    if (numero === 2) return linhasImportadas > 0 || resultados.length > 0;
    if (numero === 3 || numero === 4) return resultados.length > 0;
    if (numero === 5) return resultados.length > 0 && loteAprovado;
    return false;
  };

  const aprovarLote = () => {
    setLoteAprovado(true);
    setEnvios([]);
    setAviso(`${resultados.length} produto(s) aprovados e liberados para simulação no Bling.`);
    setEtapaAtual(5);
  };

  return (
    <main className="min-h-screen bg-[#f4f7f8] text-slate-950">
      <header className="border-b border-white/10 bg-[#071a24] text-white shadow-[0_8px_30px_rgba(7,26,36,.18)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5 md:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-400 text-lg font-black text-[#071a24] shadow-sm">
              JB
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-white md:text-xl">Catálogo JB</h1>
              <p className="text-xs text-slate-300">Operação inteligente integrada ao Bling</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {([['dashboard','Dashboard'],['fluxo','Produtos'],['categorias','Categorias'],['historico','Histórico'],['tarefas','Tarefas'],['configuracoes','Config.']] as const).map(([visao, rotulo]) => (
              <button key={visao} type="button" onClick={() => setVisaoAtual(visao)} disabled={ocupado} aria-current={visaoAtual === visao ? 'page' : undefined} className={`hidden rounded-lg px-3 py-2 text-sm font-bold transition md:block ${visaoAtual === visao ? 'bg-cyan-400 text-[#071a24]' : 'text-slate-300 hover:bg-white/10 hover:text-white'} disabled:opacity-40`}>
                {rotulo}
              </button>
            ))}
            <button
              type="button"
              onClick={sairAplicacao}
              disabled={ocupado}
              className="rounded-lg border border-white/20 bg-white/5 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Sair
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-6 md:px-8 md:py-8">
        <div className="mb-5 flex gap-2 overflow-x-auto md:hidden">
          {([['dashboard','Dashboard'],['fluxo','Produtos'],['categorias','Categorias'],['historico','Histórico'],['tarefas','Tarefas'],['configuracoes','Config.']] as const).map(([visao, rotulo]) => <button key={visao} onClick={() => setVisaoAtual(visao)} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-bold ${visaoAtual === visao ? 'bg-slate-950 text-white' : 'bg-white text-slate-600'}`}>{rotulo}</button>)}
        </div>
        {visaoAtual === 'dashboard' && (
          <DashboardView
            geminiConfigurado={Boolean(apiKeyGemini)}
            serperConfigurado={Boolean(apiKeyImg)}
          />
        )}
        {visaoAtual === 'historico' && <HistoryView aoAbrir={(produto) => {
          const indice = resultados.findIndex(item => item.codigo === produto.codigo);
          const proximos = indice >= 0 ? resultados.map((item, i) => i === indice ? { ...item, ...produto } : item) : [...resultados, produto];
          setResultados(proximos); salvarHistorico(proximos); setLoteAprovado(false); setEtapaAtual(3); setVisaoAtual('fluxo');
        }} />}
        {visaoAtual === 'tarefas' && <TasksView />}
        {visaoAtual === 'categorias' && <CategoryAdminView />}
        {visaoAtual === 'fluxo' && (
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <WorkflowStepper
              etapas={ETAPAS}
              atual={etapaAtual}
              podeAcessar={podeAcessarEtapa}
              aoSelecionar={setEtapaAtual}
            />
          </section>
        )}

        {aviso && (
          <div role="status" className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span>{aviso}</span>
            <button type="button" onClick={() => setAviso('')} aria-label="Fechar aviso" className="font-bold text-amber-700">
              ×
            </button>
          </div>
        )}

        {visaoAtual === 'configuracoes' && (
          <section>
            <div className="mb-6">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Preferências</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Configurações</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Centralize as chaves usadas no processamento e acompanhe a conexão com o Bling.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                <div className="mb-6 flex items-start justify-between gap-4 border-b border-slate-200 pb-5">
                  <div>
                    <h3 className="text-lg font-bold text-slate-950">Chaves e busca de imagens</h3>
                    <p className="mt-1 text-sm text-slate-500">Configure as APIs e os sites que devem ter prioridade.</p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">Chaves nesta sessão</span>
                </div>

                <div className="space-y-5">
                  <label className="block text-sm font-bold text-slate-800">
                    Chave da API do Gemini
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="Cole a chave do Gemini"
                      value={apiKeyGemini}
                      onChange={evento => setApiKeyGemini(evento.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="mt-2 flex items-center gap-2 text-xs font-normal text-slate-500">
                      <span className={`h-2 w-2 rounded-full ${apiKeyGemini ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      {apiKeyGemini ? 'Chave informada' : 'Ainda não informada'}
                    </span>
                  </label>

                  <label className="block text-sm font-bold text-slate-800">
                    Chave da API Serper
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="Cole a chave do serper.dev"
                      value={apiKeyImg}
                      onChange={evento => setApiKeyImg(evento.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="mt-2 flex items-center gap-2 text-xs font-normal text-slate-500">
                      <span className={`h-2 w-2 rounded-full ${apiKeyImg ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      {apiKeyImg ? 'Chave informada' : 'Ainda não informada'}
                    </span>
                  </label>

                  <label className="block text-sm font-bold text-slate-800">
                    Sites preferenciais para imagens
                    <textarea
                      value={sitesImagens}
                      onChange={evento => setSitesImagens(evento.target.value)}
                      rows={4}
                      placeholder={"madeiramadeira.com.br\nmagazineluiza.com.br"}
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 font-mono text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="mt-2 block text-xs font-normal leading-5 text-slate-500">
                      Informe um domínio por linha, na ordem desejada. Até 12 sites são aceitos; a busca geral ocupa a última consulta quando o limite for maior que 1.
                    </span>
                  </label>

                  <label className="block text-sm font-bold text-slate-800">
                    Máximo de consultas do Serper por produto
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={limiteConsultasImagens}
                      onChange={evento => setLimiteConsultasImagens(Math.min(12, Math.max(1, Number(evento.target.value) || 1)))}
                      className="mt-2 w-32 rounded-xl border border-slate-300 bg-white px-3.5 py-3 font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="mt-2 block text-xs font-normal leading-5 text-slate-500">
                      Padrão: 3. Cada consulta consome 1 crédito. Para 400 produtos, o máximo será {400 * limiteConsultasImagens} créditos.
                    </span>
                  </label>
                </div>

                <div className="mt-6 rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs leading-5 text-blue-900">
                  As chaves ficam somente nesta sessão do navegador. Os sites preferenciais permanecem
                  salvos neste navegador. Nada disso é adicionado ao GitHub ou ao banco de dados.
                </div>

                <div className="mt-6 flex flex-wrap justify-end gap-3">
                  <button type="button" onClick={cancelarConfiguracoes} disabled={ocupado} className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">
                    Cancelar
                  </button>
                  <button type="button" onClick={salvarConfiguracoes} disabled={!apiKeyGemini || ocupado} className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
                    Salvar configurações
                  </button>
                </div>
              </div>

              <aside className="h-fit space-y-6">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Integração</p>
                    <h3 className="mt-2 text-lg font-bold text-slate-950">Bling</h3>
                  </div>
                  <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                    bling.conectado
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-slate-100 text-slate-600'
                  }`}>
                    {bling.conectado ? '● Conectado' : '○ Desconectado'}
                  </span>
                </div>

                <div className="my-5 h-px bg-slate-200" />

                {!bling.configurado ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                    As credenciais BLING_CLIENT_ID e BLING_CLIENT_SECRET ainda não estão configuradas na Vercel.
                  </div>
                ) : bling.conectado ? (
                  <>
                    <p className="text-sm leading-6 text-slate-600">
                      A conta está autorizada para simular e atualizar produtos após a aprovação do lote.
                    </p>
                    <button type="button" onClick={desconectarBling} disabled={ocupado} className="mt-5 w-full rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40">
                      Desconectar do Bling
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-sm leading-6 text-slate-600">
                      Conecte sua conta para liberar a simulação e o envio na última etapa.
                    </p>
                    <a href="/api/bling/autorizar" className="mt-5 block w-full rounded-xl bg-slate-950 px-4 py-3 text-center text-sm font-bold text-white hover:bg-slate-800">
                      Conectar ao Bling
                    </a>
                  </>
                )}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Notificações</p>
                      <h3 className="mt-2 text-lg font-bold text-slate-950">Telegram</h3>
                    </div>
                    <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                      telegram.configurado
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                      {telegram.configurado ? '● Configurado' : '○ Não configurado'}
                    </span>
                  </div>
                  <div className="my-5 h-px bg-slate-200" />
                  {telegram.configurado ? (
                    <>
                      <p className="text-sm leading-6 text-slate-600">
                        O celular será avisado quando um lote terminar normalmente e estiver pronto para revisão.
                      </p>
                      <button type="button" onClick={testarTelegram} disabled={ocupado || testandoTelegram} className="mt-5 w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-bold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40">
                        {testandoTelegram ? 'Enviando teste…' : 'Enviar notificação de teste'}
                      </button>
                    </>
                  ) : (
                    <p className="text-sm leading-6 text-slate-600">
                      Cadastre <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">TELEGRAM_BOT_TOKEN</code> e <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">TELEGRAM_CHAT_ID</code> na Vercel para ativar.
                    </p>
                  )}
                </div>
              </aside>
            </div>

          </section>
        )}

        {visaoAtual === 'fluxo' && etapaAtual === 1 && (
          <section>
            <div className="mb-6">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Etapa 1 de 5</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Importe os produtos</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Cole duas colunas do Excel: código na primeira e nome do produto na segunda.
                Nenhum produto será enviado ao Bling nesta etapa.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <label className="block text-sm font-bold text-slate-800">
                  Lista de produtos
                  <textarea
                    placeholder={"16504\tENCORD UKULELE SG NAILON SOPRANO 10981\n16503\tSPEAKON FEMEA ROXTONE 4 PINOS RP-017 PRETO"}
                    value={textoColado}
                    onChange={evento => setTextoColado(evento.target.value)}
                    rows={11}
                    className="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-sm leading-6 text-slate-900 outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100"
                  />
                </label>
              </div>

              <aside className="h-fit rounded-2xl bg-slate-950 p-6 text-white shadow-sm">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-300">Resumo da importação</p>
                <p className="mt-5 text-4xl font-black">{linhasImportadas}</p>
                <p className="mt-1 text-sm text-slate-300">produtos identificados</p>
                <div className="my-5 h-px bg-slate-800" />
                <ul className="space-y-3 text-sm text-slate-300">
                  <li className="flex gap-2">
                    <span className={apiKeyGemini ? 'text-emerald-400' : 'text-amber-300'}>{apiKeyGemini ? '✓' : '!'}</span>
                    Gemini {apiKeyGemini ? 'configurado' : 'não configurado'}
                  </li>
                  <li className="flex gap-2">
                    <span className={apiKeyImg ? 'text-emerald-400' : 'text-amber-300'}>{apiKeyImg ? '✓' : '!'}</span>
                    Serper {apiKeyImg ? 'configurado' : 'não configurado'}
                  </li>
                  <li className="flex gap-2"><span className="text-emerald-400">✓</span> Histórico salvo a cada produto</li>
                  <li className="flex gap-2"><span className="text-emerald-400">✓</span> Produtos prontos não são cobrados novamente</li>
                  <li className="flex gap-2"><span className="text-emerald-400">✓</span> Imagens permanecem no padrão 420×420</li>
                </ul>
                {!apiKeyGemini && (
                  <button
                    type="button"
                    onClick={() => setVisaoAtual('configuracoes')}
                    className="mt-5 w-full rounded-xl border border-blue-400 px-4 py-3 text-sm font-bold text-blue-200 transition hover:bg-blue-950"
                  >
                    Configurar chaves
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEtapaAtual(2)}
                  disabled={!apiKeyGemini || linhasImportadas === 0}
                  className="mt-6 w-full rounded-xl bg-blue-600 px-4 py-3 font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continuar para processar
                </button>
                {!apiKeyGemini && linhasImportadas > 0 && (
                  <p className="mt-3 text-xs text-amber-300">Configure a chave do Gemini para continuar.</p>
                )}
              </aside>
            </div>

            {resultados.length > 0 && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm text-blue-900">
                  Há <strong>{resultados.length} produto(s)</strong> salvos no histórico.
                </p>
                <button type="button" onClick={() => setEtapaAtual(3)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700">
                  Abrir revisão
                </button>
              </div>
            )}
          </section>
        )}

        {visaoAtual === 'fluxo' && etapaAtual === 2 && (
          <section>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Etapa 2 de 5</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Processe o lote</h2>
                <p className="mt-2 text-sm text-slate-600">
                  A IA prepara descrições, imagens, marca, peso e dimensões de cada produto.
                </p>
              </div>
              <span className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                {linhasImportadas} itens na fila
              </span>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-slate-950">
                    {processando ? 'Processamento em andamento' : resultados.length > 0 ? 'Lote disponível' : 'Tudo pronto para começar'}
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    {processando
                      ? 'Você pode interromper sem perder os produtos concluídos.'
                      : 'Revise a quantidade e inicie quando estiver pronto.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={iniciarProcessamento}
                    disabled={ocupado || !textoColado.trim()}
                    className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {processando ? 'Processando…' : resultados.length > 0 ? 'Processar pendentes' : 'Iniciar processamento'}
                  </button>
                  {ocupado && (
                    <button
                      type="button"
                      onClick={() => { pararRef.current = true; }}
                      className="rounded-xl border border-red-300 bg-red-50 px-5 py-3 text-sm font-bold text-red-700 hover:bg-red-100"
                    >
                      Parar com segurança
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-8">
                <div className="mb-2 flex justify-between text-xs font-bold text-slate-500">
                  <span>Progresso</span>
                  <span>{progresso.atual} de {progresso.total || linhasImportadas}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{ width: progresso.total ? Math.min(100, (progresso.atual / progresso.total) * 100) + '%' : '0%' }}
                  />
                </div>
              </div>

              <div aria-live="polite" className="mt-6 min-h-20 rounded-xl bg-slate-950 p-4 font-mono text-sm leading-6 text-emerald-300">
                {log || 'Aguardando o início do processamento.'}
              </div>

              {resultados.length > 0 && !processando && (
                <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm text-emerald-900">
                    <strong>{resultados.length} produto(s)</strong> disponíveis para revisão.
                  </p>
                  <button type="button" onClick={() => setEtapaAtual(3)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700">
                    Revisar produtos
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {visaoAtual === 'fluxo' && etapaAtual === 3 && resultados.length > 0 && (
          <section>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Etapa 3 de 5</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Revise e edite</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Selecione um produto, confira imagens e ficha técnica e corrija os textos diretamente.
                </p>
              </div>
              <div className="flex gap-2">
                <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-bold text-emerald-800">{resultados.length - comErro} prontos</span>
                {comErro > 0 && <span className="rounded-full bg-red-100 px-3 py-1.5 text-xs font-bold text-red-800">{comErro} com erro</span>}
              </div>
            </div>

            {(buscandoImagens || buscandoDescricoes) && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
                <p className="text-sm font-semibold text-blue-900">{log || (buscandoDescricoes ? 'Buscando novas descrições…' : 'Buscando novas opções de imagens…')}</p>
                <button
                  type="button"
                  onClick={() => { pararRef.current = true; }}
                  className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50"
                >
                  Parar com segurança
                </button>
              </div>
            )}

            <ProductReview
              produtos={resultados}
              ocupado={ocupado}
              buscandoImagens={buscandoImagens}
              buscandoDescricoes={buscandoDescricoes}
              aoAlterar={atualizarResultado}
              aoAlterarImagem={alterarSelecaoImagem}
              aoDefinirImagem={definirImagemManual}
              aoBuscarImagens={buscarImagensNovamente}
              aoBuscarDescricoes={buscarDescricoesNovamente}
              aoAplicarSugestoes={aplicarImagensSugeridas}
              aoMarcarRevisado={marcarRevisado}
              aoRemoverDaRevisao={removerDaRevisao}
            />

            <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-end justify-between gap-5">
                <div className="flex flex-wrap items-end gap-3">
                  <button type="button" onClick={exportarCSV} disabled={ocupado} className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                    Baixar CSV
                  </button>
                  <button type="button" onClick={baixarPacote} disabled={ocupado} className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                    {baixando ? 'Montando ZIP…' : 'Baixar imagens e descrições'}
                  </button>
                  <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
                    Produtos por ZIP
                    <input
                      type="number"
                      min={1}
                      value={porZip}
                      onChange={evento => setPorZip(Number(evento.target.value))}
                      disabled={ocupado}
                      className="mt-1 block w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900"
                    />
                  </label>
                  <button type="button" onClick={limparHistorico} disabled={ocupado} className="px-3 py-2.5 text-sm font-semibold text-red-600 hover:text-red-800 disabled:opacity-40">
                    Limpar histórico
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setEtapaAtual(4)}
                  disabled={ocupado}
                  className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Continuar para aprovação
                </button>
              </div>
              {log && <p className="mt-4 rounded-lg bg-slate-950 px-4 py-3 font-mono text-xs text-emerald-300">{log}</p>}
            </div>
          </section>
        )}

        {visaoAtual === 'fluxo' && etapaAtual === 4 && resultados.length > 0 && (
          <section>
            <div className="mb-6">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Etapa 4 de 5</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Aprove o lote</h2>
              <p className="mt-2 text-sm text-slate-600">
                Esta confirmação libera a simulação e o envio. Voltar e editar qualquer produto exigirá uma nova aprovação.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-sm font-semibold text-slate-500">Total do lote</p>
                <p className="mt-3 text-3xl font-black text-slate-950">{resultados.length}</p>
                <p className="mt-1 text-xs text-slate-500">produtos processados</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-sm font-semibold text-slate-500">Descrições</p>
                <p className={"mt-3 text-3xl font-black " + (comErro ? 'text-red-600' : 'text-emerald-600')}>{comErro}</p>
                <p className="mt-1 text-xs text-slate-500">itens com erro</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-sm font-semibold text-slate-500">Imagens</p>
                <p className={"mt-3 text-3xl font-black " + (semImagem ? 'text-amber-600' : 'text-emerald-600')}>{semImagem}</p>
                <p className="mt-1 text-xs text-slate-500">itens sem imagem principal</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-sm font-semibold text-slate-500">Medidas</p>
                <p className="mt-3 text-3xl font-black text-blue-600">{medidasParaConferir}</p>
                <p className="mt-1 text-xs text-slate-500">estimadas ou complementadas</p>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
              <h3 className="text-lg font-bold text-slate-950">Confirmação antes do Bling</h3>
              <div className="mt-5 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
                <p className="flex gap-3 rounded-xl bg-slate-50 p-4"><span className="font-bold text-emerald-600">✓</span> Revisei as descrições e a marca dos produtos.</p>
                <p className="flex gap-3 rounded-xl bg-slate-50 p-4"><span className="font-bold text-emerald-600">✓</span> Conferi pesos e dimensões estimados.</p>
                <p className="flex gap-3 rounded-xl bg-slate-50 p-4"><span className="font-bold text-emerald-600">✓</span> Removi as imagens que não devem ser enviadas.</p>
                <p className="flex gap-3 rounded-xl bg-slate-50 p-4"><span className="font-bold text-emerald-600">✓</span> Entendo que ainda haverá uma simulação antes do envio real.</p>
              </div>

              {(comErro > 0 || semImagem > 0) && (
                <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  Existem {comErro} produto(s) com erro de descrição e {semImagem} sem imagem principal.
                  Você pode voltar à revisão ou aprovar o lote consciente dessas pendências.
                </div>
              )}

              <div className="mt-6 flex flex-wrap justify-end gap-3">
                <button type="button" onClick={() => setEtapaAtual(3)} className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50">
                  Voltar e revisar
                </button>
                <button type="button" onClick={aprovarLote} className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white hover:bg-emerald-700">
                  Aprovar lote e continuar
                </button>
              </div>
            </div>
          </section>
        )}

        {visaoAtual === 'fluxo' && etapaAtual === 5 && loteAprovado && (
          <section>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Etapa 5 de 5</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Envie ao Bling</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Comece pela simulação, envie um produto de teste e só depois confirme o lote completo.
                </p>
              </div>
              <span className="rounded-full bg-emerald-100 px-4 py-2 text-sm font-bold text-emerald-800">
                Lote aprovado • {resultados.length} produtos
              </span>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-6">
                <div>
                  <h3 className="text-lg font-bold text-slate-950">Conexão com o Bling</h3>
                  <p className="mt-1 text-sm text-slate-500">Os produtos são encontrados pelo código informado.</p>
                </div>
                {!bling.configurado ? (
                  <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                    Credenciais do Bling não configuradas
                  </span>
                ) : bling.conectado ? (
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-sm font-bold text-emerald-800">● Conectado</span>
                    <button type="button" onClick={desconectarBling} className="text-sm font-semibold text-slate-500 hover:text-red-600">Desconectar</button>
                  </div>
                ) : (
                  <a href="/api/bling/autorizar" className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-bold text-white hover:bg-slate-800">
                    Conectar ao Bling
                  </a>
                )}
              </div>

              {bling.conectado && (
                <>
                  <div className="mt-6 grid gap-4 md:grid-cols-3">
                    <button
                      type="button"
                      onClick={() => mandarParaBling(resultados.slice(0, 1), true)}
                      disabled={ocupado}
                      className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-left hover:border-blue-400 disabled:opacity-40"
                    >
                      <span className="block text-xs font-bold uppercase tracking-wide text-blue-600">Passo 1</span>
                      <span className="mt-2 block font-bold text-slate-950">Simular o primeiro</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">Mostra o que seria alterado sem gravar nada.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => mandarParaBling(resultados.slice(0, 1), false)}
                      disabled={ocupado}
                      className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-left hover:border-amber-400 disabled:opacity-40"
                    >
                      <span className="block text-xs font-bold uppercase tracking-wide text-amber-700">Passo 2</span>
                      <span className="mt-2 block font-bold text-slate-950">Enviar um produto</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">Faça a conferência final diretamente no Bling.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm('Isso vai alterar ' + resultados.length + ' produtos no seu Bling de verdade. Confirma?')) {
                          mandarParaBling(resultados, false);
                        }
                      }}
                      disabled={ocupado}
                      className="rounded-xl border border-red-200 bg-red-50 p-5 text-left hover:border-red-400 disabled:opacity-40"
                    >
                      <span className="block text-xs font-bold uppercase tracking-wide text-red-700">Passo 3</span>
                      <span className="mt-2 block font-bold text-slate-950">Enviar todos ({resultados.length})</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">Executa o envio real do lote aprovado.</span>
                    </button>
                  </div>

                  <div className="mt-6 flex flex-wrap items-end gap-5 rounded-xl bg-slate-50 p-4">
                    <label className="flex items-center gap-3 text-sm font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={sobrescrever}
                        onChange={evento => setSobrescrever(evento.target.checked)}
                        disabled={ocupado}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Sobrescrever campos já preenchidos no Bling
                    </label>
                    <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      Unidade para novas dimensões
                      <select
                        value={unidadeMedida}
                        onChange={evento => setUnidadeMedida(Number(evento.target.value))}
                        disabled={ocupado}
                        className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900"
                      >
                        <option value={0}>Metros</option>
                        <option value={1}>Centímetros</option>
                        <option value={2}>Milímetros</option>
                      </select>
                    </label>
                    {ocupado && (
                      <button type="button" onClick={() => { pararRef.current = true; }} className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-bold text-red-700">
                        Interromper
                      </button>
                    )}
                  </div>
                </>
              )}

              <div aria-live="polite" className="mt-6 min-h-16 rounded-xl bg-slate-950 p-4 font-mono text-sm leading-6 text-emerald-300">
                {log || 'Aguardando a simulação do primeiro produto.'}
              </div>
            </div>

            {envios.length > 0 && (
              <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="font-bold text-slate-950">Resultado da operação</h3>
                <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
                  {envios.map((envio, indice) => (
                    <div key={envio.codigo + '-' + indice} className="rounded-xl border border-slate-200 p-4 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-bold text-slate-950">{envio.codigo}</span>
                        <span className={"rounded-full px-2.5 py-1 text-xs font-bold " + (
                          envio.erro
                            ? 'bg-red-100 text-red-700'
                            : envio.simulado
                              ? 'bg-blue-100 text-blue-700'
                              : envio.enviado
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-slate-100 text-slate-600'
                        )}>
                          {envio.erro ? 'Falhou' : envio.simulado ? 'Simulado' : envio.enviado ? 'Atualizado' : 'Sem alteração'}
                        </span>
                      </div>
                      {envio.erro && <p className="mt-2 text-xs text-red-600">{envio.erro}</p>}
                      {envio.aviso && <p className="mt-2 text-xs text-slate-600">{envio.aviso}</p>}
                      {envio.alterados && envio.alterados.length > 0 && <p className="mt-2 text-xs text-slate-700">Alterar: {envio.alterados.join(', ')}</p>}
                      {envio.ignorados && envio.ignorados.length > 0 && <p className="mt-2 text-xs text-amber-700">Não alterado: {envio.ignorados.join('; ')}</p>}
                      {envio.avisosBling && envio.avisosBling.length > 0 && <p className="mt-2 text-xs text-amber-700">Bling: {envio.avisosBling.join('; ')}</p>}
                      {envio.simulado && typeof envio.corpo?.descricaoComplementar === 'string' && (
                        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                          <strong>Descrição complementar no Bling:</strong>{' '}
                          {envio.corpo.descricaoComplementar}
                        </div>
                      )}
                      {envio.corpo && (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs font-semibold text-blue-600">Ver dados da simulação</summary>
                          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 text-[11px] text-slate-800">
                            {JSON.stringify(envio.corpo, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
