-- Track list creator; allow creator to set a custom join code (4–8 alphanumeric).

alter table public.rooms
  add column if not exists creator_user_id uuid references auth.users (id);

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
      insert into public.rooms (join_code, creator_user_id)
      values (r_code, auth.uid())
      returning id into r_id;
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

-- Creator (or lists with no creator set) cannot change code until column backfilled; new lists always have creator.
create or replace function public.change_join_code (p_room_id uuid, p_new_code text)
  returns text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  cr uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception 'room not found';
  end if;

  select creator_user_id into cr from public.rooms where id = p_room_id;

  if cr is null or cr <> auth.uid() then
    raise exception 'only the list creator can change the join code';
  end if;

  v_code := upper(regexp_replace(coalesce(p_new_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(v_code) < 4 or length(v_code) > 8 then
    raise exception 'Use 4–8 letters or numbers only';
  end if;

  update public.rooms set join_code = v_code where id = p_room_id;
  return v_code;
exception
  when unique_violation then
    raise exception 'That code is already taken' using errcode = 'P0001';
end;
$$;

grant execute on function public.change_join_code (uuid, text) to authenticated;
