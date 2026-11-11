-- ════════════════════════════════════════════════════════════════════════════
-- STEP 4 — let the admin's storage.remove() actually delete files in the property-images bucket.
-- Problem: storage.objects had INSERT and DELETE policies for signed-in users but NO SELECT policy. The Storage API needs to
-- see an object to delete it, so remove() "succeeded" while deleting nothing (old brochures and deleted listings' photos piled up).
-- Fix: SELECT on this bucket for registered admins only (needs public.is_admin() from 01-additive.sql).
-- Public photo URLs keep working: the bucket is public, which does not depend on this policy. Anonymous users still cannot list files.
-- Rollback: 04-rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
begin;
do $$
begin
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Run 01-additive.sql first (needs public.is_admin()).';
  end if;
end $$;

drop policy if exists "Admins can read property-images objects" on storage.objects;
create policy "Admins can read property-images objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'property-images' and public.is_admin());
commit;
