-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1b — site_settings: only admins may WRITE.   Run after 01-additive.sql (needs public.is_admin()).
-- Before: "site_settings write" = ALL to authenticated using (true) -> any account that signs up could rewrite the settings.
-- After:  same policy name, but only a registered admin (public.admins) passes.
-- The READ policy is left alone on purpose (the old site still reads the old code until step 3 removes it).
-- Safe for the live site: the admin page already runs as an admin account.  Rollback: 02-rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $$
begin
  if to_regprocedure('public.is_admin()') is null or not exists (select 1 from public.admins) then
    raise exception 'Run 01-additive.sql first (needs public.is_admin() and at least one admin).';
  end if;
end $$;

drop policy if exists "site_settings write" on public.site_settings;
create policy "site_settings write" on public.site_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

commit;
