-- ROLLBACK of step 3 (restores the pre-lockdown state from the _rollback_* tables made by 03-lockdown.sql).
-- NOTE: the restored old passwords and global code are the COMPROMISED ones. Use this only to get the site working again,
-- then fix forward. If you roll back, also redeploy the previous (old) front end, which needs these columns.
begin;
alter table public.properties add column if not exists password text;
update public.properties p set password = b.password from public._rollback_properties_password b where b.id = p.id;
update public.site_settings s set value = b.value from public._rollback_site_settings b where s.key = b.key;

drop policy if exists "public listings" on public.properties;
drop policy if exists "public read active" on public.properties;
create policy "public read active" on public.properties for select using (active);   -- original behaviour: anyone sees active rows

drop policy if exists "site_settings read" on public.site_settings;
create policy "site_settings read" on public.site_settings for select using (true);
commit;
-- Optional clean-up once you are happy: drop table public._rollback_policies, public._rollback_properties_password, public._rollback_site_settings;
