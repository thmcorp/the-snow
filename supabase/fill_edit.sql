-- Edit a salt fill-up (storage facility, number of bags). Crew can edit their own; owner any.
create or replace function fill_edit(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_owner boolean;
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null then raise exception 'bad_pin'; end if;
  v_owner := crypt(p_pin, s.owner_pin) = s.owner_pin;
  if not (v_owner or crypt(p_pin, s.crew_pin) = s.crew_pin) then raise exception 'bad_pin'; end if;
  update fills set yard = coalesce(nullif(d->>'yard',''), yard),
                   bags = case when kind = 'bags' and (d->>'bags') is not null then (d->>'bags')::int else bags end
    where id = (d->>'id')::uuid and kind in ('bulk','bags')
      and (v_owner or lower(trim(crew)) = lower(trim(coalesce(p_name,''))));
  return '{}'::jsonb;
end;
$$;

revoke all on function fill_edit(text, text, text, jsonb) from public;
grant execute on function fill_edit(text, text, text, jsonb) to anon, authenticated;
