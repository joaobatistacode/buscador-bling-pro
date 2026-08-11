const escaparHtml = (texto: string) => texto
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const montarParagrafos = (linhas: string[]) => {
  const paragrafos: string[] = [];
  let atual: string[] = [];

  const concluir = () => {
    if (atual.length === 0) return;
    paragrafos.push(`<p>${escaparHtml(atual.join(' '))}</p>`);
    atual = [];
  };

  for (const linha of linhas) {
    if (!linha) concluir();
    else atual.push(linha);
  }
  concluir();

  return paragrafos;
};

const formatarEspecificacao = (linha: string) => {
  const limpa = linha.replace(/^[-•]\s*/, '').trim();
  const separador = limpa.indexOf(':');
  if (separador <= 0) return escaparHtml(limpa);

  const rotulo = escaparHtml(limpa.slice(0, separador + 1).trim());
  const valor = escaparHtml(limpa.slice(separador + 1).trim());
  return `<strong>${rotulo}</strong>${valor ? ` ${valor}` : ''}`;
};

/**
 * Converte o texto puro editado no sistema para a marcação simples aceita
 * pelo editor rico do Bling. O conteúdo é sempre escapado antes de receber
 * as tags controladas por esta função.
 */
export function formatarDescricaoComplementarBling(valor: unknown): string {
  const texto = String(valor ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!texto) return '';

  const linhas = texto.split('\n').map(linha => linha.trim());
  const indiceEspecificacoes = linhas.findIndex(linha =>
    /^ESPECIFICA(?:Ç|C)(?:ÃO|O|ÕES|OES)\s+T[ÉE]CNICAS?\s*:?$/i.test(linha)
  );

  const linhasDescritivas = indiceEspecificacoes >= 0
    ? linhas.slice(0, indiceEspecificacoes)
    : linhas;
  const partes = montarParagrafos(linhasDescritivas);

  if (indiceEspecificacoes >= 0) {
    const itens = linhas
      .slice(indiceEspecificacoes + 1)
      .filter(Boolean)
      .map(linha => `<li>${formatarEspecificacao(linha)}</li>`);

    partes.push('<p><strong>ESPECIFICAÇÕES TÉCNICAS:</strong></p>');
    if (itens.length > 0) partes.push(`<ul>${itens.join('')}</ul>`);
  }

  return partes.join('\n');
}
