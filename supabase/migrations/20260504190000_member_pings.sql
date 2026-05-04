-- Member ping events: click a person to notify them.

create table if not exists public.member_pings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  from_user_id uuid not null references auth.users (id) on delete cascade,
  to_user_id uuid not null references auth.users (id) on delete cascade,
  from_name text not null,
  message text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists member_pings_room_created_idx
  on public.member_pings (room_id, created_at desc);

alter table public.member_pings enable row level security;

drop policy if exists member_pings_select on public.member_pings;
drop policy if exists member_pings_insert on public.member_pings;

create policy member_pings_select on public.member_pings
  for select using (public.is_room_member (room_id));

create policy member_pings_insert on public.member_pings
  for insert with check (
    public.is_room_member (room_id)
    and from_user_id = auth.uid()
    and from_user_id <> to_user_id
  );

grant select, insert on table public.member_pings to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'member_pings'
  ) then
    alter publication supabase_realtime add table public.member_pings;
  end if;
end $$;
