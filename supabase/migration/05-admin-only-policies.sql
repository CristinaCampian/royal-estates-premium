-- ════════════════════════════════════════════════════════════════════════════
-- STEP 5 — admin-only policies for properties, property_tags, property_types and enquiries.
-- Before: "Auth users ... ALL/SELECT using (auth.role() = 'authenticated')" = ANY signed-in account could edit listings, tags and
--         types and read every enquiry (names, e-mails, phone numbers). With public sign-ups on that was open to the world.
-- After:  only a registered admin (public.admins / is_admin()).
-- Kept as they are: public read of active properties (or "public listings" after step 3), public read of tags/types,
--         public INSERT of enquiries and access requests (the contact forms).
-- Needs 01-additive.sql. Safe to run before or after 03-lockdown.sql.
-- Rollback: 05-rollback.sql  (if you also roll back step 3, run 05-rollback FIRST, then 03-rollback)
-- ════════════════════════════════════════════════════════════════════════════
begin;
do $$
begin
  if to_regprocedure('public.is_admin()') is null or not exists (select 1 from public.admins) then
    raise exception 'Run 01-additive.sql first (needs public.is_admin() and at least one admin).';
  end if;
end $$;

-- properties: admin can do everything (step 3 creates the same policy; creating it here keeps this file independent)
drop policy if exists "Auth users can manage properties" on public.properties;
drop policy if exists "admin all" on public.properties;
create policy "admin all" on public.properties for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- tags and types: reading stays public, writing is admin-only
drop policy if exists "Auth users manage tags" on public.property_tags;
drop policy if exists "admin manage tags" on public.property_tags;
create policy "admin manage tags" on public.property_tags for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Auth users manage types" on public.property_types;
drop policy if exists "admin manage types" on public.property_types;
create policy "admin manage types" on public.property_types for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- enquiries: visitors can still send one (INSERT policy untouched); only the admin can read them
drop policy if exists "Auth users can read enquiries" on public.enquiries;
drop policy if exists "admin read enquiries" on public.enquiries;
create policy "admin read enquiries" on public.enquiries for select to authenticated using (public.is_admin());
commit;
