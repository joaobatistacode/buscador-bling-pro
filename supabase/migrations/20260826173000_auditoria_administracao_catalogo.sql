create table if not exists public.bling_catalogo_operacoes (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ALTERAR_PRODUTO', 'CRIAR_CAMPO')),
  status text not null default 'PENDENTE' check (status in ('PENDENTE', 'SUCESSO', 'FALHA', 'REVISAO')),
  id_produto_bling bigint,
  codigo text,
  antes jsonb,
  solicitado jsonb not null,
  detalhe text,
  created_at timestamptz not null default now(),
  concluido_em timestamptz
);

create index if not exists bling_catalogo_operacoes_created_at_idx
  on public.bling_catalogo_operacoes (created_at desc);

create index if not exists bling_catalogo_operacoes_codigo_idx
  on public.bling_catalogo_operacoes (codigo)
  where codigo is not null;

alter table public.bling_catalogo_operacoes enable row level security;

revoke all on table public.bling_catalogo_operacoes from public, anon, authenticated;
grant select, insert, update on table public.bling_catalogo_operacoes to service_role;

comment on table public.bling_catalogo_operacoes is
  'Auditoria privada das alteracoes de categoria/campos customizados executadas pelo servidor.';
