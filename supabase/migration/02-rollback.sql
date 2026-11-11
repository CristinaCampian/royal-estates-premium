-- ROLLBACK of 02-admin-only-settings.sql: puts the original write policy back (any signed-in account can write site_settings).
-- Only use it if the admin cannot save settings; then fix the cause and run 02 again. Turn off public sign-ups either way.
begin;
drop policy if exists "site_settings write" on public.site_settings;
create policy "site_settings write" on public.site_settings for all to authenticated using (true) with check (true);
commit;
