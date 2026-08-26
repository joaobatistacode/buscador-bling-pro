export const CAMPOS_IMAGEM = ['img1', 'img2', 'img3', 'img4'] as const;

export type CampoImagem = (typeof CAMPOS_IMAGEM)[number];

export interface ImagemSugerida {
  url: string;
  paginaOrigem: string;
  largura: number | null;
  altura: number | null;
  origem: 'GALERIA' | 'SERPER';
  metodo: 'ZOOM' | 'SRCSET' | 'JSON_LD' | 'META' | 'HTML' | 'SERPER';
  qualidade: 'ALTA' | 'BOA';
}

export interface ProdutoResultado {
  codigo: string;
  nome: string;
  curta: string;
  marca: string;
  peso: string;
  largura: string;
  altura: string;
  profundidade: string;
  origemMedidas?: 'REAL' | 'ESTIMADO' | 'REAPROVEITADO' | 'COMPLEMENTADO' | string;
  codigoReferencia?: string;
  justificativaMedidas?: string;
  fonteMedidas?: string;
  revisado?: boolean;
  enviadoBling?: boolean;
  enviadoEm?: string;
  img1?: string;
  img2?: string;
  img3?: string;
  img4?: string;
  imagensSugeridas?: string[];
  imagensSugeridasDetalhes?: ImagemSugerida[];
  imagensExcluidas?: Partial<Record<CampoImagem, string>>;
}

const CAMPOS_COM_DIAGNOSTICO: (keyof ProdutoResultado)[] = [
  'curta', 'marca', 'peso', 'largura', 'altura', 'profundidade',
  'justificativaMedidas', 'fonteMedidas',
];

export const produtoSemFotos = (produto: ProdutoResultado) =>
  CAMPOS_IMAGEM.every(campo => !String(produto[campo] || '').trim());

export const produtoComErro = (produto: ProdutoResultado) =>
  CAMPOS_COM_DIAGNOSTICO.some(campo => {
    const valor = String(produto[campo] || '').trim().toUpperCase();
    return /^(ERRO|FALHA)\b/.test(valor) ||
      valor.includes('ERRO IA:') ||
      valor.includes('API KEY NOT VALID') ||
      valor.includes('API_KEY_INVALID');
  });
