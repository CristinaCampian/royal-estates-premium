-- ROLLBACK of step 3 (restores the pre-lockdown state from the _rollback_* tables made by 03-lockdown.sql).
-- NOTE: the restored old passwords and global code are the COMPROMISED ones. Use this only to get the site working again,
-- then fix forward. If you roll back, also redeploy the previous (old) front end and admin, which need these columns.
-- Anyone signed in to Supabase Auth can write site_settings again after this (that was the original policy):
-- turn off public sign-ups in Authentication settings.
begin;
alter table public.properties add column if not exists password text;
update public.properties p set password = b.password from public._rollback_properties_password b where b.id = p.id;
update public.site_settings s set value = b.value from public._rollback_site_settings b where s.key = b.key;

drop policy if exists "public listings" on public.properties;
drop policy if exists "admin all" on public.properties;   -- made by step 3; writes keep using the policies that existed before
drop policy if exists "public read active" on public.properties;
create policy "public read active" on public.properties for select using (active);   -- original behaviour: anyone sees active rows

drop policy if exists "site_settings admin" on public.site_settings;
drop policy if exists "site_settings read" on public.site_settings;
create policy "site_settings read" on public.site_settings for select using (true);
drop policy if exists "site_settings write" on public.site_settings;
create policy "site_settings write" on public.site_settings for all to authenticated using (true) with check (true);
commit;
-- Optional clean-up once you are happy: drop table public._rollback_policies, public._rollback_properties_password, public._rollback_site_settings;
