-- Keep account creation separate from competition registration.
-- Existing registrations are preserved; this only changes new signups and joins.

-- Participants are competition entries. One account can have an entry in more than
-- one competition, so identity fields must not be globally unique in this table.
alter table public.participants drop constraint if exists participants_user_id_key;
alter table public.participants drop constraint if exists participants_email_key;
alter table public.participants drop constraint if exists participants_reg_key;
alter table public.participants alter column reg drop not null;
alter table public.participants alter column department drop not null;
alter table public.participants alter column batch drop not null;
alter table public.participants alter column participation_type drop not null;
alter table public.competition_registrations alter column registration_number drop not null;
alter table public.competition_registrations alter column department drop not null;
alter table public.competition_registrations alter column batch drop not null;
alter table public.competition_registrations alter column participation_type drop not null;

alter table public.competition_registrations
  add column if not exists participant_name text not null default '',
  add column if not exists email text not null default '',
  add column if not exists phone text not null default '';

create or replace function public.create_competition_profile()
returns trigger language plpgsql security definer set search_path=public
as $$
declare metadata jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb); target_competition uuid;
begin
  insert into public.profiles(id,full_name)
  values(new.id,coalesce(nullif(metadata->>'full_name',''),nullif(metadata->>'name',''),split_part(new.email,'@',1)))
  on conflict(id) do nothing;

  -- No competition ID means account-only signup. Do not create a participant
  -- row or silently attach the user to the first competition.
  target_competition := nullif(metadata->>'competition_id','')::uuid;
  if target_competition is not null then
    if not exists(select 1 from public.competitions c where c.id=target_competition
      and c.registration_open and c.status in ('upcoming','active')
      and (c.registration_deadline is null or now()<=c.registration_deadline)) then
      raise exception 'This competition is not accepting registrations';
    end if;

    insert into public.participants(
      user_id,name,reg,email,phone,department,semester,batch,participation_type,team,member,
      university_name,competition_id
    ) values(
      new.id,coalesce(nullif(metadata->>'name',''),split_part(new.email,'@',1)),
      nullif(metadata->>'reg',''),new.email,coalesce(metadata->>'phone',''),
      nullif(metadata->>'department',''),nullif(metadata->>'semester',''),nullif(metadata->>'batch',''),
      coalesce(nullif(metadata->>'type',''),'Individual'),nullif(metadata->>'team',''),
      jsonb_build_object('memberName',metadata->>'memberName','memberReg',metadata->>'memberReg',
        'memberEmail',metadata->>'memberEmail','memberPhone',metadata->>'memberPhone'),
      coalesce(nullif(metadata->>'university',''),'COMSATS University Islamabad, Vehari Campus'),target_competition
    ) on conflict do nothing;

    insert into public.competition_registrations(
      competition_id,user_id,registration_number,university_name,department,batch,semester,
      participation_type,team_name,member_details,participant_name,email,phone
    ) values(
      target_competition,new.id,nullif(metadata->>'reg',''),
      coalesce(nullif(metadata->>'university',''),'COMSATS University Islamabad, Vehari Campus'),
      nullif(metadata->>'department',''),nullif(metadata->>'batch',''),nullif(metadata->>'semester',''),
      coalesce(nullif(metadata->>'type',''),'Individual'),nullif(metadata->>'team',''),
      jsonb_build_object('memberName',metadata->>'memberName','memberReg',metadata->>'memberReg',
        'memberEmail',metadata->>'memberEmail','memberPhone',metadata->>'memberPhone'),
      coalesce(nullif(metadata->>'name',''),split_part(new.email,'@',1)),new.email,coalesce(metadata->>'phone','')
    ) on conflict(competition_id,user_id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_two_competitions()
returns trigger language plpgsql security definer set search_path=public
as $$
declare deadline timestamptz; status_value text; is_open boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
  if nullif(new.registration_number,'') is not null then
    perform pg_advisory_xact_lock(hashtextextended(lower(new.registration_number),1));
  end if;
  select registration_deadline,status,registration_open into deadline,status_value,is_open
    from public.competitions where id=new.competition_id;
  if status_value is null or status_value in ('draft','completed','archived') or not is_open then
    raise exception 'This competition is not accepting registrations';
  end if;
  if deadline is not null and now()>deadline then raise exception 'Registration has closed'; end if;
  if exists(select 1 from public.competition_registrations r where r.competition_id=new.competition_id and r.user_id=new.user_id) then
    raise exception 'This account is already registered for this competition';
  end if;
  if nullif(new.registration_number,'') is not null and exists(
    select 1 from public.competition_registrations r where r.competition_id=new.competition_id
      and lower(r.registration_number)=lower(new.registration_number)) then
    raise exception 'This registration number is already used in this competition';
  end if;
  if (select count(*) from public.competition_registrations r where r.user_id=new.user_id)>=2 then
    raise exception 'A participant may join at most two competitions';
  end if;
  if nullif(new.registration_number,'') is not null and exists(
    select 1 from public.competition_registrations r where lower(r.registration_number)=lower(new.registration_number)
      and r.user_id<>new.user_id) then
    raise exception 'This registration number belongs to another account';
  end if;
  return new;
end;
$$;

create or replace function public.register_for_competition(
  p_competition_id uuid,
  p_registration_number text,
  p_university_name text,
  p_department text,
  p_semester text,
  p_batch text,
  p_participation_type text,
  p_team_name text,
  p_member_details jsonb
)
returns uuid language plpgsql security definer set search_path=public
as $$
declare actor uuid := auth.uid(); account_email text; account_name text; account_phone text; participant_id uuid;
begin
  if actor is null then raise exception 'Log in before joining a competition'; end if;
  select email,coalesce(nullif(raw_user_meta_data->>'name',''),nullif(raw_user_meta_data->>'full_name',''),split_part(email,'@',1)),
    coalesce(raw_user_meta_data->>'phone','') into account_email,account_name,account_phone
  from auth.users where id=actor;
  if account_email is null then raise exception 'Account not found'; end if;

  insert into public.competition_registrations(
    competition_id,user_id,registration_number,university_name,department,batch,semester,
    participation_type,team_name,member_details,participant_name,email,phone
  ) values(
    p_competition_id,actor,nullif(p_registration_number,''),coalesce(nullif(p_university_name,''),'COMSATS University Islamabad, Vehari Campus'),
    nullif(p_department,''),nullif(p_batch,''),coalesce(nullif(p_semester,''),''),
    coalesce(nullif(p_participation_type,''),'Individual'),nullif(p_team_name,''),coalesce(p_member_details,'{}'::jsonb),
    account_name,account_email,account_phone
  ) returning id into participant_id;

  insert into public.participants(
    user_id,name,reg,email,phone,department,semester,batch,participation_type,team,member,university_name,competition_id
  ) values(
    actor,account_name,nullif(p_registration_number,''),account_email,account_phone,nullif(p_department,''),
    nullif(p_semester,''),nullif(p_batch,''),coalesce(nullif(p_participation_type,''),'Individual'),
    nullif(p_team_name,''),coalesce(p_member_details,'{}'::jsonb),
    coalesce(nullif(p_university_name,''),'COMSATS University Islamabad, Vehari Campus'),p_competition_id
  ) returning id into participant_id;
  return participant_id;
end;
$$;
revoke all on function public.register_for_competition(uuid,text,text,text,text,text,text,text,jsonb) from public;
grant execute on function public.register_for_competition(uuid,text,text,text,text,text,text,text,jsonb) to authenticated;

-- Make the new RPC signature visible to Supabase's PostgREST API promptly.
notify pgrst, 'reload schema';
