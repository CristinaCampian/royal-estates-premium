-- ROLLBACK of 05-admin-only-policies.sql: restores the original "any signed-in account" policies.
-- If you are also rolling back step 3, run THIS file first, then 03-rollback.sql (03-rollback drops "admin all" on properties,
-- so without these original policies nobody could write listings).
-- "admin all" on properties is left in place on purpose (step 3 owns it).
begin;
drop policy if exists "Auth users can manage properties" on public.properties;
create policy "Auth users can manage properties" on public.properties for all using (auth.role() = 'authenticated');

drop policy if exists "admin manage tags" on public.property_tags;
drop policy if exists "Auth users manage tags" on public.property_tags;
create policy "Auth users manage tags" on public.property_tags for all using (auth.role() = 'authenticated');

drop policy if exists "admin manage types" on public.property_types;
drop policy if exists "Auth users manage types" on public.property_types;
create policy "Auth users manage types" on public.property_types for all using (auth.role() = 'authenticated');

drop policy if exists "admin read enquiries" on public.enquiries;
drop policy if exists "Auth users can read enquiries" on public.enquiries;
create policy "Auth users can read enquiries" on public.enquiries for select using (auth.role() = 'authenticated');
commit;
