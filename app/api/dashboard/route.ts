import { naoAutorizado, temAcesso } from '@/lib/acesso';
import { supabaseRest } from '@/lib/supabase-admin';

export async function GET() {
  if (!(await temAcesso())) return naoAutorizado();
  try {
    const [produtos, tarefas] = await Promise.all([
      supabaseRest('bling_produtos?select=status,origem_medidas,revisado,enviado_em,created_at&limit=10000', { method: 'GET' }),
      supabaseRest('bling_tarefas?select=status,prioridade&limit=2000', { method: 'GET' }),
    ]);
    const linhasProdutos = produtos as Array<{ status?: string; revisado?: boolean; origem_medidas?: string }>;
    const linhasTarefas = tarefas as Array<{ status?: string }>;
    const total = linhasProdutos.length;
    const enviados = linhasProdutos.filter(p => p.status === 'ENVIADO').length;
    const revisados = linhasProdutos.filter(p => p.revisado).length;
    const reais = linhasProdutos.filter(p => p.origem_medidas === 'REAL').length;
    const pendentes = linhasTarefas.filter(t => t.status !== 'CONCLUIDA').length;
    return Response.json({ total, enviados, revisados, aguardandoRevisao: Math.max(0, total - revisados), reais, estimados: total - reais, tarefasPendentes: pendentes, tarefasConcluidas: linhasTarefas.length - pendentes });
  } catch (erro) {
    return Response.json({ erro: erro instanceof Error ? erro.message : 'Falha no dashboard.' }, { status: 502 });
  }
}
