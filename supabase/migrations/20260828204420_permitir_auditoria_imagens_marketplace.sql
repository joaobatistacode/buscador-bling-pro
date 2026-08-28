alter table public.bling_catalogo_operacoes
  drop constraint if exists bling_catalogo_operacoes_tipo_check;

alter table public.bling_catalogo_operacoes
  add constraint bling_catalogo_operacoes_tipo_check
  check (
    tipo in (
      'ALTERAR_PRODUTO',
      'CRIAR_CAMPO',
      'VINCULAR_LOJA',
      'ALTERAR_IMAGENS_MARKETPLACE'
    )
  );

comment on constraint bling_catalogo_operacoes_tipo_check
  on public.bling_catalogo_operacoes is
  'Restringe a auditoria privada aos tipos de operacao liberados pelo servidor.';
