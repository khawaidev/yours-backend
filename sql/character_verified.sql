-- Three-state verified badge for characters.
--   true  -> blue badge with a white tick next to the age (e.g. "Lisa, 29 [tick]")
--   false -> explicitly unverified
--   null  -> never decided; every pre-existing character keeps null and the
--            frontend treats null exactly like false (no badge).
--
-- Safe to re-run: `add column if not exists` leaves an existing column alone,
-- and the column has no default, so rows added by other means stay null until
-- the admin page sets a value.

alter table public.characters
  add column if not exists verified boolean;

comment on column public.characters.verified is
  'Three-state badge: true = verified (blue tick), false = unverified, null = never set (rendered as unverified).';
