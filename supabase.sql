-- ============================================================
--  Sistema de Hospedaje ONE WAY · estructura de la base de datos
--  Pégalo completo en Supabase → SQL Editor → New query → Run
-- ============================================================

-- 1) Documentos del sistema (reservas por año, hoteles, tasas, créditos)
create table if not exists public.docs (
  path        text primary key,
  coleccion   text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
create index if not exists docs_coleccion_idx on public.docs (coleccion);
alter table public.docs replica identity full;

-- 2) Perfiles de usuario (rol y acceso)
create table if not exists public.perfiles (
  id      uuid primary key references auth.users(id) on delete cascade,
  nombre  text,
  email   text,
  rol     text not null default 'agente' check (rol in ('admin','agente')),
  activo  boolean not null default true,
  creado  timestamptz not null default now()
);

-- 3) Funciones de ayuda
create or replace function public.es_activo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and activo);
$$;

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and activo and rol = 'admin');
$$;

create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; r jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  r := a;
  for k in select jsonb_object_keys(b) loop
    if r ? k and jsonb_typeof(r->k) = 'object' and jsonb_typeof(b->k) = 'object' and b->k <> '{}'::jsonb then
      r := jsonb_set(r, array[k], public.jsonb_deep_merge(r->k, b->k));
    else
      r := jsonb_set(r, array[k], b->k);
    end if;
  end loop;
  return r;
end $$;

-- Actualiza solo los campos enviados (sin borrar los demás)
create or replace function public.doc_update(p_path text, p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  update public.docs set data = public.jsonb_deep_merge(data, p_patch), updated_at = now()
   where path = p_path returning data into r;
  if r is null then raise exception 'no_existe' using errcode = 'P0002'; end if;
  return r;
end $$;

-- 4) Seguridad por filas
alter table public.docs enable row level security;
alter table public.perfiles enable row level security;

drop policy if exists docs_acceso on public.docs;
create policy docs_acceso on public.docs for all
  using (public.es_activo() and (coleccion <> 'creditos' or public.es_admin()))
  with check (public.es_activo() and (coleccion <> 'creditos' or public.es_admin()));

drop policy if exists perfiles_ver on public.perfiles;
create policy perfiles_ver on public.perfiles for select
  using (id = auth.uid() or public.es_admin());

drop policy if exists perfiles_crear on public.perfiles;
create policy perfiles_crear on public.perfiles for insert
  with check (
    public.es_admin()
    or (id = auth.uid() and rol = 'admin'
        and lower(coalesce(auth.jwt()->>'email','')) = 'aida.m.gonzalezsilva@gmail.com')
  );

drop policy if exists perfiles_editar on public.perfiles;
create policy perfiles_editar on public.perfiles for update
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists perfiles_borrar on public.perfiles;
create policy perfiles_borrar on public.perfiles for delete using (public.es_admin());

-- 5) Cambios en vivo entre usuarios
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
