export const CAMPOS_IMAGEM = ['img1', 'img2', 'img3', 'img4'] as const;

export type CampoImagem = (typeof CAMPOS_IMAGEM)[number];

export interface ProdutoResultado {
  codigo: string;
  nome: string;
  curta: string;
  longa: string;
  marca: string;
  peso: string;
  largura: string;
  altura: string;
  profundidade: string;
  origemMedidas?: 'ESTIMADO' | 'REAPROVEITADO' | 'COMPLEMENTADO' | string;
  codigoReferencia?: string;
  justificativaMedidas?: string;
  img1?: string;
  img2?: string;
  img3?: string;
  img4?: string;
  imagensSugeridas?: string[];
  imagensExcluidas?: Partial<Record<CampoImagem, string>>;
}
