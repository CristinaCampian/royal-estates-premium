-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSAL ONLY — NOT RUN. For review. Royal Estates Premium (mejkdoabupmfwcldysgd).
-- Goal: locked listings are protected on the SERVER, not just hidden in JavaScript.
--   · anonymous visitors can no longer read locked rows (description, price, photos, codes…)
--   · a code is checked inside the database; only the matching listing comes back
--   · a separate master code unlocks everything
-- Run it in the Supabase SQL editor, in order, only after review. Each step is re-runnable.
-- Take a backup first (Database → Backups, or: create table properties_backup as select * from properties;)
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── 1. Codes move out of the public tables ─────────────────────────────────
-- Normalised exactly like the site does today: lower-case, no spaces, dashes, dots or underscores.
create or replace function public.norm_code(t text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(t, ''), '[\s\-_.]', '', 'g')) $$;

create table if not exists public.property_access (
  property_id bigint primary key references public.properties(id) on delete cascade,
  code        text not null,            -- stored normalised; readable by signed-in admins only
  updated_at  timestamptz not null default now()
);
create table if not exists public.access_secrets (   -- key 'master_code' = the "unlock all properties" code
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.access_attempts (  -- brute-force throttle
  id bigserial primary key,
  at timestamptz not null default now(),
  client text,
  ok boolean not null
);
alter table public.property_access enable row level security;
alter table public.access_secrets  enable row level security;
alter table public.access_attempts enable row level security;
-- no policy for anon on these three tables = anon can read nothing from them
drop policy if exists "admin all" on public.property_access;
create policy "admin all" on public.property_access for all to authenticated using (true) with check (true);
drop policy if exists "admin all" on public.access_secrets;
create policy "admin all" on public.access_secrets  for all to authenticated using (true) with check (true);

-- copy today's codes across (the old columns stay until step 6)
insert into public.property_access (property_id, code)
  select id, public.norm_code(password) from public.properties
  where coalesce(password, '') <> ''
  on conflict (property_id) do update set code = excluded.code;
insert into public.access_secrets (key, value)
  select 'master_code', public.norm_code(value) from public.site_settings
  where key = 'access_code' and coalesce(value, '') <> ''
  on conflict (key) do update set value = excluded.value;

-- ── 2. Anonymous visitors only see listings that are public ───────────────
-- First list what exists:  select policyname, roles, cmd from pg_policies where tablename = 'properties';
-- then drop the anon/public SELECT policy it shows (name unknown to me), e.g.:
--   drop policy "<name of the existing select policy>" on public.properties;
drop policy if exists "public listings" on public.properties;
create policy "public listings" on public.properties for select to anon
  using (active and not is_locked and coalesce((details->>'off_market')::boolean, false) = false);
-- signed-in admins keep full access (keep or create):
drop policy if exists "admin all" on public.properties;
create policy "admin all" on public.properties for all to authenticated using (true) with check (true);

-- What a locked CARD may show to everyone: nothing but "a private listing exists".
-- (Title, price, location and cover photo of locked listings stop being public.)
create or replace view public.locked_teasers as
  select id, type, region, created_at
  from public.properties
  where active and is_locked and coalesce((details->>'off_market')::boolean, false) = false;
grant select on public.locked_teasers to anon;

-- ── 3. Unlock functions (run with the owner's rights, so they can read the private tables) ──
create or replace function public._check_throttle() returns void
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(split_part(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ',', 1), 'unknown');
begin
  if (select count(*) from public.access_attempts where client = who and not ok and at > now() - interval '10 minutes') >= 10 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
end $$;

create or replace function public._log_attempt(ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.access_attempts (client, ok)
  values (coalesce(split_part(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ',', 1), 'unknown'), ok);
  if not ok then perform pg_sleep(0.4); end if;
end $$;

-- one listing: its own code (or the master code) → that listing's full row, else null
create or replace function public.unlock_property(p_id bigint, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text := public.norm_code(p_code); good boolean; r jsonb;
begin
  perform public._check_throttle();
  select exists (select 1 from public.property_access where property_id = p_id and code = c and c <> '')
      or exists (select 1 from public.access_secrets where key = 'master_code' and value = c and c <> '') into good;
  perform public._log_attempt(good);
  if not good then return null; end if;
  select to_jsonb(p) - 'password' into r from public.properties p where p.id = p_id and p.active;
  return r;
end $$;

-- everything: master code only → every active listing (locked + off-market), else null
create or replace function public.unlock_all(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text := public.norm_code(p_code); good boolean;
begin
  perform public._check_throttle();
  select exists (select 1 from public.access_secrets where key = 'master_code' and value = c and c <> '') into good;
  perform public._log_attempt(good);
  if not good then return null; end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) - 'password'), '[]'::jsonb) from public.properties p where p.active and p.is_locked);
end $$;

-- the contact-panel box: a listing code unlocks the listing(s) that own it; the master code unlocks all
create or replace function public.unlock_by_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text := public.norm_code(p_code); r jsonb;
begin
  perform public._check_throttle();
  if exists (select 1 from public.access_secrets where key = 'master_code' and value = c and c <> '') then
    perform public._log_attempt(true);
    return (select coalesce(jsonb_agg(to_jsonb(p) - 'password'), '[]'::jsonb) from public.properties p where p.active and p.is_locked);
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) - 'password'), '[]'::jsonb) into r
    from public.properties p join public.property_access a on a.property_id = p.id
    where p.active and a.code = c and c <> '';
  perform public._log_attempt(jsonb_array_length(r) > 0);
  return case when jsonb_array_length(r) > 0 then r else null end;
end $$;

revoke all on function public.unlock_property(bigint, text), public.unlock_all(text), public.unlock_by_code(text) from public;
grant execute on function public.unlock_property(bigint, text), public.unlock_all(text), public.unlock_by_code(text) to anon, authenticated;

-- ── 4. Site settings: the master code must not be public any more ─────────────
drop policy if exists "site_settings read" on public.site_settings;
-- (site_settings keeps any non-secret settings; the 'access_code' row is cleared in step 6)

-- ── 5. Photos ────────────────────────────────────────────────────────────────
-- Level A (works today, no code changes to storage): the bucket stays public, but the file names of
-- locked listings are random and are now only returned by the unlock functions above. Photos stay
-- unlisted (anonymous listing already returns nothing). Protection = unguessable names.
--
-- Level B (strict, recommended for off-market / sensitive listings): a PRIVATE bucket for locked photos.
--   insert into storage.buckets (id, name, public) values ('property-images-locked', 'property-images-locked', false);
--   -- no policy for anon on storage.objects of that bucket; admins may read/write:
--   create policy "admin locked photos" on storage.objects for all to authenticated
--     using (bucket_id = 'property-images-locked') with check (bucket_id = 'property-images-locked');
--   Then an Edge Function `unlock-photos` (service-role key kept server-side) calls the unlock RPC with the
--   visitor's code and, on success, returns 1-hour signed URLs (storage.createSignedUrls) for that listing's photos.
--   The admin uploader would write to the private bucket when "Locked" is ticked. This is more work (admin
--   change + one function) and I would only do it after you choose it.

-- ── 6. Clean up — ONLY after the new site is live and tested ──────────────────
-- update public.site_settings set value = '' where key = 'access_code';
-- alter table public.properties drop column password;
-- (the admin then edits codes in property_access / access_secrets instead of properties.password / site_settings)
