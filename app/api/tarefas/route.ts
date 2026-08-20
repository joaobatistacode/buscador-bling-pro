import { randomUUID } from 'node:crypto';
import { lerCorpoLimitado, naoAutorizado, origemInvalida, origemPermitida, temAcesso } from '@/lib/acesso';
import { supabaseRest, textoSeguro } from '@/lib/supabase-admin';

const colunas = 'id,titulo,descricao,status,prioridade,codigo_produto,prazo,created_at,updated_at,completed_at';
const statusValidos = new Set(['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA']);
const prioridades = new Set(['BAIXA', 'MEDIA', 'ALTA']);

export async function GET() {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    return Response.json({ tarefas: await supabaseRest(`bling_tarefas?select=${colunas}&order=created_at.desc&limit=500`, { method: 'GET' }) });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao listar tarefas.' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const corpo = await lerCorpoLimitado(request, 24 * 1024);
    const d = JSON.parse(new TextDecoder().decode(corpo));
    const titulo = textoSeguro(d?.titulo, 180);
    if (!titulo) return Response.json({ erro: 'Informe o título da tarefa.' }, { status: 400 });
    const [tarefa] = await supabaseRest(`bling_tarefas?select=${colunas}`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), titulo, descricao: textoSeguro(d?.descricao, 1200) || null, prioridade: prioridades.has(d?.prioridade) ? d.prioridade : 'MEDIA', status: 'PENDENTE', codigo_produto: textoSeguro(d?.codigoProduto, 80) || null, prazo: d?.prazo || null }) });
    return Response.json({ tarefa });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao criar tarefa.' }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  if (!(await temAcesso())) return naoAutorizado();
  if (!origemPermitida(request)) return origemInvalida();
  try {
    const corpo = await lerCorpoLimitado(request, 24 * 1024);
    const d = JSON.parse(new TextDecoder().decode(corpo));
    const id = textoSeguro(d?.id, 80);
    if (!id) return Response.json({ erro: 'Tarefa inválida.' }, { status: 400 });
    const mudancas: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (d.titulo !== undefined) mudancas.titulo = textoSeguro(d.titulo, 180);
    if (statusValidos.has(d.status)) { mudancas.status = d.status; mudancas.completed_at = d.status === 'CONCLUIDA' ? new Date().toISOString() : null; }
    if (prioridades.has(d.prioridade)) mudancas.prioridade = d.prioridade;
    const [tarefa] = await supabaseRest(`bling_tarefas?id=eq.${encodeURIComponent(id)}&select=${colunas}`, { method: 'PATCH', body: JSON.stringify(mudancas) });
    return Response.json({ tarefa });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha ao atualizar tarefa.' }, { status: 502 });
  }
}
