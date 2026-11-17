-- Safe incremental fixes for participant operations, competition-scoped timers,
-- private participant uploads, role changes, and announcement visibility.
-- Existing competitions and announcements remain in place and visible by default.

alter table public.competitions
  add column if not exists duration_minutes integer not null default 120
  check (duration_minutes between 1 and 240);

alter table public.competition_announcements
  add column if not exists visible_to_participants boolean not null default true;

-- Keep the existing catalog view's column contract intact. PostgreSQL cannot
-- remove or reorder columns with CREATE OR REPLACE VIEW; expose duration using
-- a separate safe view instead.
create or replace view public.public_competition_durations with (security_barrier=true) as
select id,duration_minutes from public.competitions where status <> 'draft';
grant select on public.public_competition_durations to anon,authenticated;

-- Only the oldest admin (the installation's main admin) can never be demoted;
-- admins cannot change their own role or promote another account beyond the
-- roles supported by this application.
create or replace function public.admin_set_profile_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path=public
as $$
declare main_admin uuid;
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  if p_role not in ('participant','admin') then raise exception 'Unsupported account role'; end if;
  if p_user_id=auth.uid() then raise exception 'You cannot change your own role'; end if;
  select id into main_admin from public.profiles where role='admin' order by created_at,id limit 1;
  if p_user_id=main_admin then raise exception 'The main administrator role is protected'; end if;
  update public.profiles set role=p_role where id=p_user_id;
  if not found then raise exception 'Account profile not found'; end if;
end;
$$;
revoke all on function public.admin_set_profile_role(uuid,text) from public;
grant execute on function public.admin_set_profile_role(uuid,text) to authenticated;

-- Prevent direct profile updates from changing role fields; role changes go
-- through the checked RPC above.
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create or replace function public.admin_remove_competition_participant(p_id uuid)
returns void language plpgsql security definer set search_path=public
as $$
declare participant_row public.participants;
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  select * into participant_row from public.participants where id=p_id for update;
  if not found then raise exception 'Competition registration not found'; end if;
  -- The normalized submission/winner records cascade from the registration;
  -- the auth account and the user's other competition entries are retained.
  delete from public.competition_registrations
   where competition_id=participant_row.competition_id and user_id=participant_row.user_id;
  delete from public.participants where id=participant_row.id;
end;
$$;
revoke all on function public.admin_remove_competition_participant(uuid) from public;
grant execute on function public.admin_remove_competition_participant(uuid) to authenticated;

-- The participant row is the competition-specific registration and therefore
-- owns its timer. Duration is taken from that competition, with legacy fallback.
create or replace function public.start_competition_timer(p_id uuid)
returns timestamptz language plpgsql security definer set search_path=public
as $$
declare started timestamptz; submitted timestamptz;
begin
  update public.participants set started_at=coalesce(started_at,now()),updated_at=now()
   where id=p_id and user_id=auth.uid()
   returning started_at,submitted_at into started,submitted;
  if started is null then raise exception 'Participant registration not found'; end if;
  if submitted is not null then raise exception 'This competition entry has already been submitted'; end if;
  return started;
end;
$$;
revoke all on function public.start_competition_timer(uuid) from public;
grant execute on function public.start_competition_timer(uuid) to authenticated;

create or replace function public.save_competition_submission_draft(
  p_id uuid,p_project text,p_description text,p_technologies text,p_api_details text,
  p_github text,p_live text,p_drive text
) returns public.participants language plpgsql security definer set search_path=public
as $$
declare row_data public.participants; duration integer; api_line text;
begin
  select * into row_data from public.participants where id=p_id and user_id=auth.uid() for update;
  if row_data.id is null then raise exception 'Participant registration not found'; end if;
  select coalesce(c.duration_minutes,s.duration_minutes) into duration
   from public.competition_settings s left join public.competitions c on c.id=row_data.competition_id where s.id=1;
  if row_data.started_at is not null and now()>row_data.started_at+make_interval(mins=>duration) then raise exception 'The submission deadline has passed'; end if;
  if coalesce(p_github,'')<>'' and p_github !~* '^https?://' then raise exception 'GitHub link must use HTTP or HTTPS'; end if;
  if coalesce(p_live,'')<>'' and p_live !~* '^https?://' then raise exception 'Live link must use HTTP or HTTPS'; end if;
  if coalesce(p_drive,'')<>'' and p_drive !~* '^https?://' then raise exception 'Drive link must use HTTP or HTTPS'; end if;
  foreach api_line in array string_to_array(coalesce(p_api_details,''),E'\n') loop
    if btrim(api_line)<>'' and (position('|' in api_line)=0 or btrim(split_part(api_line,'|',1))='' or btrim(split_part(api_line,'|',2)) !~* '^https?://') then
      raise exception 'Each external API must include a name and HTTP or HTTPS URL';
    end if;
  end loop;
  update public.participants set project=nullif(btrim(coalesce(p_project,'')),''),project_description=coalesce(p_description,''),
    technologies=coalesce(p_technologies,''),api_details=coalesce(p_api_details,''),github_url=nullif(p_github,''),
    live_url=nullif(p_live,''),drive_url=nullif(p_drive,''),updated_at=now()
   where id=p_id returning * into row_data;
  return row_data;
end;
$$;
revoke all on function public.save_competition_submission_draft(uuid,text,text,text,text,text,text,text) from public;
grant execute on function public.save_competition_submission_draft(uuid,text,text,text,text,text,text,text) to authenticated;

create or replace function public.submit_competition_project(
  p_id uuid,p_project text,p_description text,p_technologies text,p_api_details text,
  p_github text,p_live text,p_drive text
) returns public.participants language plpgsql security definer set search_path=public
as $$
declare current_row public.participants; duration integer; api_line text;
begin
  select * into current_row from public.participants where id=p_id and user_id=auth.uid() for update;
  if current_row.id is null then raise exception 'Participant registration not found'; end if;
  if current_row.started_at is null then raise exception 'Start the competition timer before submitting'; end if;
  select coalesce(c.duration_minutes,s.duration_minutes) into duration
   from public.competition_settings s left join public.competitions c on c.id=current_row.competition_id where s.id=1;
  if now()>current_row.started_at+make_interval(mins=>duration) then raise exception 'The submission deadline has passed'; end if;
  if length(btrim(coalesce(p_project,'')))<2 then raise exception 'Enter a project name'; end if;
  if coalesce(p_github,'') !~* '^https?://' or coalesce(p_live,'') !~* '^https?://' then
    raise exception 'GitHub and live links must use HTTP or HTTPS';
  end if;
  if coalesce(p_drive,'')<>'' and p_drive !~* '^https?://' then raise exception 'Drive link must use HTTP or HTTPS';
  end if;
  foreach api_line in array string_to_array(coalesce(p_api_details,''),E'\n') loop
    if btrim(api_line)<>'' and (position('|' in api_line)=0 or btrim(split_part(api_line,'|',1))='' or btrim(split_part(api_line,'|',2)) !~* '^https?://') then
      raise exception 'Each external API must include a name and HTTP or HTTPS URL';
    end if;
  end loop;
  update public.participants set project=btrim(p_project),github_url=p_github,live_url=p_live,drive_url=p_drive,
    project_description=coalesce(p_description,''),technologies=coalesce(p_technologies,''),api_details=coalesce(p_api_details,''),
    submitted_at=now(),updated_at=now() where id=p_id returning * into current_row;
  return current_row;
end;
$$;
revoke all on function public.submit_competition_project(uuid,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_competition_project(uuid,text,text,text,text,text,text,text) to authenticated;

-- A participant can read their own uploaded files plus organizer-provided
-- registered files for their competition. Other participants' uploads remain private.
drop policy if exists "registered participant read competition files" on storage.objects;
create policy "registered participant read competition files" on storage.objects for select to authenticated
 using (bucket_id='competition-files' and (
   public.is_competition_admin()
   or exists(select 1 from public.competition_resources r join public.participants p on p.id=r.participant_id
      where r.storage_path=name and r.enabled and p.user_id=auth.uid())
   or exists(select 1 from public.competition_resources r join public.participants p on p.competition_id=r.competition_id
      where r.storage_path=name and r.participant_id is null and r.visibility='registered' and r.enabled and p.user_id=auth.uid())
   or exists(select 1 from public.competition_resources r
      where r.storage_path=name and r.participant_id is null and r.visibility='public' and r.enabled)
 ));

-- Admins can explicitly hide/restore a previously sent announcement without
-- deleting its history or changing any announcement automatically.
create or replace function public.admin_set_announcement_visibility(p_id uuid,p_visible boolean)
returns void language plpgsql security definer set search_path=public
as $$
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  update public.competition_announcements set visible_to_participants=p_visible where id=p_id;
  if not found then raise exception 'Announcement not found'; end if;
end;
$$;
revoke all on function public.admin_set_announcement_visibility(uuid,boolean) from public;
grant execute on function public.admin_set_announcement_visibility(uuid,boolean) to authenticated;

create or replace function public.authorized_competition_details(p_competition_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public
as $$
declare result jsonb;
begin
  if not public.is_competition_admin() and not exists(
    select 1 from public.competition_registrations r where r.competition_id=p_competition_id and r.user_id=auth.uid()
    union all select 1 from public.participants p where p.competition_id=p_competition_id and p.user_id=auth.uid()
  ) then raise exception 'Register for this competition to view its private details'; end if;
  select jsonb_build_object(
    'id',c.id,'title',c.title,'short_description',c.short_description,'detailed_description',c.detailed_description,
    'university_name',c.university_name,'department',c.department,'rules_html',c.rules_html,'task_html',c.task_html,
    'task',c.task,'submission_instructions',c.submission_instructions,'required_technologies',c.required_technologies,
    'duration_minutes',c.duration_minutes,'starts_at',c.starts_at,'ends_at',c.ends_at,'registration_deadline',c.registration_deadline,
    'status',c.status,'drive_upload_url',c.drive_upload_url,'drive_enabled',c.drive_enabled,'results_announced',c.results_announced,
    'announcements',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'subject',a.subject,'body',a.body,'created_at',a.created_at) order by a.created_at desc)
      from public.competition_announcements a where a.competition_id=c.id and a.visible_to_participants and exists(
        select 1 from public.email_delivery_logs l where l.announcement_id=a.id and l.status in ('sent','delivered'))),'[]'::jsonb),
    'winners',coalesce((select jsonb_agg(jsonb_build_object('position',w.placement,'name',coalesce(p.team,p.name),'project',p.project) order by w.placement)
      from public.competition_winners w join public.competition_registrations r on r.id=w.registration_id
      left join public.participants p on p.user_id=r.user_id and p.competition_id=r.competition_id
      where w.competition_id=c.id and w.announced_at is not null),'[]'::jsonb)
  ) into result from public.competitions c where c.id=p_competition_id;
  if result is null then raise exception 'Competition not found'; end if;
  return result;
end;
$$;
revoke all on function public.authorized_competition_details(uuid) from public;
grant execute on function public.authorized_competition_details(uuid) to authenticated;


-- Enforce the competition-specific deadline on participant-owned file uploads too.
drop policy if exists "participant upload competition resource" on storage.objects;
create policy "participant upload competition resource" on storage.objects for insert to authenticated
  with check (bucket_id='competition-files' and (storage.foldername(name))[2]=auth.uid()::text and exists(
    select 1 from public.participants p where p.user_id=auth.uid() and p.competition_id::text=(storage.foldername(name))[1]
      and p.submitted_at is null
      and (p.started_at is null or now()<=p.started_at+make_interval(mins=>coalesce(
        (select c.duration_minutes from public.competitions c where c.id=p.competition_id),
        (select s.duration_minutes from public.competition_settings s where s.id=1))))
  ));
drop policy if exists "participant delete competition resource file" on storage.objects;
create policy "participant delete competition resource file" on storage.objects for delete to authenticated
  using (bucket_id='competition-files' and (storage.foldername(name))[2]=auth.uid()::text and exists(
    select 1 from public.participants p where p.user_id=auth.uid() and p.competition_id::text=(storage.foldername(name))[1]
      and p.submitted_at is null
      and (p.started_at is null or now()<=p.started_at+make_interval(mins=>coalesce(
        (select c.duration_minutes from public.competitions c where c.id=p.competition_id),
        (select s.duration_minutes from public.competition_settings s where s.id=1))))
  ));


-- Keep participant resource metadata writes on the same per-entry timer as Storage.
create or replace function public.enforce_participant_resource_deadline()
returns trigger language plpgsql security definer set search_path=public
as $$
declare participant_row public.participants; target_participant uuid; entry_duration integer;
begin
  if public.is_competition_admin() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  target_participant := case when tg_op='DELETE' then old.participant_id else new.participant_id end;
  if target_participant is not null then
    select * into participant_row from public.participants where id=target_participant and user_id=auth.uid();
    if participant_row.id is null then raise exception 'Participant resource access denied'; end if;
    select coalesce(c.duration_minutes,s.duration_minutes) into entry_duration
      from public.competition_settings s left join public.competitions c on c.id=participant_row.competition_id where s.id=1;
    if participant_row.submitted_at is not null then raise exception 'This competition entry has already been submitted'; end if;
    if participant_row.started_at is not null and now()>participant_row.started_at+make_interval(mins=>entry_duration) then
      raise exception 'The submission deadline has passed';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
notify pgrst,'reload schema';
