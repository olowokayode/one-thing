-- =============================================================
-- One Thing, Postgres / Supabase schema
-- Only the tables where the PRD's guarantees are actually enforced.
-- Every constraint below exists because something in the spec breaks
-- without it. Cross-references are to PRD-cracks-and-fixes.md.
-- =============================================================

create extension if not exists "pgcrypto";

-- ---------- profiles ----------
-- Crack 30: §69 lists both `users` and `profiles`. With Supabase Auth there is
-- one identity table (auth.users) and profiles hangs off it.
create table profiles (
  id                 uuid primary key references auth.users on delete cascade,
  timezone           text not null default 'UTC',   -- IANA name, not an offset
  prev_timezone      text,                          -- crack 3: bridging a flight east
  day_start_hour     smallint not null default 0 check (day_start_hour between 0 and 6),
  interests          text[] not null default '{}',
  subtopics          text[] not null default '{}',
  difficulty         text not null default 'Balanced'
                       check (difficulty in ('Beginner','Balanced','Challenging')),
  duration_minutes   smallint not null default 10 check (duration_minutes in (5,10,15)),
  reminder_slot      text check (reminder_slot in ('morning','afternoon','evening','exact')),
  reminder_at        time,
  birth_year         smallint,                      -- crack 23: age gate
  created_at         timestamptz not null default now()
);

-- Local date for a user, honouring the configurable day boundary.
-- Crack 5: never derive a day by subtracting milliseconds.
create or replace function user_local_date(p_user uuid, p_at timestamptz default now())
returns date language sql stable as $$
  select ((p_at at time zone coalesce(p.timezone,'UTC'))
          - make_interval(hours => p.day_start_hour))::date
  from profiles p where p.id = p_user;
$$;

-- ---------- content ----------
create table content (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  blurb             text,
  source_url        text not null,
  source_name       text,
  authors           text[],
  publication_date  date,
  doi               text,
  -- Crack 19: a binary "open access" flag is not a rights model. Store the
  -- licence, and derive permission from an allowlist.
  license           text not null,
  access_status     text not null,
  rights_action     text not null default 'metadata_only'
                      check (rights_action in ('transform_ok','metadata_only','excluded')),
  topic             text not null,
  subtopic          text,
  difficulty        text not null check (difficulty in ('Beginner','Balanced','Challenging')),
  estimated_minutes smallint not null check (estimated_minutes in (5,10,15)),
  quality_score     numeric(5,2) not null,
  evergreen         boolean not null default false,
  -- Crack 2: cards are public; quiz answers live in a separate column that no
  -- client-facing view is ever allowed to select.
  cards             jsonb not null,
  quiz_public       jsonb not null,   -- questions and options only
  quiz_answers      jsonb not null,   -- correct index + explanation. Server only.
  uncertainty_note  text,             -- §43: where the finding is contested
  transform_version int not null default 1,  -- crack 20: reprocess on model change
  validation_status text not null default 'pending'
                      check (validation_status in ('pending','quarantined','approved','rejected')),
  status            text not null default 'draft'
                      check (status in ('draft','approved','retired')),
  created_at        timestamptz not null default now()
);
create unique index content_doi_uniq on content (doi) where doi is not null;
create index content_pool_idx on content (status, topic, difficulty, estimated_minutes)
  where status = 'approved';

-- Crack 2, enforced structurally: this is the only shape the client may read.
create view content_client as
  select id, title, blurb, source_url, source_name, authors, publication_date,
         doi, license, access_status, rights_action, topic, subtopic, difficulty,
         estimated_minutes, cards, quiz_public, uncertainty_note
  from content where status = 'approved';

-- ---------- daily assignment ----------
create table daily_learning (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles on delete cascade,
  content_id     uuid not null references content,
  local_date     date not null,
  -- Crack 3: frozen at assignment time so a later timezone change cannot
  -- retroactively move a day that has already been handed out.
  tz_snapshot    text not null,
  day_start_hour smallint not null default 0,
  status         text not null default 'assigned'
                   check (status in ('assigned','started','completed')),
  rec_tier       smallint not null default 0,   -- 0 interest … 4 revisit
  rec_confidence numeric(4,3),
  rec_reasons    text[],                        -- surfaced as "why this one?"
  assigned_at    timestamptz not null default now(),
  started_at     timestamptz,                   -- crack 4: server-witnessed start
  completed_at   timestamptz,
  quiz_score     numeric(4,3),
  xp_earned      int not null default 0,
  reflection     text,
  -- §15. The single constraint the whole product rests on.
  constraint one_per_day unique (user_id, local_date)
);

-- Crack 1. The most dangerous finding: without the date predicate, a user can
-- read their own pre-generated future rows straight through PostgREST, and
-- §17 is violated without the API being touched.
alter table daily_learning enable row level security;
create policy dl_select_own_past on daily_learning for select
  using (user_id = auth.uid() and local_date <= user_local_date(auth.uid()));
-- Writes go through security-definer functions only. Nothing is granted here.

-- Crack 10: the only safe way to open a day under concurrency.
create or replace function open_today(p_user uuid, p_content uuid, p_tier smallint,
                                      p_conf numeric, p_reasons text[])
returns daily_learning language plpgsql security definer as $$
declare d date; r daily_learning;
begin
  select user_local_date(p_user) into d;
  insert into daily_learning (user_id, content_id, local_date, tz_snapshot,
                              day_start_hour, rec_tier, rec_confidence, rec_reasons)
  select p_user, p_content, d, p.timezone, p.day_start_hour, p_tier, p_conf, p_reasons
  from profiles p where p.id = p_user
  on conflict (user_id, local_date) do nothing
  returning * into r;
  if r.id is null then
    select * into r from daily_learning where user_id = p_user and local_date = d;
  end if;
  return r;
end $$;

-- ---------- XP ----------
create table xp_transactions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles on delete cascade,
  amount         int not null,
  reason         text not null,
  reference_type text not null,
  reference_id   uuid not null,
  created_at     timestamptz not null default now(),
  -- Crack 31: §72 stores transactions for an audit trail but never says they
  -- must be unique, so a replayed completion pays twice and the audit trail
  -- faithfully records the fraud.
  constraint xp_once unique (user_id, reason, reference_type, reference_id)
);
create index xp_user_idx on xp_transactions (user_id);

create or replace view user_xp as
  select user_id, sum(amount)::int as xp from xp_transactions group by user_id;

-- Crack 17: bounded, so selecting all 18 interests is not worth 360 XP.
create or replace function first_topic_awards(p_user uuid)
returns int language sql stable as $$
  select count(*)::int from xp_transactions
  where user_id = p_user and reason = 'first_topic';
$$;

-- ---------- streaks ----------
-- Crack 9: this table is a CACHE. Completions in daily_learning are the truth.
create table streaks (
  user_id                   uuid primary key references profiles on delete cascade,
  current_streak            int not null default 0,
  longest_streak            int not null default 0,
  last_completed_local_date date,
  updated_at                timestamptz not null default now()
);

-- Rebuilt nightly, and after any incident. A streak is only alive if the last
-- completion was today or yesterday.
create or replace function recompute_streak(p_user uuid)
returns streaks language plpgsql security definer as $$
declare cur int; lng int; last_d date; today_d date; r streaks;
begin
  select user_local_date(p_user) into today_d;
  with days as (
    select local_date,
           local_date - (row_number() over (order by local_date))::int as grp
    from daily_learning
    where user_id = p_user and status = 'completed'
  ), runs as (
    select grp, count(*)::int as len, max(local_date) as ends
    from days group by grp
  )
  select coalesce(max(len),0),
         coalesce(max(len) filter (where ends = (select max(ends) from runs)),0),
         (select max(ends) from runs)
  into lng, cur, last_d from runs;

  if last_d is null or today_d - last_d > 1 then cur := 0; end if;

  insert into streaks (user_id, current_streak, longest_streak,
                       last_completed_local_date, updated_at)
  values (p_user, cur, lng, last_d, now())
  on conflict (user_id) do update
    set current_streak = excluded.current_streak,
        longest_streak = greatest(streaks.longest_streak, excluded.longest_streak),
        last_completed_local_date = excluded.last_completed_local_date,
        updated_at = now()
  returning * into r;
  return r;
end $$;

-- ---------- supporting tables ----------
create table bookmarks (
  user_id uuid references profiles on delete cascade,
  content_id uuid references content,
  created_at timestamptz not null default now(),
  primary key (user_id, content_id)
);

create table highlights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  content_id uuid not null references content,
  card_index smallint not null,
  sentence_index smallint not null,
  text text not null,
  created_at timestamptz not null default now(),
  unique (user_id, content_id, card_index, sentence_index)
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  -- Crack 12: subscriptions rot. Deleted on 410 Gone rather than retried forever.
  last_success_at timestamptz,
  failure_count int not null default 0,
  created_at timestamptz not null default now()
);

-- Every user-owned table gets the same treatment. daily_learning is the only
-- one that additionally needs the date predicate.
alter table bookmarks          enable row level security;
alter table highlights         enable row level security;
alter table xp_transactions    enable row level security;
alter table streaks            enable row level security;
alter table push_subscriptions enable row level security;
alter table profiles           enable row level security;

create policy own_bookmarks  on bookmarks          for all using (user_id = auth.uid());
create policy own_highlights on highlights         for all using (user_id = auth.uid());
create policy own_xp         on xp_transactions    for select using (user_id = auth.uid());
create policy own_streak     on streaks            for select using (user_id = auth.uid());
create policy own_push       on push_subscriptions for all using (user_id = auth.uid());
create policy own_profile    on profiles           for all using (id = auth.uid());
