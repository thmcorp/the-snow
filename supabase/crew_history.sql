-- Owner-only: a crew member's clock-in / clock-out history (newest first).
create or replace function crew_history(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  v_crew text := lower(trim(coalesce(p_data->>'crew', '')));
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null or crypt(p_pin, s.owner_pin) <> s.owner_pin then raise exception 'owner_only'; end if;
  if p_action = 'shift' then
    return (select jsonb_build_object(
      'run', to_jsonb(r),
      'entries', (select coalesce(jsonb_agg(to_jsonb(e) order by e.ts), '[]') from salt_entries e where e.run_id = r.id),
      'fills', (select coalesce(jsonb_agg(to_jsonb(f) order by f.ts), '[]') from fills f where f.run_id = r.id
                  or (f.run_id is null and lower(trim(f.crew)) = lower(trim(r.crew)) and f.ts >= r.started - interval '1 second' and f.ts <= coalesce(r.ended, now()))),
      'clears', (select coalesce(jsonb_agg(jsonb_build_object('prop_id', c.prop_id, 'part', c.part, 'checked', c.checked, 'note', c.note, 'ts', c.ts, 'storm_name', c.storm_name) order by c.ts), '[]')
                  from clear_log c where lower(trim(c.crew)) = lower(trim(r.crew)) and c.ts >= r.started - interval '1 second' and c.ts <= coalesce(r.ended, now())))
      from runs r where r.id = (p_data->>'id')::uuid);
  end if;
  return jsonb_build_object(
    'shifts', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'started', r.started, 'ended', r.ended,
                  'stops', (select count(distinct e.prop_id) from salt_entries e where e.run_id = r.id),
                  'entries', (select count(*) from salt_entries e where e.run_id = r.id), 'note', r.note) order by r.started desc), '[]')
               from (select * from runs where lower(trim(crew)) = v_crew order by started desc limit 100) r),
    'sessions', (select coalesce(jsonb_agg(jsonb_build_object('signed_in', x.signed_in, 'signed_out', x.signed_out, 'last_seen', x.last_seen) order by x.signed_in desc), '[]')
               from (select * from sessions where lower(trim(name)) = v_crew order by signed_in desc limit 50) x)
  );
end;
$$;

revoke all on function crew_history(text, text, text, jsonb) from public;
grant execute on function crew_history(text, text, text, jsonb) to anon, authenticated;
