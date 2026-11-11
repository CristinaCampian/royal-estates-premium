-- ════════════════════════════════════════════════════════════════════════════
-- STEP 3 of 3 — FINAL LOCKDOWN.  Run ONLY after step 1 is done AND the new front end (step 2) is live and tested.
-- The OLD site cannot work after this script (it reads properties.password and site_settings.access_code).
--   · saves what it changes into _rollback_* tables
--   · anonymous visitors can read only public listings (not locked, not off-market, active)
--   · removes the public read of site_settings (the old global access code)
--   · drops the plaintext properties.password column
-- Rollback: 03-rollback.sql.  Runs as ONE transaction: if any check fails nothing changes.
-- ════════════════════════════════════════════════════════════════════════════
begin;

-- 0. refuse to run if step 1 is missing or a locked listing would end up with no code
do $$
begin
  if to_regclass('public.property_access') is null or to_regclass('public.access_secrets') is null then
    raise exception 'Step 1 has not been run.';
  end if;
  if not exists (select 1 from public.access_secrets where key = 'master_code') then
    raise exception 'No master code found (step 1).';
  end if;
  if exists (select 1 from public.properties p where p.is_locked and not exists (select 1 from public.property_access a where a.property_id = p.id)) then
    raise exception 'Some locked listings have no code yet. Create them in the admin (Access codes) first.';
  end if;
end $$;

-- 1. rollback copies (private: RLS on, no policies)
create table if not exists public._rollback_policies as
  select now() as saved_at, schemaname, tablename, policyname, cmd, roles, qual, with_check
  from pg_policies where schemaname = 'public' and tablename in ('properties', 'site_settings');
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'properties' and column_name = 'password') then
    execute 'create table if not exists public._rollback_properties_password as select id, password from public.properties where password is not null';
  else
    create table if not exists public._rollback_properties_password (id bigint, password text);
  end if;
end $$;
create table if not exists public._rollback_site_settings as select * from public.site_settings where key = 'access_code';
alter table public._rollback_policies            enable row level security;
alter table public._rollback_properties_password enable row level security;
alter table public._rollback_site_settings       enable row level security;

-- 2. properties: anonymous visitors see public listings only (a listing with no lock flag counts as public)
update public.properties set is_locked = false where is_locked is null;
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'properties' and cmd = 'SELECT' and roles && array['anon', 'public']::name[]
  loop
    execute format('drop policy %I on public.properties', r.policyname);
    raise notice 'dropped public read policy: %', r.policyname;
  end loop;
end $$;
drop policy if exists "public listings" on public.properties;
create policy "public listings" on public.properties for select to anon
  using (active and not is_locked and coalesce((details->>'off_market')::boolean, false) = false);
drop policy if exists "admin all" on public.properties;
create policy "admin all" on public.properties for all to authenticated using (true) with check (true);

-- 3. site_settings: the old global code is no longer public (and is blanked)
drop policy if exists "site_settings read" on public.site_settings;
update public.site_settings set value = '' where key = 'access_code';

-- 4. the plaintext per-listing passwords go
alter table public.properties drop column if exists password;

commit;
