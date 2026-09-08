-- ONE THING — Security hardening migration
-- Run this in: supabase.com/dashboard/project/udsfrbmjmdlesumbnfpx/sql

-- ── 1. CRITICAL: Enable RLS on content table ──────────────────
alter table public.content enable row level security;

create policy "public_read_approved"
  on public.content for select
  using (status = 'approved');

create policy "service_write_content"
  on public.content for all
  using (auth.role() = 'service_role');

-- ── 2. Fix SECURITY DEFINER views → SECURITY INVOKER ─────────
drop view if exists public.content_client;
create view public.content_client
  with (security_invoker = true) as
  select id, title, blurb, source_url, source_name, authors,
         publication_date, doi, license, access_status, rights_action,
         topic, subtopic, difficulty, estimated_minutes,
         cards, quiz_public, uncertainty_note
  from public.content where status = 'approved';

drop view if exists public.user_xp;
create view public.user_xp
  with (security_invoker = true) as
  select user_id, sum(amount)::int as xp
  from public.xp_transactions group by user_id;

-- ── 3. Fix mutable search_path on all functions ───────────────
create or replace function public.user_local_date(p_user uuid, p_at timestamptz default now())
returns date language sql stable set search_path = public as $$
  select ((p_at at time zone coalesce(p.timezone,'UTC'))
          - make_interval(hours => p.day_start_hour))::date
  from profiles p where p.id = p_user;
$$;

create or replace function public.first_topic_awards(p_user uuid)
returns int language sql stable set search_path = public as $$
  select count(*)::int from xp_transactions
  where user_id = p_user and reason = 'first_topic';
$$;

create or replace function public.recompute_streak(p_user uuid)
returns streaks language plpgsql security definer set search_path = public as $$
declare cur int; lng int; last_d date; today_d date; r streaks;
begin
  select user_local_date(p_user) into today_d;
  with days as (
    select local_date,
           local_date - (row_number() over (order by local_date))::int as grp
    from daily_learning where user_id = p_user and status = 'completed'
  ), runs as (
    select grp, count(*)::int as len, max(local_date) as ends
    from days group by grp
  )
  select coalesce(max(len),0),
         coalesce(max(len) filter (where ends=(select max(ends) from runs)),0),
         (select max(ends) from runs)
  into lng, cur, last_d from runs;
  if last_d is null or today_d - last_d > 1 then cur := 0; end if;
  insert into streaks(user_id,current_streak,longest_streak,last_completed_local_date,updated_at)
  values(p_user,cur,lng,last_d,now())
  on conflict(user_id) do update set
    current_streak=excluded.current_streak,
    longest_streak=greatest(streaks.longest_streak,excluded.longest_streak),
    last_completed_local_date=excluded.last_completed_local_date,
    updated_at=now()
  returning * into r;
  return r;
end $$;

create or replace function public.open_today(p_user uuid, p_content uuid,
  p_tier smallint, p_conf numeric, p_reasons text[])
returns daily_learning language plpgsql security definer set search_path = public as $$
declare d date; r daily_learning;
begin
  if p_user != auth.uid() then raise exception 'Unauthorized'; end if;
  select user_local_date(p_user) into d;
  insert into daily_learning(user_id,content_id,local_date,tz_snapshot,
                             day_start_hour,rec_tier,rec_confidence,rec_reasons)
  select p_user,p_content,d,p.timezone,p.day_start_hour,p_tier,p_conf,p_reasons
  from profiles p where p.id=p_user
  on conflict(user_id,local_date) do nothing returning * into r;
  if r.id is null then
    select * into r from daily_learning where user_id=p_user and local_date=d;
  end if;
  return r;
end $$;

-- ── 4. Revoke anon access to sensitive functions ──────────────
revoke execute on function public.open_today(uuid,uuid,smallint,numeric,text[]) from anon;
revoke execute on function public.recompute_streak(uuid) from anon;
grant  execute on function public.open_today(uuid,uuid,smallint,numeric,text[]) to authenticated;
grant  execute on function public.recompute_streak(uuid) to authenticated;

-- ── 5. Input validation constraints ──────────────────────────
alter table public.profiles
  drop constraint if exists profiles_timezone_check;
alter table public.profiles
  add constraint profiles_timezone_check check (char_length(timezone) <= 64);

alter table public.highlights
  drop constraint if exists highlights_text_length;
alter table public.highlights
  add constraint highlights_text_length check (char_length(text) <= 2000);

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_name='profiles' and column_name='name'
  ) then
    alter table public.profiles add column name text check (char_length(name) <= 100);
  else
    alter table public.profiles drop constraint if exists profiles_name_length;
    alter table public.profiles add constraint profiles_name_length check (char_length(name) <= 100);
  end if;
end $$;
