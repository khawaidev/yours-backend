-- Remove the character "verified" badge feature.
--
-- Run this after the frontend and backend have stopped selecting/writing the
-- column, otherwise character reads and writes will fail. Safe to re-run.

alter table public.characters
  drop column if exists verified;
