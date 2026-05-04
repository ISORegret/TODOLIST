-- List display title + leave list (remove own membership).

alter table public.rooms
  add column if not exists title text not null default '';

-- Any member may set a short display title (does not change join_code).
create or replace function public.set_room_title (p_room_id uuid, p_title text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_room_member (p_room_id) then
    raise exception 'not a member';
  end if;
  update public.rooms
  set title = left(btrim(coalesce(p_title, '')), 48)
  where id = p_room_id;
end;
$$;

revoke all on function public.set_room_title (uuid, text) from public;
grant execute on function public.set_room_title (uuid, text) to authenticated;

drop policy if exists room_members_delete on public.room_members;

create policy room_members_delete on public.room_members
  for delete using (user_id = auth.uid());

grant delete on table public.room_members to authenticated;
