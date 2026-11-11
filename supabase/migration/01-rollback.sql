-- ROLLBACK of step 1. Removes everything 01-additive.sql created. Nothing that existed before is touched.
-- (The generated codes are deleted with the tables. If you already shared new codes, regenerate after a re-run.)
drop function if exists public.unlock_property(bigint, text);
drop function if exists public.unlock_all(text);
drop function if exists public._check_throttle();
drop function if exists public._log_attempt(boolean);
drop function if exists public._client_id();
drop view     if exists public.locked_teasers;
drop table    if exists public.access_attempts;
drop table    if exists public.access_secrets;
drop table    if exists public.property_access;
drop function if exists public.gen_code(int, int);
drop function if exists public.norm_code(text);
