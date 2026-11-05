-- End-of-shift notes (broken shovels, snowblower, etc.), stored on the shift.
alter table runs add column if not exists note text not null default '';

create or replace function shift_note(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  v_name text := trim(coalesce(p_name, ''));
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_owner boolean;
  v_tz text := 'America/New_York';
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null then raise exception 'bad_pin'; end if;
  v_owner := crypt(p_pin, s.owner_pin) = s.owner_pin;
  if not (v_owner or crypt(p_pin, s.crew_pin) = s.crew_pin) then raise exception 'bad_pin'; end if;
  if p_action = 'list' then
    if not v_owner then raise exception 'owner_only'; end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'crew', r.crew, 'started', r.started, 'ended', r.ended, 'note', r.note, 'ts', coalesce(r.ended, r.started)) order by coalesce(r.ended, r.started)), '[]')
            from runs r where r.note <> ''
              and (d->>'from' is null or (coalesce(r.ended, r.started) at time zone v_tz)::date >= (d->>'from')::date)
              and (d->>'to' is null or (coalesce(r.ended, r.started) at time zone v_tz)::date <= (d->>'to')::date));
  end if;
  if v_name = '' then raise exception 'name_required'; end if;
  update runs set note = left(coalesce(d->>'note',''), 1000)
    where id = (d->>'id')::uuid and (lower(trim(crew)) = lower(v_name) or v_owner);
  return '{}'::jsonb;
end;
$$;

revoke all on function shift_note(text, text, text, jsonb) from public;
grant execute on function shift_note(text, text, text, jsonb) to anon, authenticated;
