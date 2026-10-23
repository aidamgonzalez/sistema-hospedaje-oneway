-- ============================================================
--  Historial de cambios (quién cambió qué y cuándo)
--  Pégalo en Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.actividad (
  id         bigserial primary key,
  fecha      timestamptz not null default now(),
  usuario    uuid,
  nombre     text,
  path       text not null,
  coleccion  text,
  clave      text,
  accion     text,
  antes      jsonb,
  despues    jsonb
);
create index if not exists actividad_fecha_idx on public.actividad (fecha desc);
create index if not exists actividad_path_clave_idx on public.actividad (path, clave);

create or replace function public.registrar_cambio() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  nom text; o jsonb; n jsonb; sub text; k text; ov jsonb; nv jsonb; acc text;
  p text; c text;
begin
  select coalesce(nullif(nombre, ''), email) into nom from public.perfiles where id = auth.uid();
  if TG_OP = 'DELETE' then
    insert into public.actividad (usuario, nombre, path, coleccion, clave, accion, antes, despues)
    values (auth.uid(), nom, old.path, old.coleccion, null, 'eliminar documento', null, null);
    return old;
  end if;
  p := new.path; c := new.coleccion;
  o := case when TG_OP = 'UPDATE' then old.data else '{}'::jsonb end;
  n := new.data;

  -- Cambios dentro de "rows" (reservas) e "items" (créditos, tasas, hoteles)
  foreach sub in array array['rows', 'items', 'lista'] loop
    if (n ? sub) or (o ? sub) then
      for k in
        select jsonb_object_keys(coalesce(n->sub, '{}'::jsonb))
        union select jsonb_object_keys(coalesce(o->sub, '{}'::jsonb))
      loop
        ov := o->sub->k; nv := n->sub->k;
        if ov is distinct from nv then
          acc := case
            when ov is null then 'crear'
            when nv is null or coalesce(nv->>'_borrado', '') = 'true' then 'eliminar'
            else 'editar' end;
          insert into public.actividad (usuario, nombre, path, coleccion, clave, accion, antes, despues)
          values (auth.uid(), nom, p, c, sub || ':' || k, acc, ov, nv);
        end if;
      end loop;
    end if;
  end loop;

  -- Otros campos del documento (nombre del hotel, % de retención, fecha de corte…)
  for k in
    select jsonb_object_keys(n) union select jsonb_object_keys(o)
  loop
    if k not in ('rows', 'items', 'lista') and (o->k) is distinct from (n->k) then
      insert into public.actividad (usuario, nombre, path, coleccion, clave, accion, antes, despues)
      values (auth.uid(), nom, p, c, 'campo:' || k,
              case when TG_OP = 'INSERT' then 'crear' else 'editar' end, o->k, n->k);
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists docs_historial on public.docs;
create trigger docs_historial after insert or update or delete on public.docs
  for each row execute function public.registrar_cambio();

alter table public.actividad enable row level security;
drop policy if exists actividad_ver on public.actividad;
create policy actividad_ver on public.actividad for select
  using (public.es_activo() and (coleccion <> 'creditos' or public.es_admin()));
-- Nadie puede escribir ni borrar el historial directamente: solo la base de datos.
