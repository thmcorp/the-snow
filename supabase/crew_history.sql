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
