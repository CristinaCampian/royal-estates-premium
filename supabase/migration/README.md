# Unlock rebuild: runbook

Goal: a code unlocks **one** listing, a separate **master code** unlocks all, and locked data never reaches anonymous visitors.
Nothing here has been run. Nothing runs by itself. You run each SQL file yourself in the Supabase SQL editor
(project `mejkdoabupmfwcldysgd`), in order, and check in between.

| Step | What | File | Rollback |
|---|---|---|---|
| 1 | Additive only: new private tables, functions, throttle, **new random codes** | `01-additive.sql` | `01-rollback.sql` |
| 2 | Switch the front end over (deploy, no SQL) | this branch | redeploy the previous build (below) |
| 3 | Final lockdown: drop `password`, hide `access_code`, restrict anonymous reads | `03-lockdown.sql` | `03-rollback.sql` |

Order matters: **1 → deploy → test → 3**. Never run 3 while the old site is live (it would break the old site).
Photos: Level A (public bucket, random file names that are only revealed after unlocking).

## Pre-migration checklist (before step 1)

- [ ] **Backup.** The free plan has no automatic backup you can rely on, so do both:
  - Supabase dashboard → Database → Backups: download one if your plan lists any.
  - In the SQL editor run: `create table public._bak_properties as select * from public.properties; create table public._bak_site_settings as select * from public.site_settings;`
    then Table editor → `_bak_properties` → Export to CSV, and keep the CSV (it contains the old codes: store it privately, never in the repo).
  - Optional full dump with the CLI: `supabase db dump --db-url "<connection string>" -f backup.sql`
- [ ] Record today's policies and keep the result: `select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;`
- [ ] Confirm you can sign in to `/admin` with your admin account (step 1 gives codes only to signed-in admins).
- [ ] Tell clients that **all old codes will stop working** and that new ones will be sent.
- [ ] Do not merge this branch to `main` yet: test on the Vercel preview first.

## Step 1: run `01-additive.sql`

- It creates `property_access` (one code per locked listing), `access_secrets` (the master code), `access_attempts` (throttle), the view `locked_teasers`, and the functions `unlock_property`, `unlock_all`.
- It **generates new random codes**: 10 characters per locked listing (e.g. `7KQ4M-ZT9XD`), 12 for the master (e.g. `4HDM-X7TQ-2WNP`). Capitals, spaces and dashes don't matter when typing.
- The last two queries print all new codes in the editor. They are also visible later in **Admin → Access codes**.
- Nothing existing changes: the live site and old codes keep working until step 3.
- Check: `select count(*) from public.property_access;` equals the number of locked listings.
- Rollback: run `01-rollback.sql`.

## Step 2: front end (this branch)

- Public listings come from `properties` (anonymous reads, `is_locked = false`); locked cards come from the `locked_teasers` view (just an id).
- Each locked card has its own code field → `unlock_property(id, code)`. The master option → `unlock_all(code)`.
- The codes you type are kept in `sessionStorage` for the tab session and re-checked on reload.
- Deploy this branch as a preview, run the **test checklist** below, then merge/deploy to production.
- Rollback: in Vercel, promote the previous production deployment (or `git revert` the merge). The old front end works again as long as step 3 has **not** been run.

## Step 3: run `03-lockdown.sql`

- Runs in one transaction and refuses to run if a locked listing has no code or step 1 is missing.
- Saves what it changes in `_rollback_*` tables, then: restricts anonymous reads to public listings, removes the public read of `site_settings`, blanks the old `access_code`, drops `properties.password`.
- Rollback: `03-rollback.sql` (restores the **compromised** old codes; redeploy the old front end too; use only to recover, then fix forward).

## Test checklist (do this on the preview after step 1, and again after step 3)

Use a private window for "visitor" checks.

1. **One code opens one listing.** Unlock a single locked card with its own code. Only that card turns into a full listing; every other locked card stays locked. Reload the tab: it is still unlocked (session memory). Close the tab and reopen: locked again.
2. **A wrong code opens nothing.** Type a random code on a card: "Incorrect code", nothing changes. Ten wrong tries in a row: "Too many attempts. Try again later."
3. **Another listing's code doesn't work.** Type listing A's code on listing B's card: refused.
4. **The master code opens everything.** Use **Unlock all properties** with the master code: all locked cards open at once.
5. **Master code on one card** also opens that card (and only it) unless you use the Unlock-all option.
6. **The public API no longer leaks.** (after step 3) In a private window, open DevTools → Network, reload, and look at the `properties` request: no locked listing appears. Or from a terminal:
   `curl -s "https://mejkdoabupmfwcldysgd.supabase.co/rest/v1/properties?select=*" -H "apikey: <anon key>"`
   - none of the returned rows has `is_locked = true`, a `password` field, or the photos/description/price of a locked listing;
   - `.../rest/v1/property_access?select=*` returns `[]` or a permission error;
   - `.../rest/v1/site_settings?select=*` returns `[]` or a permission error;
   - `.../rest/v1/locked_teasers?select=*` returns only `id` and `created_at`.
7. **Admin still works.** Sign in to `/admin`: listings table, create/edit/save a listing, upload photos, Access codes page shows every code and the master code, Copy works.
8. **Old codes are dead.** An old per-listing code or `premium2025`-style global code no longer unlocks anything.
