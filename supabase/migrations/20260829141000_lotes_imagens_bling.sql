create table if not exists public.bling_imagens_lotes (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'PRONTO'
    check (status in ('PRONTO', 'EM_ANDAMENTO', 'PAUSADO', 'FINALIZADO', 'REVISAO', 'CANCELADO')),
  total integer not null default 0 check (total between 0 and 500),
  pendentes integer not null default 0 check (pendentes >= 0),
  processando integer not null default 0 check (processando >= 0),
  concluidos integer not null default 0 check (concluidos >= 0),
  ignorados integer not null default 0 check (ignorados >= 0),
  falhas integer not null default 0 check (falhas >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluido_em timestamptz
);

create table if not exists public.bling_imagens_lote_itens (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null references public.bling_imagens_lotes(id) on delete cascade,
  posicao integer not null check (posicao > 0 and posicao <= 500),
  id_produto_bling bigint not null,
  codigo text not null,
  produto text not null,
  status text not null default 'PENDENTE'
    check (status in ('PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'IGNORADO', 'FALHA', 'REVISAO')),
  etapa text not null default 'AGUARDANDO',
  urls_marketplace jsonb not null default '[]'::jsonb,
  motivo text,
  tentativas integer not null default 0 check (tentativas >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluido_em timestamptz,
  unique (lote_id, id_produto_bling)
);

create index if not exists bling_imagens_lotes_status_idx
  on public.bling_imagens_lotes (status, created_at desc);
create index if not exists bling_imagens_lote_itens_fila_idx
  on public.bling_imagens_lote_itens (lote_id, status, posicao);

alter table public.bling_imagens_lotes enable row level security;
alter table public.bling_imagens_lote_itens enable row level security;

revoke all on table public.bling_imagens_lotes from public, anon, authenticated;
revoke all on table public.bling_imagens_lote_itens from public, anon, authenticated;
grant select, insert, update on table public.bling_imagens_lotes to service_role;
grant select, insert, update on table public.bling_imagens_lote_itens to service_role;

comment on table public.bling_imagens_lotes is
  'Lotes privados e retomaveis para conversao e reposicao segura de imagens no Bling.';
comment on table public.bling_imagens_lote_itens is
  'Fila privada de produtos de um lote de imagens, processada sequencialmente.';
