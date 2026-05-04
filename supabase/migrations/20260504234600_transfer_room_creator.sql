-- Allow current list creator to transfer ownership to another member.
-- This enables handing over creator controls before removing stale users/devices.

create or replace function public.transfer_room_creator (
  p_room_id uuid,
  p_new_creator_user_id uuid
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  current_creator uuid;
  caller_is_member boolean;
  current_creator_is_member boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_new_creator_user_id is null then
    raise exception 'new creator is required';
  end if;

  select exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
  ) into caller_is_member;

  if not caller_is_member then
    raise exception 'not a room member';
  end if;

  select creator_user_id
  into current_creator
  from public.rooms
  where id = p_room_id;

  if not found then
    raise exception 'room not found';
  end if;

  -- Normal case: only current creator can transfer.
  -- Recovery case: if creator is not on this list anymore, any current member can claim/transfer.
  if current_creator is not null and current_creator <> auth.uid() then
    select exists (
      select 1
      from public.room_members rm
      where rm.room_id = p_room_id
        and rm.user_id = current_creator
    ) into current_creator_is_member;

    if current_creator_is_member then
      raise exception 'only the list creator can transfer creator controls';
    end if;
  end if;

  if not exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = p_new_creator_user_id
  ) then
    raise exception 'new creator must already be on this list';
  end if;

  update public.rooms
  set creator_user_id = p_new_creator_user_id
  where id = p_room_id;

  return p_new_creator_user_id;
end;
$$;

grant execute on function public.transfer_room_creator (uuid, uuid) to authenticated;
