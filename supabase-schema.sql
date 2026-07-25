-- ============================================================
-- SUPABASE SCHEMA — run this in Supabase SQL Editor
-- This is the same schema from the architecture doc, with Row
-- Level Security (RLS) added. RLS is required once this app
-- talks to Supabase from the browser with a public anon key —
-- without it, any user could read/write any other user's deals.
-- ============================================================

-- Supabase gives you an auth.users table for free (email/password,
-- magic link, or OTP). We mirror the id here rather than duplicating
-- auth logic ourselves.
create table users (
  id              uuid primary key references auth.users(id) on delete cascade,
  name            text not null,
  phone           text,
  cea_reg_number  text,
  agency_name     text,
  created_at      timestamptz not null default now()
);

create table deals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  property_address      text not null,
  deal_value_cents      bigint not null,
  commission_percent    numeric(5,2) not null,
  agent_split_percent   numeric(5,2) not null,
  agency_split_percent  numeric(5,2) not null,
  stage                 text not null default 'prospecting'
                          check (stage in ('prospecting','offer_accepted','option_exercised','completed','paid')),
  expected_payout_date  date,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index idx_deals_user_stage on deals(user_id, stage);

create table co_broke_partners (
  id               uuid primary key default gen_random_uuid(),
  deal_id          uuid not null references deals(id) on delete cascade,
  name             text not null,
  cea_reg_number   text,
  split_percent    numeric(5,2) not null,
  created_at       timestamptz not null default now()
);
create unique index idx_one_active_partner_per_deal on co_broke_partners(deal_id);

create table deal_stage_history (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id) on delete cascade,
  stage       text not null,
  changed_at  timestamptz not null default now()
);
create index idx_stage_history_deal on deal_stage_history(deal_id, changed_at);

-- ============================================================
-- ROW LEVEL SECURITY — an agent can only ever see their own rows
-- ============================================================
alter table users enable row level security;
alter table deals enable row level security;
alter table co_broke_partners enable row level security;
alter table deal_stage_history enable row level security;

create policy "users read own row" on users for select using (auth.uid() = id);
create policy "users update own row" on users for update using (auth.uid() = id);
create policy "users insert own row" on users for insert with check (auth.uid() = id);

create policy "agents manage own deals" on deals for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "agents manage own co-broke rows" on co_broke_partners for all
  using (auth.uid() = (select user_id from deals where deals.id = deal_id))
  with check (auth.uid() = (select user_id from deals where deals.id = deal_id));

create policy "agents manage own stage history" on deal_stage_history for all
  using (auth.uid() = (select user_id from deals where deals.id = deal_id))
  with check (auth.uid() = (select user_id from deals where deals.id = deal_id));

-- Keep updated_at honest without relying on the app to set it.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger deals_set_updated_at
  before update on deals
  for each row execute function set_updated_at();

-- Note: subscriptions / billing_events / usage_events tables from the
-- architecture doc are intentionally left out of this file — add them
-- once you wire up Stripe. They don't block the local-first MVP.
