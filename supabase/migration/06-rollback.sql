-- ROLLBACK of 06-locked-teasers.sql: locked cards go back to showing nothing but the lock.
-- The three new columns on properties are left in place (harmless, no data is lost); drop them only if you really want to:
--   alter table public.properties drop column teaser_on, drop column teaser_area, drop column teaser_image;
-- The blurred files in the bucket's teaser/ folder stay until you delete them (admin or Storage UI).
begin;
drop view if exists public.locked_teasers;
create view public.locked_teasers as
  select p.id, p.created_at
    from public.properties p
   where p.active and p.is_locked
     and coalesce((p.details ->> 'off_market')::boolean, false) = false;
grant select on public.locked_teasers to anon, authenticated;
commit;
