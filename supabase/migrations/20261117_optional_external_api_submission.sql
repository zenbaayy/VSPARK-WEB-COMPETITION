-- External APIs are no longer a required submission field.
-- Keep validating any API entries that are provided, but allow none.
create or replace function public.submit_competition_project(
  p_id uuid, p_project text, p_description text, p_technologies text, p_api_details text,
  p_github text, p_live text, p_drive text
) returns public.participants language plpgsql security definer set search_path = public
as $$
declare
  current_row public.participants;
  duration integer;
  api_line text;
begin
  select * into current_row from public.participants where id = p_id and user_id = auth.uid();
  if current_row.id is null then raise exception 'Participant record not found'; end if;
  if current_row.started_at is null then raise exception 'Start the competition timer before submitting'; end if;
  select duration_minutes into duration from public.competition_settings where id = 1;
  if now() > current_row.started_at + make_interval(mins => duration) then
    raise exception 'The submission deadline has passed';
  end if;
  if length(btrim(coalesce(p_project,''))) < 2 then raise exception 'Enter a project name'; end if;
  if coalesce(p_github,'') !~* '^https?://' or coalesce(p_live,'') !~* '^https?://' or coalesce(p_drive,'') !~* '^https?://' then
    raise exception 'GitHub, live, and Drive links must use HTTP or HTTPS';
  end if;
  foreach api_line in array string_to_array(coalesce(p_api_details,''), E'\n') loop
    if btrim(api_line) <> '' and (position('|' in api_line) = 0 or split_part(api_line, '|', 1) = ''
      or split_part(api_line, '|', 2) !~* '^https?://') then
      raise exception 'Each external API must include a name and HTTP or HTTPS URL';
    end if;
  end loop;
  update public.participants set project = btrim(p_project), github_url = p_github,
    live_url = p_live, drive_url = p_drive, project_description = coalesce(p_description,''),
    technologies = coalesce(p_technologies,''), api_details = coalesce(p_api_details,''),
    submitted_at = now(), updated_at = now()
  where id = p_id returning * into current_row;
  return current_row;
end;
$$;
revoke all on function public.submit_competition_project(uuid,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_competition_project(uuid,text,text,text,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';
