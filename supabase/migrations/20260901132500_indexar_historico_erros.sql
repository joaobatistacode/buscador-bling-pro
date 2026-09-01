create index if not exists bling_erros_operacionais_lote_idx
  on public.bling_erros_operacionais (lote_id);
create index if not exists bling_erros_operacionais_item_idx
  on public.bling_erros_operacionais (item_id);
