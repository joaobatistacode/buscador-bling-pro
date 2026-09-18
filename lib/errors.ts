export function mensagemErro(erro: unknown, fallback = 'Erro desconhecido.'): string {
  return erro instanceof Error && erro.message ? erro.message : fallback;
}
