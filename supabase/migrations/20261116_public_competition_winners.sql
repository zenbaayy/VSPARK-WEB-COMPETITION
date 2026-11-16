-- Public Results page: expose only announced winner placements and safe display fields.
create or replace function public.public_competition_winners(p_competition_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with podium as (
    select w.placement as position, coalesce(nullif(p.team,''), p.name, 'Participant') as name,
      coalesce(p.project,'') as project, coalesce(p.batch,'') as batch
    from public.competition_winners w
    join public.competition_registrations r on r.id=w.registration_id
    join public.participants p on p.user_id=r.user_id and p.competition_id=r.competition_id
    where w.competition_id=p_competition_id and w.announced_at is not null
    union all
    select case p.winner_status when 'Winner' then 1 else 2 end,
      coalesce(nullif(p.team,''), p.name, 'Participant'), coalesce(p.project,''), coalesce(p.batch,'')
    from public.participants p
    where p.competition_id=p_competition_id and p.winner_status in ('Winner','Runner-up')
      and not exists (select 1 from public.competition_winners w where w.competition_id=p_competition_id
        and w.placement=case p.winner_status when 'Winner' then 1 else 2 end and w.announced_at is not null)
  )
  select coalesce(jsonb_agg(jsonb_build_object('position',position,'name',name,'project',project,'batch',batch)
    order by position), '[]'::jsonb) from podium;
$$;
revoke all on function public.public_competition_winners(uuid) from public;
grant execute on function public.public_competition_winners(uuid) to anon, authenticated;
