-- Allow registration number, batch, and semester to be omitted during competition registration.
-- This only relaxes NOT NULL constraints; existing registration data is preserved.
alter table public.participants
  alter column reg drop not null,
  alter column batch drop not null,
  alter column semester drop not null;

alter table public.competition_registrations
  alter column registration_number drop not null,
  alter column batch drop not null,
  alter column semester drop not null;