how do -- Onboarding persistence schema for Supabase
-- Run this in the Supabase SQL editor or via psql

create table if not exists customer_onboarding (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  external_id text,
  innovatrics_customer_id text not null unique,
  status text not null default 'IN_PROGRESS',
  retry_count integer not null default 0,
  last_error_code text,
  last_error_message text,
  document_summary jsonb,
  document_pages jsonb,
  inspection jsonb,
  disclosed_inspection jsonb,
  selfie_result jsonb,
  face_comparison jsonb,
  liveness_result jsonb,
  created_at timestamp with time zone not null default timezone('utc', now()),
  updated_at timestamp with time zone not null default timezone('utc', now())
);

create table if not exists onboarding_events (
  id uuid primary key default gen_random_uuid(),
  customer_onboarding_id uuid not null references customer_onboarding(id) on delete cascade,
  type text not null,
  payload jsonb,
  created_at timestamp with time zone not null default timezone('utc', now())
);

create index if not exists idx_onboarding_innovatrics_id
  on customer_onboarding (innovatrics_customer_id);

create index if not exists idx_onboarding_events_customer
  on onboarding_events (customer_onboarding_id);

create trigger set_customer_onboarding_updated_at
  before update on customer_onboarding
  for each row
  execute function trigger_set_timestamp();
