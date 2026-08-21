create table if not exists public.bling_envios_contabilizados (
  codigo text primary key,
  contabilizado_em timestamptz not null default now()
);

alter table public.bling_envios_contabilizados enable row level security;
revoke all on table public.bling_envios_contabilizados from public, anon, authenticated;
grant all on table public.bling_envios_contabilizados to service_role;

insert into public.bling_envios_contabilizados (codigo, contabilizado_em)
select codigo, coalesce(enviado_em, updated_at, now())
from public.bling_produtos
where status = 'ENVIADO'
on conflict (codigo) do nothing;

insert into public.bling_painel_configuracao (
  id,
  enviados_informados,
  pendentes_informados,
  updated_at
)
values (1, 2800, 2249, now())
on conflict (id) do update
set enviados_informados = excluded.enviados_informados,
    pendentes_informados = excluded.pendentes_informados,
    updated_at = excluded.updated_at;

create or replace function public.registrar_envios_bling(p_codigos text[])
returns table (
  novos_envios integer,
  enviados_informados integer,
  pendentes_informados integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_novos integer := 0;
begin
  if p_codigos is null or cardinality(p_codigos) = 0 then
    return query
      select 0,
             c.enviados_informados,
             c.pendentes_informados
      from public.bling_painel_configuracao as c
      where c.id = 1;
    return;
  end if;

  if cardinality(p_codigos) > 500 then
    raise exception 'O limite por registro é de 500 códigos.';
  end if;

  with codigos_validos as (
    select distinct btrim(valor) as codigo
    from unnest(p_codigos) as valor
    where btrim(valor) <> ''
  ),
  inseridos as (
    insert into public.bling_envios_contabilizados (codigo)
    select codigo
    from codigos_validos
    on conflict (codigo) do nothing
    returning codigo
  )
  select count(*)::integer
  into v_novos
  from inseridos;

  update public.bling_produtos as p
  set status = 'ENVIADO',
      enviado_em = coalesce(p.enviado_em, now()),
      updated_at = now()
  where p.codigo = any(p_codigos)
    and p.status <> 'ENVIADO';

  update public.bling_painel_configuracao as c
  set enviados_informados = c.enviados_informados + v_novos,
      pendentes_informados = greatest(0, c.pendentes_informados - v_novos),
      updated_at = now()
  where c.id = 1;

  return query
    select v_novos,
           c.enviados_informados,
           c.pendentes_informados
    from public.bling_painel_configuracao as c
    where c.id = 1;
end;
$function$;

revoke all on function public.registrar_envios_bling(text[]) from public, anon, authenticated;
grant execute on function public.registrar_envios_bling(text[]) to service_role;
