-- Owner tools on the Crew tab: clock a driver out and sign them out of the app
-- (for when someone forgets to end their shift).
alter table sessions add column if not exists kicked boolean not null default false;

-- A session the owner signed out stays signed out: the driver's phone gets
-- 'signed_out_by_owner' on its next check-in and returns to the sign-in screen.
create or replace function sessions_keep_kicked() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.kicked and new.signed_out is null then
    raise exception 'signed_out_by_owner';
  end if;
  return new;
end;
$$;

create or replace trigger sessions_keep_kicked before update on sessions
  for each row when (old.kicked)
  execute function sessions_keep_kicked();

create or replace function crew_admin(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  v_crew text := lower(trim(coalesce(p_data->>'crew', '')));
  v_runs int; v_sess int;
begin
  select * into s from settings where id = 1;
  if s is null or p_pin is null or crypt(p_pin, s.owner_pin) <> s.owner_pin then raise exception 'owner_only'; end if;
  if v_crew = '' then raise exception 'crew_required'; end if;
  if p_action <> 'sign_out' then raise exception 'bad_action'; end if;
  update runs set ended = now() where lower(trim(crew)) = v_crew and ended is null;
  get diagnostics v_runs = row_count;
  update sessions set signed_out = now(), kicked = true
    where lower(trim(name)) = v_crew and signed_out is null;
  get diagnostics v_sess = row_count;
  return jsonb_build_object('runs_ended', v_runs, 'sessions_ended', v_sess);
end;
$$;

revoke all on function crew_admin(text, text, text, jsonb) from public;
grant execute on function crew_admin(text, text, text, jsonb) to anon, authenticated;
