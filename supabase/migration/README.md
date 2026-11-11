# Unlock rebuild: runbook

Goal: a code unlocks **one** listing, a separate **master code** unlocks all, and locked data never reaches anonymous visitors.
Nothing here runs by itself. You run each SQL file yourself in the Supabase SQL editor (project `mejkdoabupmfwcldysgd`), in order.
The SQL was tested on a real Postgres engine (PGlite) with a harness that simulates Supabase's roles, default grants and RLS:
68 checks pass (see "What was tested"). It has **not** been run on your Supabase project.

| Step | What | File | Rollback |
|---|---|---|---|
| 1 | Additive only: admin list, private tables, functions, throttle, **new random codes** | `01-additive.sql` | `01-rollback.sql` |
| 1b | `site_settings` writes: admins only (run right after step 1) | `02-admin-only-settings.sql` | `02-rollback.sql` |
| 5 | `properties`, `property_tags`, `property_types` writes and `enquiries` reads: admins only (run after step 3; **run 05-rollback before 03-rollback if you roll both back**) | `05-admin-only-policies.sql` | `05-rollback.sql` |
| 4 | Storage: admin `remove()` actually deletes (bucket had no SELECT policy, so deletes silently did nothing); needed by the admin's delete-cleanup | `04-storage-admin-select.sql` | `04-rollback.sql` |
| 2 | Switch the front end over (deploy, no SQL) | this branch | redeploy the previous build |
| 3 | Final lockdown: drop `password`, hide `access_code`, restrict anonymous reads | `03-lockdown.sql` | `03-rollback.sql` |

Order: **1 → deploy the new site + admin → test → 3**. Never run 3 while the old site or old admin is live (they use `properties.password` and `site_settings.access_code`).
Photos: Level A (public bucket, random file names that are only revealed after unlocking).

## Pre-migration checklist

- [ ] **Turn off public sign-ups** (no SQL): Supabase dashboard → Authentication → Sign In / Providers → switch off **Allow new users to sign up**. Today they are ON (`disable_signup: false`), which means anyone with an e-mail address can create a "signed-in" account.
- [ ] See who has accounts: SQL editor → `select id, email, created_at, last_sign_in_at from auth.users order by created_at;` Delete any account you don't recognise (Authentication → Users).
- [ ] **Backup.** The free plan has no backup you can rely on, so:
  - `create table public._bak_properties as select * from public.properties;` and `create table public._bak_site_settings as select * from public.site_settings;`
  - Table editor → `_bak_properties` → Export to CSV. Keep the CSV privately (it holds the old codes), never in the repo.
  - Optional full dump: `supabase db dump --db-url "<connection string>" -f backup.sql`
- [ ] Save today's policies: `select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;` Look for any policy `to authenticated using (true)`: it lets ANY signed-in account edit that table. Tell me what you find.
- [ ] Check the id type: `select data_type from information_schema.columns where table_name = 'properties' and column_name = 'id';` (should be `bigint` or `integer`; step 1 checks this too).
- [ ] Know your admin sign-in e-mail (Authentication → Users).
- [ ] Tell clients all old codes will stop working and new ones will be sent.
- [ ] Do not merge this branch to `main` until step 1 is done and the preview is tested.

## How to run a file in the SQL editor

1. Supabase dashboard → **SQL Editor** → **New query**.
2. Open the file from this repo, select all, copy, paste into the editor. (Never run a file you haven't read.)
3. For step 1 only: replace **every** `PUT-YOUR-ADMIN-EMAIL-HERE` (3 places) with your admin e-mail first (editor: Ctrl+H).
4. Click **Run** (bottom right). Wait for "Success". If you get an error, nothing half-done stays for steps 3; for step 1 re-running is safe.
5. Read the result panel as described below.

## Step 1: `01-additive.sql`

- Creates the admin list (`admins`), `property_access` (one code per locked listing), `access_secrets` (master code), `access_attempts` (throttle), the view `locked_teasers`, and the functions `unlock_property` / `unlock_all`. Nothing existing changes.
- It **generates new random codes** (10 characters per locked listing, 12 for the master). The last two queries show them in the result panel (tabs at the bottom): **copy them somewhere private now**. They also appear later in Admin → Access codes.
- It stops with "No admin registered" if the e-mail is wrong: fix it and run again.
- Check: `select count(*) from public.property_access;` = number of locked listings; `select count(*) from public.admins;` = 1.
- **Check the throttle sees real addresses** (important): on the preview site type a wrong code on a locked card once, then run `select client, ok, at from public.access_attempts order by id desc limit 3;` The `client` must be **your public IP address**. If it says `unknown`, tell me: the throttle is then inactive (nobody gets locked out, but guessing isn't limited).
- Rollback: run `01-rollback.sql`.

## Step 1b: `02-admin-only-settings.sql`

- Replaces the `site_settings write` policy (`to authenticated using (true)`: any account that signed up could rewrite settings) with `is_admin()`. The read policy is untouched until step 3. The live admin keeps working (it signs in as the registered admin).
- Check: signed in as admin, save a setting (or just open Settings); an ordinary signed-in account changes 0 rows.
- Rollback: `02-rollback.sql`.
- Still open after this (found in the pre-migration policy review): `properties`, `property_tags`, `property_types` have `ALL ... auth.role() = 'authenticated'` policies and `enquiries` can be READ by any signed-in account. With sign-ups off this is only reachable by existing accounts; restrict them to `is_admin()` as well before relying on step 3 (step 3 drops the public read of `properties` but those `ALL` policies stay).

## Step 2: front end

- Deploy this branch as a preview. Public listings come from `properties` (`is_locked = false`), locked cards from `locked_teasers` (just an id). Codes are checked by `unlock_property` / `unlock_all`, remembered per tab session and re-checked on reload.
- The Admin gets an **Access codes** page (reads `property_access` / `access_secrets`, admin accounts only) and loses the old password / global-code fields.
- Run the **test checklist** below on the preview, then merge to `main` so production gets the new site and admin.
- Rollback: Vercel → Deployments → promote the previous production deployment (or `git revert`). Works as long as step 3 has not been run.

## Step 3: `03-lockdown.sql`

- One transaction. It refuses to run if step 1 is missing/incomplete, no admin exists, no master code exists, or **any locked listing has no code**, and in all those cases it changes nothing.
- Saves what it changes in `_rollback_*` tables, restricts anonymous reads to public listings, removes the public read of `site_settings`, blanks the old `access_code`, limits `site_settings` writes to admins, drops `properties.password`.
- Rollback: `03-rollback.sql` (restores the **compromised** old codes, so redeploy the old site and admin too; use only to recover, then fix forward).
- Before running it, production (`main`) must already serve the new site **and** new admin.

## Test checklist (preview after step 1, and again after step 3)

Use a private window for "visitor" checks.

1. **One code opens one listing.** Unlock one locked card with its own code: only that card opens; others stay locked. Reload the tab: still unlocked. Close the tab and reopen: locked again.
2. **Wrong code opens nothing.** Another listing's code is refused too. Ten wrong tries in a row from one address: "Too many attempts". A different device/network is unaffected.
3. **Master code opens everything** via **Unlock all properties**.
4. **The public API no longer leaks** (after step 3). In a private window, DevTools → Network → the `properties` request, or from a terminal:
   `curl -s "https://mejkdoabupmfwcldysgd.supabase.co/rest/v1/properties?select=*" -H "apikey: <anon key>"`
   - no row has `is_locked = true`, a `password` field, or the photos/description/price of a locked listing;
   - `.../rest/v1/property_access?select=*`, `.../access_secrets?select=*`, `.../access_attempts?select=*`, `.../admins?select=*` return an error or `[]`;
   - `.../rest/v1/site_settings?select=*` returns `[]`;
   - `.../rest/v1/locked_teasers?select=*` returns only `id` and `created_at`;
   - `.../rest/v1/rpc/gen_code` and `.../rpc/_check_throttle` return a permission error.
5. **Admin works.** Sign in: listings table, edit/save a listing, photo upload, **Access codes** shows every code and the master code, Copy and New code work.
6. **Old codes are dead.** An old per-listing code or the old global code unlocks nothing.

## What was tested (PGlite, 68 checks, all pass)

Placeholder e-mail refused · step 1 re-runnable and changes no existing data · new codes generated (format, length, differ from old) · anon cannot read the private tables or call internal functions · a random signed-in account reads and changes ZERO codes, only the registered admin can · weak codes rejected · right code opens only its listing (also typed lower-case with spaces) · other listing's code, wrong, empty and SQL-looking codes return nothing · master opens one or all · listing code does not unlock all · old global code dead · throttle is per address (not per listing, not global), ignores a forged first `x-forwarded-for` entry, prefers `cf-connecting-ip`, never locks out when no address exists · step 3 refuses without step 1 / with a locked listing without a code and changes nothing · after step 3 anon sees only public rows, `password` is gone, `site_settings` hidden, admin still sees everything, signed-in non-admins can't edit, unlock still works · `03-rollback`, `01-rollback` and repeats work.

Not tested (needs your project): PostgREST's real `request.headers` (hence the throttle check above), your existing policies, Supabase Auth.
