-- Run once in the Supabase SQL editor of the Royal Estates Premium project
-- (mejkdoabupmfwcldysgd). Adds the extra property fields + the brochure link.
-- Safe to re-run.
alter table public.properties
  add column if not exists details jsonb not null default '{}'::jsonb,
  add column if not exists brochure_url text;
