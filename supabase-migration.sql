-- Run once in the Supabase SQL editor of the Royal Estates Premium project
-- (mejkdoabupmfwcldysgd). Adds the extra property fields + the brochure link.
-- Safe to re-run.
alter table public.properties
  add column if not exists details jsonb not null default '{}'::jsonb,
  add column if not exists brochure_url text;

-- Global access code (editable in the admin, above the properties table).
-- Anyone can read it (the site needs it); only signed-in admins can change it.
create table if not exists public.site_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;
drop policy if exists "site_settings read" on public.site_settings;
create policy "site_settings read" on public.site_settings for select using (true);
drop policy if exists "site_settings write" on public.site_settings;
create policy "site_settings write" on public.site_settings for all to authenticated using (true) with check (true);
insert into public.site_settings (key, value) values ('access_code', 'premium2025') on conflict (key) do nothing;
