-- Recent saltings at one property by anyone (last 18 hours), so a crew on site
-- can see what others already did there. Any valid PIN can read.
create or replace function prop_salt(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null
     or not (crypt(p_pin, s.owner_pin) = s.owner_pin or crypt(p_pin, s.crew_pin) = s.crew_pin) then
    raise exception 'bad_pin';
  end if;
  if p_action <> 'recent' then raise exception 'bad_action'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'prop_id', e.prop_id, 'area', e.area, 'amt', e.amt,
            'note', e.note, 'crew', e.crew, 'ts', e.ts) order by e.ts), '[]')
          from salt_entries e
          where e.prop_id = p_data->>'prop_id' and e.ts > now() - interval '18 hours');
end;
$$;

revoke all on function prop_salt(text, text, text, jsonb) from public;
grant execute on function prop_salt(text, text, text, jsonb) to anon, authenticated;
