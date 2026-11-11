-- ════════════════════════════════════════════════════════════════════════════
-- STEP 6 — what a LOCKED card may show to everyone: the property type, an area label you type, and a heavily blurred preview.
-- NOT run automatically. Review, then run in the Supabase SQL editor. Rollback: 06-rollback.sql
--
-- Public after this step, per locked listing (and only while "teaser_on" is true):
--   · type          e.g. penthouse            (already a normal listing field)
--   · teaser_area   e.g. "Silver Coast"       (a label YOU type in the admin; the real `location` stays private)
--   · teaser_image  teaser/xxxx.webp          (a ~32px-wide, blurred copy made in the admin; never the original photo)
-- Still private: title, real location, price, description, photos, size, everything else.
-- Off-market listings stay completely hidden (they are not in the view at all).
-- Safe to run while the site is live: additive (new columns with defaults + a view that keeps its old columns first).
-- ════════════════════════════════════════════════════════════════════════════
begin;

alter table public.properties add column if not exists teaser_on    boolean not null default true;
alter table public.properties add column if not exists teaser_area  text;
alter table public.properties add column if not exists teaser_image text;

-- guard rails: a teaser image can only live in the teaser/ folder (so it can never point at a full-size listing photo),
-- and the area label is a short label, not a paragraph.
alter table public.properties drop constraint if exists properties_teaser_image_chk;
alter table public.properties add  constraint properties_teaser_image_chk
  check (teaser_image is null or teaser_image ~ '^teaser/[A-Za-z0-9._-]+\.webp$');
alter table public.properties drop constraint if exists properties_teaser_area_chk;
alter table public.properties add  constraint properties_teaser_area_chk
  check (teaser_area is null or char_length(teaser_area) <= 60);

-- same rows as before (active, locked, not off-market); first two columns unchanged so the current site keeps working
create or replace view public.locked_teasers as
  select p.id,
         p.created_at,
         case when p.teaser_on then p.type         end as type,
         case when p.teaser_on then p.teaser_area  end as teaser_area,
         case when p.teaser_on then p.teaser_image end as teaser_image
    from public.properties p
   where p.active and p.is_locked
     and coalesce((p.details ->> 'off_market')::boolean, false) = false;

grant select on public.locked_teasers to anon, authenticated;
commit;
