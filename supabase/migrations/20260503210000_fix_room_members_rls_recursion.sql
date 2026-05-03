-- Fix: "infinite recursion detected in policy for relation 'room_members'"
-- The old room_members SELECT policy queried room_members again under RLS.

create or replace function public.is_room_member (p_room_id uuid)
  returns boolean
  language sql
  security definer
  set search_path = public
  stable
as $$
  select exists (
    select 1 from public.room_members rm
    where rm.room_id = p_room_id and rm.user_id = auth.uid()
  );
$$;

revoke all on function public.is_room_member (uuid) from public;
grant execute on function public.is_room_member (uuid) to authenticated;

drop policy if exists rooms_select on public.rooms;
drop policy if exists room_members_select on public.room_members;
drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;

create policy rooms_select on public.rooms
  for select using (public.is_room_member (id));

create policy room_members_select on public.room_members
  for select using (public.is_room_member (room_id));

create policy tasks_select on public.tasks
  for select using (public.is_room_member (room_id));

create policy tasks_insert on public.tasks
  for insert with check (public.is_room_member (room_id));

create policy tasks_update on public.tasks
  for update using (public.is_room_member (room_id))
  with check (public.is_room_member (room_id));

create policy tasks_delete on public.tasks
  for delete using (public.is_room_member (room_id));
