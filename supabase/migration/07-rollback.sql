-- ROLLBACK of 07-short-codes.sql: restores the previous long codes, the old length rules and the old throttle (10 wrong tries / 10 minutes).
-- Listings that were locked after step 7 (so they have no old code) get a fresh long code. Run this BEFORE 01-rollback.sql if you roll back both.
-- Afterwards you can drop the private copies:  drop table public._rollback_property_access_07, public._rollback_access_secrets_07;
begin;
do $$
begin
  if to_regclass('public._rollback_property_access_07') is null or to_regclass('public._rollback_access_secrets_07') is null then
    raise exception 'Nothing to roll back: the _rollback_*_07 tables do not exist (07 was not run, or they were dropped).';
  end if;
end $$;

drop trigger if exists property_access_distinct on public.property_access;
drop trigger if exists access_secrets_distinct on public.access_secrets;
drop function if exists public._codes_distinct();
alter table public.property_access drop constraint if exists code_is_4_digits;
alter table public.access_secrets  drop constraint if exists master_is_4_digits;
drop index if exists public.property_access_code_uq;

update public.property_access a set code = b.code, updated_at = now()
  from public._rollback_property_access_07 b where b.property_id = a.property_id;
update public.property_access set code = public.gen_code(10, 5), updated_at = now() where code ~ '^[0-9]{4}$';
update public.access_secrets s set value = b.value, updated_at = now()
  from public._rollback_access_secrets_07 b where s.key = 'master_code' and b.key = 'master_code';
update public.access_secrets set value = public.gen_code(12, 4), updated_at = now() where key = 'master_code' and value ~ '^[0-9]{4}$';

alter table public.property_access drop constraint if exists code_not_trivial;
alter table public.property_access add constraint code_not_trivial check (length(public.norm_code(code)) >= 6);
alter table public.access_secrets  drop constraint if exists master_min_length;
alter table public.access_secrets  add constraint master_min_length check (key <> 'master_code' or length(public.norm_code(value)) >= 8);

-- the step-1 throttle again: 10 wrong tries in 10 minutes
create or replace function public._check_throttle() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public._client_id();
begin
  if who <> 'unknown'
     and (select count(*) from public.access_attempts where client = who and not ok and at > now() - interval '10 minutes') >= 10 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
end $$;
create or replace function public._log_attempt(good boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.access_attempts (client, ok) values (public._client_id(), good);
  if not good then perform pg_sleep(0.3); end if;
  delete from public.access_attempts where at < now() - interval '1 day';
end $$;
revoke all on function public._check_throttle(), public._log_attempt(boolean) from public, anon, authenticated;
drop table if exists public.access_lockouts;

drop function if exists public.admin_set_code(bigint, text), public.admin_regenerate_code(bigint),
                        public.admin_set_master(text), public.admin_regenerate_master(),
                        public._new_code4(text), public._rand4();
commit;
