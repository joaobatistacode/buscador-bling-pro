import {
  lerCorpoLimitado,
  naoAutorizado,
  origemInvalida,
  origemPermitida,
  temAcesso,
} from '@/lib/acesso';

const TOKEN_VALIDO = /^\d+:[A-Za-z0-9_-]{20,}$/;
const CHAT_VALIDO = /^-?\d+$/;

function configuracao() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  return {
    token,
    chatId,
    configurado: TOKEN_VALIDO.test(token) && CHAT_VALIDO.test(chatId),
  };
}

const numeroSeguro = (valor: unknown, maximo = 100_000) => {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.min(maximo, Math.max(0, Math.trunc(numero))) : 0;
};

function duracaoLegivel(segundosRecebidos: unknown) {
  const segundos = numeroSeguro(segundosRecebidos, 7 * 24 * 60 * 60);
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const restante = segundos % 60;
  return [horas ? `${horas}h` : '', minutos ? `${minutos}min` : '', `${restante}s`]
    .filter(Boolean)
    .join(' ');
}

async function enviarMensagem(texto: string) {
  const { token, chatId, configurado } = configuracao();
  if (!configurado) return { ok: false, status: 503, erro: 'Telegram ainda não configurado na Vercel.' };

  try {
    const resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const dados = await resposta.json().catch(() => null);
    if (!resposta.ok || dados?.ok !== true) {
      return {
        ok: false,
        status: resposta.status || 502,
        erro: String(dados?.description || `Telegram respondeu HTTP ${resposta.status}`).slice(0, 240),
      };
    }
    return { ok: true, status: 200 };
  } catch (erro) {
    return {
      ok: false,
      status: 502,
      erro: erro instanceof Error ? `Falha ao acessar o Telegram: ${erro.message}` : 'Falha ao acessar o Telegram.',
    };
  }
}

export async function GET() {
  if (!(await temAcesso())) return naoAutorizado();
  return Response.json({ configurado: configuracao().configurado });
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();

  let corpo: Uint8Array<ArrayBuffer>;
  try {
    corpo = await lerCorpoLimitado(request, 8 * 1024);
  } catch {
    return Response.json({ erro: 'Requisição muito grande.' }, { status: 413 });
  }

  let dados: Record<string, unknown>;
  try {
    const recebido = JSON.parse(new TextDecoder().decode(corpo));
    dados = recebido && typeof recebido === 'object' ? recebido : {};
  } catch {
    return Response.json({ erro: 'JSON inválido.' }, { status: 400 });
  }

  let texto: string;
  if (dados.tipo === 'teste') {
    texto = [
      '✅ <b>Enriquecedor Bling PRO conectado</b>',
      '',
      'As notificações de conclusão chegarão neste celular.',
    ].join('\n');
  } else if (dados.tipo === 'processamento_concluido') {
    const total = numeroSeguro(dados.total);
    const prontos = numeroSeguro(dados.prontos, total);
    const erros = numeroSeguro(dados.erros, total);
    const semImagem = numeroSeguro(dados.semImagem, total);
    const pulados = numeroSeguro(dados.pulados, total);
    texto = [
      '✅ <b>Processamento concluído</b>',
      '',
      `📦 ${total} produto(s) no lote`,
      `🟢 ${prontos} pronto(s) para revisão`,
      `⚠️ ${erros} com erro de descrição`,
      `🖼️ ${semImagem} sem imagem principal`,
      pulados ? `⏭️ ${pulados} já estavam prontos` : '',
      `⏱️ Tempo: ${duracaoLegivel(dados.duracaoSegundos)}`,
      '',
      'Abra o Enriquecedor Bling PRO para revisar.',
    ].filter(Boolean).join('\n');
  } else if (['envio_concluido', 'envio_com_alertas', 'envio_interrompido'].includes(String(dados.tipo))) {
    const total = numeroSeguro(dados.total);
    const processados = numeroSeguro(dados.processados, total);
    const enviados = numeroSeguro(dados.enviados, total);
    const erros = numeroSeguro(dados.erros, total);
    const codigos = Array.isArray(dados.codigosErro)
      ? dados.codigosErro.map(item => String(item).slice(0, 40)).slice(0, 8)
      : [];
    const interrompido = dados.tipo === 'envio_interrompido';
    const alertas = dados.tipo === 'envio_com_alertas';
    texto = [
      interrompido ? '⏸️ <b>Envio ao Bling interrompido</b>' : alertas ? '⚠️ <b>Envio ao Bling terminou com alertas</b>' : '✅ <b>Envio ao Bling concluído</b>',
      '',
      `📦 ${total} produto(s) no lote`,
      `🔎 ${processados} processado(s)`,
      `🟢 ${enviados} atualizado(s) no Bling`,
      `🔴 ${erros} com erro`,
      codigos.length ? `Códigos com falha: ${codigos.join(', ')}` : '',
      `⏱️ Tempo: ${duracaoLegivel(dados.duracaoSegundos)}`,
      '',
      interrompido ? 'O progresso foi preservado. Abra o sistema para continuar.' : alertas ? 'Abra o sistema para revisar as falhas.' : 'O lote foi finalizado com sucesso.',
    ].filter(Boolean).join('\n');
  } else {
    return Response.json({ erro: 'Tipo de notificação inválido.' }, { status: 400 });
  }

  const resultado = await enviarMensagem(texto);
  if (!resultado.ok) {
    return Response.json({ erro: resultado.erro }, { status: resultado.status });
  }
  return Response.json({ enviado: true });
}
