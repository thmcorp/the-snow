-- End-of-shift "salt emptied out of the truck" entries, stored with fill-ups.
alter table fills drop constraint if exists fills_kind_check;
alter table fills add constraint fills_kind_check check (kind in ('bulk','bags','empty_bulk','empty_bags'));
alter table fills add column if not exists note text not null default '';

create or replace function log_empty(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  v_name text := trim(coalesce(p_name, ''));
  d jsonb := coalesce(p_data, '{}'::jsonb);
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null or not (crypt(p_pin, s.owner_pin) = s.owner_pin or crypt(p_pin, s.crew_pin) = s.crew_pin) then raise exception 'bad_pin'; end if;
  if v_name = '' then raise exception 'name_required'; end if;
  if d->>'kind' not in ('empty_bulk','empty_bags') then raise exception 'bad_kind'; end if;
  insert into fills(id, crew, kind, bags, yard, run_id, ts, note)
    values ((d->>'id')::uuid, v_name, d->>'kind', null, d->>'yard', nullif(d->>'run_id','')::uuid,
            coalesce((d->>'ts')::timestamptz, now()), left(coalesce(d->>'note',''), 500))
    on conflict (id) do nothing;
  return '{}'::jsonb;
end;
$$;

revoke all on function log_empty(text, text, text, jsonb) from public;
grant execute on function log_empty(text, text, text, jsonb) to anon, authenticated;
