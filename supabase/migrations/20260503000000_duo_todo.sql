-- Duo Todo: rooms, members, tasks. Anonymous Supabase Auth + RLS.
-- After applying: Dashboard → Authentication → Providers → enable Anonymous sign-ins.
-- Realtime: ensure "tasks" is in publication (statement below).

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null default '',
  primary key (room_id, user_id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  text text not null,
  created_by text not null,
  assigned_to text,
  done boolean not null default false,
  done_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_room_id_idx on public.tasks (room_id);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.tasks enable row level security;

-- Rooms: visible to members
create policy rooms_select on public.rooms
  for select using (
    exists (
      select 1 from public.room_members m
      where m.room_id = rooms.id and m.user_id = auth.uid()
    )
  );

-- Members: see everyone in the same rooms you belong to
create policy room_members_select on public.room_members
  for select using (
    exists (
      select 1 from public.room_members m
      where m.room_id = room_members.room_id and m.user_id = auth.uid()
    )
  );

create policy room_members_update on public.room_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Tasks: CRUD only if room member
create policy tasks_select on public.tasks
  for select using (
    exists (
      select 1 from public.room_members m
      where m.room_id = tasks.room_id and m.user_id = auth.uid()
    )
  );

create policy tasks_insert on public.tasks
  for insert with check (
    exists (
      select 1 from public.room_members m
      where m.room_id = tasks.room_id and m.user_id = auth.uid()
    )
  );

create policy tasks_update on public.tasks
  for update using (
    exists (
      select 1 from public.room_members m
      where m.room_id = tasks.room_id and m.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.room_members m
      where m.room_id = tasks.room_id and m.user_id = auth.uid()
    )
  );

create policy tasks_delete on public.tasks
  for delete using (
    exists (
      select 1 from public.room_members m
      where m.room_id = tasks.room_id and m.user_id = auth.uid()
    )
  );

-- Create room (caller becomes first member)
create or replace function public.create_room ()
  returns table (room_id uuid, join_code text)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  r_id uuid;
  r_code text;
  attempts int := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  loop
    r_code := upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6));
    begin
      insert into public.rooms (join_code) values (r_code) returning id into r_id;
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts > 25 then
        raise exception 'could not allocate room code';
      end if;
    end;
  end loop;

  insert into public.room_members (room_id, user_id, display_name)
  values (r_id, auth.uid(), '');

  return query select r_id, r_code;
end;
$$;

-- Join existing room by code
create or replace function public.join_room (p_code text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  r_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select id into r_id
  from public.rooms
  where join_code = upper(trim(p_code));

  if r_id is null then
    raise exception 'invalid code';
  end if;

  insert into public.room_members (room_id, user_id, display_name)
  values (r_id, auth.uid(), '')
  on conflict (room_id, user_id) do nothing;

  return r_id;
end;
$$;

grant execute on function public.create_room () to authenticated;
grant execute on function public.join_room (text) to authenticated;

revoke insert on table public.room_members from authenticated;
revoke insert on table public.room_members from anon;

alter publication supabase_realtime add table public.tasks;
