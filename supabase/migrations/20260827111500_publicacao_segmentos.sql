create table if not exists public.bling_publicacao_segmentos (
  id uuid primary key default gen_random_uuid(),
  id_segmento_bling bigint not null,
  segmento text not null,
  id_loja_bling bigint not null,
  loja text not null,
  status text not null default 'SIMULADO'
    check (status in ('SIMULADO', 'EM_ANDAMENTO', 'PAUSADO', 'FINALIZADO', 'CANCELADO', 'REVISAO')),
  total integer not null default 0 check (total >= 0),
  pendentes integer not null default 0 check (pendentes >= 0),
  corretos integer not null default 0 check (corretos >= 0),
  bloqueados integer not null default 0 check (bloqueados >= 0),
  concluidos integer not null default 0 check (concluidos >= 0),
  falhas integer not null default 0 check (falhas >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluido_em timestamptz
);

create table if not exists public.bling_publicacao_segmento_itens (
  id uuid primary key default gen_random_uuid(),
  execucao_id uuid not null references public.bling_publicacao_segmentos(id) on delete cascade,
  posicao integer not null check (posicao > 0),
  id_produto_bling bigint not null,
  codigo text not null,
  produto text not null,
  id_categoria_produto bigint,
  categoria text,
  id_vinculo_loja bigint,
  acao text not null check (acao in ('CRIAR', 'ATUALIZAR', 'IGNORAR', 'BLOQUEAR')),
  status text not null check (status in ('PENDENTE', 'PROCESSANDO', 'CORRETO', 'BLOQUEADO', 'CONCLUIDO', 'FALHA', 'REVISAO')),
  motivo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (execucao_id, id_produto_bling)
);

create index if not exists bling_publicacao_segmentos_loja_status_idx
  on public.bling_publicacao_segmentos (id_loja_bling, status, created_at desc);

create index if not exists bling_publicacao_segmento_itens_fila_idx
  on public.bling_publicacao_segmento_itens (execucao_id, status, posicao);

alter table public.bling_publicacao_segmentos enable row level security;
alter table public.bling_publicacao_segmento_itens enable row level security;

revoke all on table public.bling_publicacao_segmentos from public, anon, authenticated;
revoke all on table public.bling_publicacao_segmento_itens from public, anon, authenticated;
grant select, insert, update on table public.bling_publicacao_segmentos to service_role;
grant select, insert, update on table public.bling_publicacao_segmento_itens to service_role;

alter table public.bling_catalogo_operacoes
  drop constraint if exists bling_catalogo_operacoes_tipo_check;
alter table public.bling_catalogo_operacoes
  add constraint bling_catalogo_operacoes_tipo_check
  check (tipo in ('ALTERAR_PRODUTO', 'CRIAR_CAMPO', 'VINCULAR_LOJA'));

comment on table public.bling_publicacao_segmentos is
  'Execucoes privadas e retomaveis de vinculacao de produtos a lojas, separadas por segmento.';
comment on table public.bling_publicacao_segmento_itens is
  'Fila auditavel de produtos de uma simulacao de publicacao por segmento.';
