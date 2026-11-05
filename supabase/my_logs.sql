-- Crew "My Logs": a driver's own shifts (date range) and one shift's full log.
create or replace function my_logs(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_me text := lower(trim(coalesce(p_name, '')));
  v_tz text := 'America/New_York';
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null or not (crypt(p_pin, s.owner_pin) = s.owner_pin or crypt(p_pin, s.crew_pin) = s.crew_pin) then raise exception 'bad_pin'; end if;
  if v_me = '' then raise exception 'name_required'; end if;
  if p_action = 'shift' then
    return (select jsonb_build_object(
      'run', to_jsonb(r),
      'entries', (select coalesce(jsonb_agg(to_jsonb(e) order by e.ts), '[]') from salt_entries e where e.run_id = r.id),
      'fills', (select coalesce(jsonb_agg(to_jsonb(f) order by f.ts), '[]') from fills f where f.run_id = r.id
                  or (f.run_id is null and lower(trim(f.crew)) = v_me and f.ts >= r.started - interval '1 second' and f.ts <= coalesce(r.ended, now()))),
      'clears', (select coalesce(jsonb_agg(jsonb_build_object('prop_id', c.prop_id, 'part', c.part, 'checked', c.checked, 'note', c.note, 'ts', c.ts, 'storm_name', c.storm_name) order by c.ts), '[]')
                  from clear_log c where lower(trim(c.crew)) = v_me and c.ts >= r.started - interval '1 second' and c.ts <= coalesce(r.ended, now())))
      from runs r where r.id = (d->>'id')::uuid and lower(trim(r.crew)) = v_me);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'started', r.started, 'ended', r.ended, 'note', r.note,
                  'stops', (select count(distinct e.prop_id) from salt_entries e where e.run_id = r.id)) order by r.started desc), '[]')
          from runs r where lower(trim(r.crew)) = v_me
            and (d->>'from' is null or (r.started at time zone v_tz)::date >= (d->>'from')::date)
            and (d->>'to' is null or (r.started at time zone v_tz)::date <= (d->>'to')::date));
end;
$$;

revoke all on function my_logs(text, text, text, jsonb) from public;
grant execute on function my_logs(text, text, text, jsonb) to anon, authenticated;
