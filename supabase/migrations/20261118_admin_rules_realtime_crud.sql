-- Competition-scoped rules with organizer-only writes and registered-user reads.
-- This migration is intentionally safe to apply separately; no live database is changed here.

create table if not exists public.competition_rules (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  content text not null default '',
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists competition_rules_competition_sort_idx
  on public.competition_rules(competition_id, sort_order, created_at);

alter table public.competition_rules enable row level security;
drop policy if exists "admins and registered participants read competition rules" on public.competition_rules;
create policy "admins and registered participants read competition rules"
  on public.competition_rules for select to authenticated
  using (
    public.is_competition_admin()
    or exists (select 1 from public.competition_registrations r
      where r.competition_id=competition_rules.competition_id and r.user_id=auth.uid())
    or exists (select 1 from public.participants p
      where p.competition_id=competition_rules.competition_id and p.user_id=auth.uid())
  );
revoke all on public.competition_rules from anon, authenticated;
grant select on public.competition_rules to authenticated;

create or replace function public.admin_create_competition_rule(
  p_competition_id uuid, p_title text, p_content text, p_sort_order integer default 0
) returns public.competition_rules
language plpgsql security definer set search_path=public
as $$
declare created_rule public.competition_rules;
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  if nullif(btrim(p_title),'') is null or length(btrim(p_title))>160 then raise exception 'Rule title must be 1 to 160 characters'; end if;
  if not exists(select 1 from public.competitions where id=p_competition_id) then raise exception 'Competition not found'; end if;
  insert into public.competition_rules(competition_id,title,content,sort_order,created_by)
    values(p_competition_id,btrim(p_title),coalesce(p_content,''),coalesce(p_sort_order,0),auth.uid())
    returning * into created_rule;
  return created_rule;
end;
$$;
revoke all on function public.admin_create_competition_rule(uuid,text,text,integer) from public;
grant execute on function public.admin_create_competition_rule(uuid,text,text,integer) to authenticated;

create or replace function public.admin_update_competition_rule(
  p_id uuid, p_title text, p_content text, p_sort_order integer default 0
) returns public.competition_rules
language plpgsql security definer set search_path=public
as $$
declare updated_rule public.competition_rules;
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  if nullif(btrim(p_title),'') is null or length(btrim(p_title))>160 then raise exception 'Rule title must be 1 to 160 characters'; end if;
  update public.competition_rules set title=btrim(p_title),content=coalesce(p_content,''),
    sort_order=coalesce(p_sort_order,0),updated_at=now() where id=p_id returning * into updated_rule;
  if updated_rule.id is null then raise exception 'Competition rule not found'; end if;
  return updated_rule;
end;
$$;
revoke all on function public.admin_update_competition_rule(uuid,text,text,integer) from public;
grant execute on function public.admin_update_competition_rule(uuid,text,text,integer) to authenticated;

create or replace function public.admin_delete_competition_rule(p_id uuid)
returns void language plpgsql security definer set search_path=public
as $$
begin
  if not public.is_competition_admin() then raise exception 'Organizer access required'; end if;
  delete from public.competition_rules where id=p_id;
  if not found then raise exception 'Competition rule not found'; end if;
end;
$$;
revoke all on function public.admin_delete_competition_rule(uuid) from public;
grant execute on function public.admin_delete_competition_rule(uuid) to authenticated;

-- The details RPC already checks admin/registration access. Include the
-- competition's rule rows in that scoped response for participant pages.
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
    'rules',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'content',r.content,'sort_order',r.sort_order)
      order by r.sort_order,r.created_at) from public.competition_rules r where r.competition_id=c.id),'[]'::jsonb),
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

-- Make rule changes observable by Supabase Realtime where the default
-- supabase_realtime publication is enabled.
do $$
declare target_table text;
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then return; end if;
  foreach target_table in array array['competition_rules','participants','competition_registrations','competitions','profiles'] loop
    if to_regclass(format('public.%I',target_table)) is not null
      and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=target_table) then
      execute format('alter publication supabase_realtime add table public.%I',target_table);
    end if;
  end loop;
end;
$$;

notify pgrst,'reload schema';
