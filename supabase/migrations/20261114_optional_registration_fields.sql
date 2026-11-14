-- Make participant registration number, department, batch, and participation type optional.
-- Apply this migration once to an existing Supabase project.
alter table public.participants
  alter column reg drop not null,
  alter column department drop not null,
  alter column batch drop not null,
  alter column participation_type drop not null;

alter table public.competition_registrations
  alter column registration_number drop not null,
  alter column department drop not null,
  alter column batch drop not null,
  alter column participation_type drop not null;
