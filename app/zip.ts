// Gerador de ZIP mínimo, sem biblioteca externa (evita mexer no package.json).
// Grava os arquivos sem compressão ("stored"), o que é irrelevante aqui porque
// JPEG já vem comprimido. Pastas nascem sozinhas a partir da "/" no caminho.

const tabelaCRC = (() => {
  const tabela = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabela[i] = c >>> 0;
  }
  return tabela;
})();

function crc32(dados: Uint8Array<ArrayBuffer>): number {
  let c = 0xffffffff;
  for (let i = 0; i < dados.length; i++) {
    c = tabelaCRC[(c ^ dados[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ArquivoZip {
  caminho: string;
  dados: Uint8Array<ArrayBuffer>;
}

export function montarZip(arquivos: ArquivoZip[]): Blob {
  const codificador = new TextEncoder();
  const partes: Uint8Array<ArrayBuffer>[] = [];
  const registrosCentrais: Uint8Array<ArrayBuffer>[] = [];

  let deslocamento = 0;

  for (const arquivo of arquivos) {
    const nome = codificador.encode(arquivo.caminho);
    const crc = crc32(arquivo.dados);
    const tamanho = arquivo.dados.length;

    // Cabeçalho local do arquivo
    const cabecalho = new Uint8Array(30 + nome.length);
    const v = new DataView(cabecalho.buffer);
    v.setUint32(0, 0x04034b50, true);  // assinatura
    v.setUint16(4, 20, true);          // versão necessária
    v.setUint16(6, 0x0800, true);      // flag: nome em UTF-8
    v.setUint16(8, 0, true);           // método: sem compressão
    v.setUint16(10, 0, true);          // hora
    v.setUint16(12, 0x21, true);       // data (1980-01-01, válida)
    v.setUint32(14, crc, true);
    v.setUint32(18, tamanho, true);    // tamanho comprimido
    v.setUint32(22, tamanho, true);    // tamanho original
    v.setUint16(26, nome.length, true);
    v.setUint16(28, 0, true);          // sem campo extra
    cabecalho.set(nome, 30);

    partes.push(cabecalho, arquivo.dados);

    // Registro correspondente no diretório central
    const central = new Uint8Array(46 + nome.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);  // assinatura
    c.setUint16(4, 20, true);          // versão de origem
    c.setUint16(6, 20, true);          // versão necessária
    c.setUint16(8, 0x0800, true);      // flag: nome em UTF-8
    c.setUint16(10, 0, true);          // método
    c.setUint16(12, 0, true);          // hora
    c.setUint16(14, 0x21, true);       // data
    c.setUint32(16, crc, true);
    c.setUint32(20, tamanho, true);
    c.setUint32(24, tamanho, true);
    c.setUint16(28, nome.length, true);
    c.setUint16(30, 0, true);          // extra
    c.setUint16(32, 0, true);          // comentário
    c.setUint16(34, 0, true);          // disco
    c.setUint16(36, 0, true);          // atributos internos
    c.setUint32(38, 0, true);          // atributos externos
    c.setUint32(42, deslocamento, true);
    central.set(nome, 46);

    registrosCentrais.push(central);
    deslocamento += cabecalho.length + tamanho;
  }

  const tamanhoCentral = registrosCentrais.reduce((soma, r) => soma + r.length, 0);

  // Fecho do diretório central
  const fecho = new Uint8Array(22);
  const f = new DataView(fecho.buffer);
  f.setUint32(0, 0x06054b50, true);            // assinatura
  f.setUint16(4, 0, true);                     // número do disco
  f.setUint16(6, 0, true);                     // disco do diretório central
  f.setUint16(8, arquivos.length, true);       // entradas neste disco
  f.setUint16(10, arquivos.length, true);      // total de entradas
  f.setUint32(12, tamanhoCentral, true);
  f.setUint32(16, deslocamento, true);
  f.setUint16(20, 0, true);                    // comentário

  return new Blob([...partes, ...registrosCentrais, fecho], { type: 'application/zip' });
}
