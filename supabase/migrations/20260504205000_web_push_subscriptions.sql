-- Web push subscriptions for offline/background notifications.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_update on public.push_subscriptions;
drop policy if exists push_subscriptions_delete on public.push_subscriptions;

create policy push_subscriptions_select on public.push_subscriptions
  for select using (user_id = auth.uid());

create policy push_subscriptions_insert on public.push_subscriptions
  for insert with check (user_id = auth.uid());

create policy push_subscriptions_update on public.push_subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy push_subscriptions_delete on public.push_subscriptions
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on table public.push_subscriptions to authenticated;
