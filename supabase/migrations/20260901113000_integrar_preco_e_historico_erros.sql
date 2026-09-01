alter table public.bling_imagens_lotes
  add column if not exists atualizar_preco_promocional boolean not null default false,
  add column if not exists preco_teste_confirmado boolean not null default false,
  add column if not exists id_loja_bling bigint,
  add column if not exists loja text,
  add column if not exists precos_pendentes integer not null default 0 check (precos_pendentes >= 0),
  add column if not exists precos_processando integer not null default 0 check (precos_processando >= 0),
  add column if not exists precos_concluidos integer not null default 0 check (precos_concluidos >= 0),
  add column if not exists precos_prontos integer not null default 0 check (precos_prontos >= 0),
  add column if not exists precos_falhas integer not null default 0 check (precos_falhas >= 0);

alter table public.bling_imagens_lote_itens
  add column if not exists preco_status text not null default 'DESATIVADO'
    check (preco_status in ('DESATIVADO', 'PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'PRONTO', 'REVISAO')),
  add column if not exists preco numeric(18, 6),
  add column if not exists preco_promocional_antes numeric(18, 6),
  add column if not exists preco_promocional_depois numeric(18, 6),
  add column if not exists preco_motivo text,
  add column if not exists preco_tentativas integer not null default 0 check (preco_tentativas >= 0),
  add column if not exists preco_concluido_em timestamptz;

alter table public.bling_catalogo_operacoes
  drop constraint if exists bling_catalogo_operacoes_tipo_check;
alter table public.bling_catalogo_operacoes
  add constraint bling_catalogo_operacoes_tipo_check
  check (
    tipo in (
      'ALTERAR_PRODUTO',
      'CRIAR_CAMPO',
      'VINCULAR_LOJA',
      'ALTERAR_IMAGENS_MARKETPLACE',
      'ALTERAR_PRECO_PROMOCIONAL'
    )
  );

create index if not exists bling_imagens_lote_itens_preco_fila_idx
  on public.bling_imagens_lote_itens (lote_id, preco_status, posicao);

create table if not exists public.bling_erros_operacionais (
  id uuid primary key default gen_random_uuid(),
  origem text not null check (origem in ('IMAGENS', 'PRECO_PROMOCIONAL')),
  lote_id uuid references public.bling_imagens_lotes(id) on delete set null,
  item_id uuid references public.bling_imagens_lote_itens(id) on delete set null,
  id_produto_bling bigint,
  codigo text not null,
  produto text not null,
  etapa text not null,
  mensagem text not null,
  status text not null default 'PENDENTE' check (status in ('PENDENTE', 'RESOLVIDO')),
  tentativas integer not null default 0 check (tentativas >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolvido_em timestamptz,
  unique (origem, item_id)
);

create index if not exists bling_erros_operacionais_status_idx
  on public.bling_erros_operacionais (status, updated_at desc);
create index if not exists bling_erros_operacionais_codigo_idx
  on public.bling_erros_operacionais (codigo, updated_at desc);

alter table public.bling_erros_operacionais enable row level security;
revoke all on table public.bling_erros_operacionais from public, anon, authenticated;
grant select, insert, update on table public.bling_erros_operacionais to service_role;

update public.bling_imagens_lote_itens
set status = 'FALHA',
    motivo = coalesce(nullif(motivo, ''), 'Produto sem imagem salva no Supabase e sem imagem atual no Bling.'),
    updated_at = now()
where status = 'IGNORADO'
  and etapa = 'SEM_IMAGEM_FONTE';

insert into public.bling_erros_operacionais (
  origem, lote_id, item_id, id_produto_bling, codigo, produto, etapa, mensagem, tentativas
)
select
  'IMAGENS', lote_id, id, id_produto_bling, codigo, produto, etapa,
  coalesce(nullif(motivo, ''), 'Falha de imagens sem mensagem registrada.'), tentativas
from public.bling_imagens_lote_itens
where status in ('FALHA', 'REVISAO')
on conflict (origem, item_id) do nothing;

comment on column public.bling_imagens_lotes.atualizar_preco_promocional is
  'Quando ativo, iguala o preco promocional ao preco do vinculo da loja apos as imagens.';
comment on table public.bling_erros_operacionais is
  'Historico privado e consolidado de erros de imagens e preco promocional.';
