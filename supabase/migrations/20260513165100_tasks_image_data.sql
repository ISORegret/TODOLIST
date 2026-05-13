-- Allow optional inline image attachments on tasks.
-- Data is stored as a compressed data URL generated client-side.

alter table public.tasks
  add column if not exists image_data text;
