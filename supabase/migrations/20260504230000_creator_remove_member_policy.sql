-- Allow list creators to remove other members from their own list.
-- Self-leave remains allowed via the existing policy.

drop policy if exists room_members_delete on public.room_members;

create policy room_members_delete on public.room_members
  for delete using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.rooms r
      where r.id = room_members.room_id
        and r.creator_user_id = auth.uid()
        and room_members.user_id <> auth.uid()
    )
  );

grant delete on table public.room_members to authenticated;
