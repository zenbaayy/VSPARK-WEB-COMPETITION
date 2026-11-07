-- Competition scoped registration and submission workflow.
-- Safe to run more than once. Existing legacy participant rows are copied into
-- the normalized tables; nothing in public.participants is deleted or overwritten.

alter table public.competitions
  add column if not exists duration_minutes integer not null default 120 check (duration_minutes between 1 and 240),
  add column if not exists mode text not null default 'Online',
  add column if not exists registration_open boolean not null default true,
  add column if not exists payment_enabled boolean not null default false,
  add column if not exists payment_amount text,
  add column if not exists payment_instructions text;

alter table public.competition_registrations
  add column if not exists participant_name text not null default '',
  add column if not exists email text not null default '',
  add column if not exists phone text not null default '',
  add column if not exists payment_ref text,
  add column if not exists payment_proof_path text,
  add column if not exists payment_comment text;

-- Populate identity fields on normalized rows created before these columns existed.
update public.competition_registrations r
set participant_name=coalesce(nullif(r.participant_name,''),
      (select nullif(p.name,'') from public.participants p where p.user_id=r.user_id and p.competition_id=r.competition_id limit 1),
      nullif(u.raw_user_meta_data->>'full_name',''),nullif(u.raw_user_meta_data->>'name',''),split_part(u.email,'@',1)),
    email=coalesce(nullif(r.email,''),
      (select nullif(p.email,'') from public.participants p where p.user_id=r.user_id and p.competition_id=r.competition_id limit 1),u.email,''),
    phone=coalesce(nullif(r.phone,''),
      (select nullif(p.phone,'') from public.participants p where p.user_id=r.user_id and p.competition_id=r.competition_id limit 1),
      nullif(u.raw_user_meta_data->>'phone',''), '')
from auth.users u
where u.id=r.user_id and (r.participant_name='' or r.email='' or r.phone='');

alter table public.competition_submissions
  alter column project_title set default '',
  alter column project_title drop not null,
  alter column github_url set default '',
  alter column github_url drop not null,
  alter column live_url set default '',
  alter column live_url drop not null,
  alter column participant_drive_url set default '',
  alter column participant_drive_url drop not null,
  add column if not exists registration_id uuid;

alter table public.competition_resources
  add column if not exists registration_id uuid references public.competition_registrations(id) on delete cascade;

create or replace function public.create_competition_profile()
returns trigger language plpgsql security definer set search_path=public
as $$
declare metadata jsonb := new.raw_user_meta_data; target_competition uuid;
begin
  insert into public.profiles(id,full_name)
  values(new.id,coalesce(metadata->>'full_name',split_part(new.email,'@',1)))
  on conflict(id) do nothing;
  if metadata ? 'reg' then
    target_competition := nullif(metadata->>'competition_id','')::uuid;
    if target_competition is null then raise exception 'Select a competition before registering'; end if;
    if not exists(select 1 from public.competitions c where c.id=target_competition and c.registration_open
      and c.status in ('upcoming','active') and (c.registration_deadline is null or now()<=c.registration_deadline)) then
      raise exception 'This competition is not accepting registrations';
    end if;
    insert into public.participants(
      user_id,name,reg,email,phone,department,semester,batch,participation_type,team,member,
      university_name,competition_id
    ) values(
      new.id,coalesce(metadata->>'name',split_part(new.email,'@',1)),metadata->>'reg',new.email,
      metadata->>'phone',metadata->>'department',metadata->>'semester',metadata->>'batch',
      coalesce(metadata->>'type','Individual'),nullif(metadata->>'team',''),
      jsonb_build_object('memberName',metadata->>'memberName','memberReg',metadata->>'memberReg',
        'memberEmail',metadata->>'memberEmail','memberPhone',metadata->>'memberPhone'),
      coalesce(metadata->>'university','COMSATS University Islamabad, Vehari Campus'),target_competition
    ) on conflict do nothing;
    insert into public.competition_registrations(
      competition_id,user_id,registration_number,university_name,department,batch,semester,
      participation_type,team_name,member_details,participant_name,email,phone
    ) values(
      target_competition,new.id,metadata->>'reg',
      coalesce(metadata->>'university','COMSATS University Islamabad, Vehari Campus'),metadata->>'department',
      metadata->>'batch',metadata->>'semester',coalesce(metadata->>'type','Individual'),nullif(metadata->>'team',''),
      jsonb_build_object('memberName',metadata->>'memberName','memberReg',metadata->>'memberReg',
        'memberEmail',metadata->>'memberEmail','memberPhone',metadata->>'memberPhone'),
      coalesce(metadata->>'name',split_part(new.email,'@',1)),new.email,metadata->>'phone'
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
  perform pg_advisory_xact_lock(hashtextextended(lower(new.registration_number),1));
  select registration_deadline,status,registration_open into deadline,status_value,is_open
    from public.competitions where id=new.competition_id;
  if status_value is null or status_value in ('draft','completed','archived') or not is_open then
    raise exception 'This competition is not accepting registrations';
  end if;
  if deadline is not null and now()>deadline then raise exception 'Registration has closed'; end if;
  if exists(select 1 from public.competition_registrations r where r.competition_id=new.competition_id and r.user_id=new.user_id) then
    raise exception 'This account is already registered for this competition';
  end if;
  if exists(select 1 from public.competition_registrations r where r.competition_id=new.competition_id and lower(r.registration_number)=lower(new.registration_number)) then
    raise exception 'This registration number is already used in this competition';
  end if;
  if (select count(*) from public.competition_registrations r where r.user_id=new.user_id)>=2 then
    raise exception 'A participant may join at most two competitions';
  end if;
  if exists(select 1 from public.competition_registrations r where lower(r.registration_number)=lower(new.registration_number) and r.user_id<>new.user_id) then
    raise exception 'This registration number belongs to another account';
  end if;
  return new;
end;
$$;
drop trigger if exists before_competition_registration on public.competition_registrations;
create trigger before_competition_registration before insert on public.competition_registrations
  for each row execute procedure public.enforce_two_competitions();
grant insert (participant_name,email,phone) on public.competition_registrations to authenticated;

do $$
begin
  if exists (select 1 from pg_constraint where conname='competition_submissions_check' and conrelid='public.competition_submissions'::regclass) then
    alter table public.competition_submissions drop constraint competition_submissions_check;
  end if;
  if not exists (select 1 from pg_constraint where conname='competition_submissions_links_http_check' and conrelid='public.competition_submissions'::regclass) then
    alter table public.competition_submissions add constraint competition_submissions_links_http_check check (
      (github_url = '' or github_url ~* '^https?://') and
      (live_url = '' or live_url ~* '^https?://') and
      (participant_drive_url = '' or participant_drive_url ~* '^https?://')
    );
  end if;
end $$;

-- Copy only rows whose legacy competition_id is known. Conflict handling keeps
-- any already-normalized registration/submission intact.
insert into public.competition_registrations (
  competition_id,user_id,registration_number,university_name,department,batch,semester,
  participation_type,team_name,member_details,payment_status,winner_status,
  participant_name,email,phone,payment_ref,payment_proof_path,payment_comment,created_at
)
select p.competition_id,p.user_id,p.reg,p.university_name,p.department,p.batch,p.semester,
  p.participation_type,p.team,p.member,p.payment_status,p.winner_status,
  p.name,p.email,p.phone,p.payment_ref,p.payment_proof_path,p.payment_comment,p.created_at
from public.participants p
where p.competition_id is not null
  and exists(select 1 from public.competitions c where c.id=p.competition_id)
  and not exists(select 1 from public.competition_registrations r where r.competition_id=p.competition_id and r.user_id=p.user_id)
  and (select count(*) from public.competition_registrations r where r.user_id=p.user_id) < 2
on conflict do nothing;

insert into public.competition_submissions (
  registration_id,project_title,project_description,technologies,github_url,live_url,
  participant_drive_url,external_apis,started_at,submitted_at,scores,judge_feedback,evaluated,updated_at
)
select r.id,coalesce(p.project,''),coalesce(p.project_description,''),coalesce(p.technologies,''),
  coalesce(p.github_url,''),coalesce(p.live_url,''),coalesce(p.drive_url,''),
  coalesce((select jsonb_agg(jsonb_build_object('name',btrim(split_part(line,'|',1)),'url',btrim(split_part(line,'|',2))))
    from regexp_split_to_table(coalesce(p.api_details,''), E'\\r?\\n') as line
    where btrim(line)<>'' and position('|' in line)>0), '[]'::jsonb),
  p.started_at,p.submitted_at,coalesce(p.evaluation,'{}'::jsonb),p.feedback,p.evaluated,p.updated_at
from public.participants p
join public.competition_registrations r on r.competition_id=p.competition_id and r.user_id=p.user_id
where p.competition_id is not null
on conflict (registration_id) do nothing;

create or replace function public.ensure_competition_submission()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  insert into public.competition_submissions(registration_id)
  values (new.id)
  on conflict (registration_id) do nothing;
  return new;
end;
$$;
drop trigger if exists after_competition_registration_submission on public.competition_registrations;
create trigger after_competition_registration_submission
  after insert on public.competition_registrations
  for each row execute procedure public.ensure_competition_submission();

create or replace function public.start_registration_timer(p_registration_id uuid)
returns timestamptz language plpgsql security definer set search_path=public
as $$
declare started timestamptz;
begin
  update public.competition_submissions s
     set started_at=coalesce(s.started_at,now()), updated_at=now()
    from public.competition_registrations r
   where s.registration_id=p_registration_id and r.id=s.registration_id and r.user_id=auth.uid()
  returning s.started_at into started;
  if started is null then raise exception 'Competition registration or submission not found for this account'; end if;
  return started;
end;
$$;
revoke all on function public.start_registration_timer(uuid) from public;
grant execute on function public.start_registration_timer(uuid) to authenticated;

create or replace function public.save_registration_submission_draft(
  p_registration_id uuid,p_project text,p_description text,p_technologies text,p_api_details jsonb,
  p_github text,p_live text,p_drive text,p_readme_confirmed boolean default false
) returns public.competition_submissions language plpgsql security definer set search_path=public
as $$
declare result public.competition_submissions; duration integer; start_time timestamptz;
begin
  select c.duration_minutes,s.started_at into duration,start_time
  from public.competition_registrations r
  join public.competitions c on c.id=r.competition_id
  join public.competition_submissions s on s.registration_id=r.id
  where r.id=p_registration_id and r.user_id=auth.uid();
  if not found then raise exception 'Competition registration or submission not found for this account'; end if;
  if start_time is not null and now()>start_time+make_interval(mins=>duration) then raise exception 'The submission deadline has passed'; end if;
  if coalesce(p_github,'')<>'' and p_github !~* '^https?://' then raise exception 'GitHub link must use HTTP or HTTPS'; end if;
  if coalesce(p_live,'')<>'' and p_live !~* '^https?://' then raise exception 'Live deployment link must use HTTP or HTTPS'; end if;
  if coalesce(p_drive,'')<>'' and p_drive !~* '^https?://' then raise exception 'Drive link must use HTTP or HTTPS'; end if;
  update public.competition_submissions
    set project_title=coalesce(p_project,''),project_description=coalesce(p_description,''),
        technologies=coalesce(p_technologies,''),external_apis=coalesce(p_api_details,'[]'::jsonb),
        github_url=coalesce(p_github,''),live_url=coalesce(p_live,''),participant_drive_url=coalesce(p_drive,''),
        readme_confirmed=coalesce(p_readme_confirmed,false),updated_at=now()
  where registration_id=p_registration_id returning * into result;
  return result;
end;
$$;
revoke all on function public.save_registration_submission_draft(uuid,text,text,text,jsonb,text,text,text,boolean) from public;
grant execute on function public.save_registration_submission_draft(uuid,text,text,text,jsonb,text,text,text,boolean) to authenticated;

create or replace function public.submit_registration_project(
  p_registration_id uuid,p_project text,p_description text,p_technologies text,p_api_details jsonb,
  p_github text,p_live text,p_drive text,p_readme_confirmed boolean
) returns public.competition_submissions language plpgsql security definer set search_path=public
as $$
declare result public.competition_submissions; duration integer; start_time timestamptz; api_item jsonb;
begin
  select c.duration_minutes,s.started_at into duration,start_time
  from public.competition_registrations r
  join public.competitions c on c.id=r.competition_id
  join public.competition_submissions s on s.registration_id=r.id
  where r.id=p_registration_id and r.user_id=auth.uid();
  if not found then raise exception 'Competition registration or submission not found for this account'; end if;
  if start_time is null then raise exception 'Start this competition timer before submitting'; end if;
  if now()>start_time+make_interval(mins=>duration) then raise exception 'The submission deadline has passed'; end if;
  if length(btrim(coalesce(p_project,'')))<2 then raise exception 'Enter a project name'; end if;
  if coalesce(p_github,'') !~* '^https?://' or coalesce(p_live,'') !~* '^https?://' or coalesce(p_drive,'') !~* '^https?://' then
    raise exception 'GitHub, live, and participant Drive links must use HTTP or HTTPS';
  end if;
  if coalesce(jsonb_array_length(p_api_details),0)=0 then raise exception 'Add at least one external API'; end if;
  for api_item in select value from jsonb_array_elements(p_api_details) loop
    if coalesce(api_item->>'name','')='' or coalesce(api_item->>'url','') !~* '^https?://' then
      raise exception 'Each external API must include a name and HTTP or HTTPS URL';
    end if;
  end loop;
  update public.competition_submissions
    set project_title=btrim(p_project),project_description=coalesce(p_description,''),
        technologies=coalesce(p_technologies,''),external_apis=p_api_details,
        github_url=p_github,live_url=p_live,participant_drive_url=p_drive,
        readme_confirmed=coalesce(p_readme_confirmed,false),submitted_at=now(),updated_at=now()
  where registration_id=p_registration_id returning * into result;
  return result;
end;
$$;
revoke all on function public.submit_registration_project(uuid,text,text,text,jsonb,text,text,text,boolean) from public;
grant execute on function public.submit_registration_project(uuid,text,text,text,jsonb,text,text,text,boolean) to authenticated;

create or replace function public.admin_update_competition_registration(p_registration_id uuid,p_patch jsonb)
returns void language plpgsql security definer set search_path=public
as $$
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  update public.competition_registrations set
    payment_status=coalesce(p_patch->>'payment_status',payment_status),
    payment_comment=coalesce(p_patch->>'payment_comment',payment_comment),
    winner_status=coalesce(p_patch->>'winner_status',winner_status),
    payment_ref=coalesce(p_patch->>'payment_ref',payment_ref),
    payment_proof_path=coalesce(p_patch->>'payment_proof_path',payment_proof_path)
  where id=p_registration_id;
  if not found then raise exception 'Competition registration not found'; end if;
  update public.competition_submissions set
    scores=coalesce(p_patch->'scores',scores),
    judge_feedback=coalesce(p_patch->>'judge_feedback',judge_feedback),
    evaluated=coalesce((p_patch->>'evaluated')::boolean,evaluated),updated_at=now()
  where registration_id=p_registration_id;
end;
$$;
revoke all on function public.admin_update_competition_registration(uuid,jsonb) from public;
grant execute on function public.admin_update_competition_registration(uuid,jsonb) to authenticated;

create or replace function public.save_registration_payment(
  p_registration_id uuid,p_phone text,p_payment_ref text,p_payment_proof_path text
) returns void language plpgsql security definer set search_path=public
as $$
begin
  update public.competition_registrations set phone=p_phone,payment_ref=p_payment_ref,
    payment_proof_path=p_payment_proof_path
  where id=p_registration_id and user_id=auth.uid();
  if not found then raise exception 'Competition registration not found for this account'; end if;
end;
$$;
revoke all on function public.save_registration_payment(uuid,text,text,text) from public;
grant execute on function public.save_registration_payment(uuid,text,text,text) to authenticated;

create or replace function public.published_results_by_competition()
returns table (id uuid,competition_id uuid,name text,team text,project text,batch text,evaluation jsonb,evaluated boolean,submitted_at timestamptz)
language sql stable security definer set search_path=public
as $$
  select r.id,r.competition_id,r.participant_name,r.team_name,s.project_title,r.batch,s.scores,s.evaluated,s.submitted_at
  from public.competition_registrations r
  join public.competition_submissions s on s.registration_id=r.id
  join public.competitions c on c.id=r.competition_id
  where c.results_announced and s.evaluated
  order by (select coalesce(sum(value::text::integer),0) from jsonb_each(s.scores)) desc;
$$;
revoke all on function public.published_results_by_competition() from public;
grant execute on function public.published_results_by_competition() to anon,authenticated;

-- Public competition cards expose only public metadata, never task/rules.
create or replace view public.public_competition_catalog with (security_barrier=true) as
select id,title,short_description,university_name,department,starts_at,ends_at,
  registration_deadline,status,results_announced,duration_minutes,mode,registration_open,payment_enabled
from public.competitions where status <> 'draft';
grant select on public.public_competition_catalog to anon,authenticated;

-- The organizer folder belongs to each competition. The participant Drive URL is
-- stored only in competition_submissions.participant_drive_url.
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
    'starts_at',c.starts_at,'ends_at',c.ends_at,'registration_deadline',c.registration_deadline,
    'status',c.status,'duration_minutes',c.duration_minutes,'mode',c.mode,'registration_open',c.registration_open,
    'payment_enabled',c.payment_enabled,'payment_amount',c.payment_amount,'payment_instructions',c.payment_instructions,
    'drive_upload_url',c.drive_upload_url,'drive_enabled',c.drive_enabled,'results_announced',c.results_announced,
    'announcements',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'subject',a.subject,'body',a.body,'created_at',a.created_at) order by a.created_at desc)
      from public.competition_announcements a where a.competition_id=c.id), '[]'::jsonb),
    'winners',coalesce((select jsonb_agg(jsonb_build_object('position',w.placement,'name',coalesce(r.team_name,r.participant_name),'project',s.project_title) order by w.placement)
      from public.competition_winners w join public.competition_registrations r on r.id=w.registration_id
      left join public.competition_submissions s on s.registration_id=r.id
      where w.competition_id=c.id and w.announced_at is not null), '[]'::jsonb)
  ) into result from public.competitions c where c.id=p_competition_id;
  if result is null then raise exception 'Competition not found'; end if;
  return result;
end;
$$;
revoke all on function public.authorized_competition_details(uuid) from public;
grant execute on function public.authorized_competition_details(uuid) to authenticated;

-- Do not permit the browser to write timer/deadline/submission state directly.
revoke all on public.competition_submissions from authenticated;
grant select on public.competition_submissions to authenticated;

drop policy if exists "participant manage own submission" on public.competition_submissions;
create policy "participant manage own submission" on public.competition_submissions for all to authenticated
  using (exists(select 1 from public.competition_registrations r where r.id=registration_id and r.user_id=auth.uid()))
  with check (exists(select 1 from public.competition_registrations r where r.id=registration_id and r.user_id=auth.uid()));

drop policy if exists "registered users read competition documents" on public.competition_documents;
create policy "registered users read competition documents" on public.competition_documents for select to authenticated
  using (exists(select 1 from public.competition_registrations r where r.competition_id=competition_documents.competition_id and r.user_id=auth.uid()));

-- RLS for registration-bound resources while preserving existing participant_id records.
drop policy if exists "read visible competition resources" on public.competition_resources;
create policy "read visible competition resources" on public.competition_resources for select to authenticated
  using (public.is_competition_admin() or visibility='public' or
    exists(select 1 from public.competition_registrations r where r.id=registration_id and r.user_id=auth.uid()) or
    exists(select 1 from public.participants p where p.id=participant_id and p.user_id=auth.uid()));
drop policy if exists "participant add own competition resources" on public.competition_resources;
create policy "participant add own competition resources" on public.competition_resources for insert to authenticated
  with check (uploaded_by=auth.uid() and registration_id is not null and exists(
    select 1 from public.competition_registrations r where r.id=registration_id and r.competition_id=competition_id and r.user_id=auth.uid()));
drop policy if exists "participant update own competition resources" on public.competition_resources;
create policy "participant update own competition resources" on public.competition_resources for update to authenticated
  using (exists(select 1 from public.competition_registrations r where r.id=registration_id and r.user_id=auth.uid()))
  with check (exists(select 1 from public.competition_registrations r where r.id=registration_id and r.user_id=auth.uid()));
drop policy if exists "participant delete own competition resources" on public.competition_resources;
create policy "participant delete own competition resources" on public.competition_resources for delete to authenticated
  using (exists(select 1 from public.competition_registrations r where r.id=registration_id and r.user_id=auth.uid()));

-- Keep current storage policies and add registration-based access. No bucket is made public.
drop policy if exists "participant upload competition resource" on storage.objects;
create policy "participant upload competition resource" on storage.objects for insert to authenticated
  with check (bucket_id='competition-files' and (storage.foldername(name))[2]=auth.uid()::text and exists(
    select 1 from public.competition_registrations r join public.competitions c on c.id=r.competition_id
    join public.competition_submissions s on s.registration_id=r.id
    where r.user_id=auth.uid() and r.competition_id::text=(storage.foldername(name))[1]
      and (s.started_at is null or now()<=s.started_at+make_interval(mins=>c.duration_minutes))));
drop policy if exists "participant read competition resource file" on storage.objects;
create policy "participant read competition resource file" on storage.objects for select to authenticated
  using (bucket_id='competition-files' and (storage.foldername(name))[2]=auth.uid()::text and exists(
    select 1 from public.competition_resources cr where cr.storage_path=name and cr.enabled and
      exists(select 1 from public.competition_registrations r where r.id=cr.registration_id and r.user_id=auth.uid())));
drop policy if exists "participant delete competition resource file" on storage.objects;
create policy "participant delete competition resource file" on storage.objects for delete to authenticated
  using (bucket_id='competition-files' and (storage.foldername(name))[2]=auth.uid()::text and exists(
    select 1 from public.competition_resources cr join public.competition_registrations r on r.id=cr.registration_id
    join public.competitions c on c.id=r.competition_id join public.competition_submissions s on s.registration_id=r.id
    where cr.storage_path=name and r.user_id=auth.uid() and (s.started_at is null or now()<=s.started_at+make_interval(mins=>c.duration_minutes))));

-- Keep the publication current for admin registration-count refreshes.
do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='competition_registrations') then
    alter publication supabase_realtime add table public.competition_registrations;
  end if;
end $$;
