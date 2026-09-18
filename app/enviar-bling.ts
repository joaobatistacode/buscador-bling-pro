// Lado do navegador da integração com o Bling: sobe as imagens tratadas para
// o Supabase (o Bling só aceita imagem por link) e chama a nossa rota de envio.

import type { ProdutoResultado } from './produtos';
import { mensagemErro } from '@/lib/errors';

export interface ResultadoEnvio {
  codigo: string;
  enviado: boolean;
  simulado?: boolean;
  alterados?: string[];
  ignorados?: string[];
  avisosBling?: string[];
  aviso?: string;
  erro?: string;
  corpo?: Record<string, unknown>;
}

export interface OpcoesEnvio {
  simular: boolean;
  sobrescrever: boolean;
  unidadeMedida: number;
  // Recebe cada imagem já enquadrada em 420x420, pronta para subir.
  enquadrar: (url: string) => Promise<{ blob: Blob | null; erro?: string }>;
  aoAndar?: (mensagem: string) => void;
}

const nomeSeguro = (texto: string) =>
  texto.replace(/[^a-zA-Z0-9._-]/g, '-') || 'sem-codigo';

// Sobe as imagens do produto e devolve as URLs públicas do Supabase.
async function subirImagens(
  produto: ProdutoResultado,
  opcoes: OpcoesEnvio
): Promise<{ urls: string[]; falhas: string[] }> {
  const origens = [produto.img1, produto.img2, produto.img3, produto.img4]
    .filter((url): url is string => Boolean(url));
  const urls: string[] = [];
  const falhas: string[] = [];
  const codigo = nomeSeguro(String(produto.codigo));

  for (let i = 0; i < origens.length; i++) {
    opcoes.aoAndar?.(`${produto.codigo}: preparando imagem ${i + 1} de ${origens.length}`);

    const { blob, erro } = await opcoes.enquadrar(origens[i]);
    if (!blob) {
      falhas.push(`imagem ${i + 1}: ${erro}`);
      continue;
    }

    const caminho = `${codigo}/${codigo}_${i + 1}.jpg`;

    try {
      const res = await fetch(`/api/upload?caminho=${encodeURIComponent(caminho)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });

      const dados = await res.json();
      if (!res.ok || !dados.url) {
        falhas.push(`imagem ${i + 1}: ${dados.erro || `HTTP ${res.status}`}`);
        continue;
      }

      urls.push(dados.url);
    } catch (erro: unknown) {
      falhas.push(`imagem ${i + 1}: ${mensagemErro(erro)}`);
    }
  }

  return { urls, falhas };
}

export async function enviarProduto(
  produto: ProdutoResultado,
  opcoes: OpcoesEnvio
): Promise<ResultadoEnvio> {
  // As imagens só sobem de verdade quando não é simulação, para não encher
  // o storage com arquivos de um envio que o usuário só quis conferir.
  let imagens: string[] = [];
  let falhasImagem: string[] = [];

  if (!opcoes.simular) {
    const subida = await subirImagens(produto, opcoes);
    imagens = subida.urls;
    falhasImagem = subida.falhas;
  }

  opcoes.aoAndar?.(`${produto.codigo}: ${opcoes.simular ? 'simulando' : 'enviando'} ao Bling`);

  try {
    const res = await fetch('/api/bling/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codigo: produto.codigo,
        curta: produto.curta,
        marca: produto.marca,
        peso: produto.peso,
        largura: produto.largura,
        altura: produto.altura,
        profundidade: produto.profundidade,
        imagens,
        simular: opcoes.simular,
        sobrescrever: opcoes.sobrescrever,
        unidadeMedida: opcoes.unidadeMedida,
      }),
    });

    const dados = await res.json() as Record<string, unknown>;

    const ignoradosResposta = Array.isArray(dados.ignorados)
      ? dados.ignorados.map(String)
      : [];
    const ignorados = [...ignoradosResposta, ...falhasImagem];

    return {
      codigo: produto.codigo,
      enviado: !!dados.enviado,
      simulado: dados.simulado === true,
      alterados: Array.isArray(dados.alterados) ? dados.alterados.map(String) : undefined,
      ignorados,
      avisosBling: Array.isArray(dados.avisosBling) ? dados.avisosBling.map(String) : undefined,
      aviso: typeof dados.aviso === 'string' ? dados.aviso : undefined,
      erro: typeof dados.erro === 'string' ? dados.erro : undefined,
      corpo: dados.corpo && typeof dados.corpo === 'object' && !Array.isArray(dados.corpo)
        ? dados.corpo as Record<string, unknown>
        : undefined,
    };
  } catch (erro: unknown) {
    return { codigo: produto.codigo, enviado: false, erro: `falha de rede: ${mensagemErro(erro)}` };
  }
}
