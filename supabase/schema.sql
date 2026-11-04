-- THM Snow database setup (Supabase / Postgres).
-- Safe to run more than once. Business data (properties, PINs) is loaded separately
-- with setup-data.sql, which is NOT kept in this public repo.

create extension if not exists pgcrypto;

create table if not exists settings(
  id int primary key default 1 check (id = 1),
  crew_pin text not null,   -- bcrypt hash
  owner_pin text not null   -- bcrypt hash
);
create table if not exists properties(
  id text primary key,
  route_id text not null,
  route_name text not null,
  route_order int not null,
  sort int not null,
  label text not null,           -- "Address (notes)" exactly as on the Excel template
  walks boolean not null default true,  -- false = black Salt Walks box
  lat double precision,
  lng double precision,
  active boolean not null default true
);
create table if not exists runs(
  id uuid primary key,
  crew text not null,
  started timestamptz not null default now(),
  ended timestamptz
);
create table if not exists salt_entries(
  id uuid primary key,
  run_id uuid,
  prop_id text not null references properties(id),
  area text not null check (area in ('drives','walks')),
  amt numeric not null check (amt > 0 and amt <= 1),
  note text not null default '',
  crew text not null,
  ts timestamptz not null default now()
);
create table if not exists fills(
  id uuid primary key,
  crew text not null,
  kind text not null check (kind in ('bulk','bags')),
  bags int,
  yard text,
  run_id uuid,
  ts timestamptz not null default now()
);
create table if not exists storms(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  started timestamptz not null default now(),
  ended timestamptz
);
create table if not exists clears(
  storm_id uuid not null references storms(id),
  prop_id text not null references properties(id),
  part text not null check (part in ('drives','walks')),
  crew text not null,
  ts timestamptz not null default now(),
  primary key (storm_id, prop_id, part)
);
create table if not exists clear_log(
  id uuid primary key default gen_random_uuid(),
  storm_id uuid,
  storm_name text,
  prop_id text,
  part text,
  checked boolean,
  crew text,
  ts timestamptz not null default now()
);
create table if not exists sessions(
  id uuid primary key,
  name text not null,
  role text not null,
  signed_in timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  signed_out timestamptz,
  here text
);

-- Lock every table: the app only talks to the database through api() below,
-- which checks the crew or owner PIN on every call.
alter table settings enable row level security;
alter table properties enable row level security;
alter table runs enable row level security;
alter table salt_entries enable row level security;
alter table fills enable row level security;
alter table storms enable row level security;
alter table clears enable row level security;
alter table clear_log enable row level security;
alter table sessions enable row level security;

create or replace function api(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s settings;
  v_role text;
  v_name text := trim(coalesce(p_name, ''));
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_storm storms;
  v_run runs;
  v_tz text := 'America/New_York';
  res jsonb;
begin
  select * into s from settings where id = 1;
  if s is null then raise exception 'not_set_up'; end if;
  if p_pin is not null and crypt(p_pin, s.owner_pin) = s.owner_pin then v_role := 'owner';
  elsif p_pin is not null and crypt(p_pin, s.crew_pin) = s.crew_pin then v_role := 'crew';
  else raise exception 'bad_pin'; end if;
  if v_name = '' then raise exception 'name_required'; end if;

  if p_action in ('storm_start','storm_end','set_coords','owner_data') and v_role <> 'owner' then
    raise exception 'owner_only';
  end if;

  select * into v_storm from storms where ended is null order by started desc limit 1;

  case p_action
  when 'login' then
    update sessions set signed_out = now() where name = v_name and signed_out is null and id <> (d->>'session')::uuid;
    insert into sessions(id, name, role) values ((d->>'session')::uuid, v_name, v_role)
      on conflict (id) do update set last_seen = now(), signed_out = null, role = excluded.role;
    return jsonb_build_object('role', v_role);

  when 'logout' then
    update sessions set signed_out = now() where id = (d->>'session')::uuid;
    return '{}'::jsonb;

  when 'state' then
    if d ? 'session' then
      update sessions set last_seen = now(), here = d->>'here', signed_out = null, name = v_name, role = v_role
        where id = (d->>'session')::uuid;
    end if;
    select * into v_run from runs where crew = v_name and ended is null order by started desc limit 1;
    res := jsonb_build_object(
      'role', v_role,
      'properties', (select coalesce(jsonb_agg(to_jsonb(p) order by p.route_order, p.sort), '[]') from properties p where p.active),
      'storm', case when v_storm.id is null then null else to_jsonb(v_storm) end,
      'clears', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from clears c where c.storm_id = v_storm.id),
      'run', case when v_run.id is null then null else to_jsonb(v_run) end,
      'entries', (select coalesce(jsonb_agg(to_jsonb(e) order by e.ts), '[]') from salt_entries e where v_run.id is not null and e.run_id = v_run.id),
      'fills', (select coalesce(jsonb_agg(to_jsonb(f) order by f.ts), '[]') from fills f where f.crew = v_name and f.ts > now() - interval '18 hours')
    );
    if v_role = 'owner' then
      res := res || jsonb_build_object(
        'past_storms', (select coalesce(jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name, 'started', st.started, 'ended', st.ended,
                          'clears', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from clears c where c.storm_id = st.id)) order by st.started desc), '[]')
                        from (select * from storms where ended is not null order by started desc limit 30) st),
        'sessions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]')
                     from sessions x where x.signed_out is null or x.signed_out > now() - interval '2 days'),
        'active_runs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'crew', r.crew, 'started', r.started,
                          'stops', (select count(distinct e.prop_id) from salt_entries e where e.run_id = r.id))), '[]')
                        from runs r where r.ended is null and r.started > now() - interval '24 hours')
      );
    end if;
    return res;

  when 'owner_data' then
    return jsonb_build_object(
      'entries', (select coalesce(jsonb_agg(to_jsonb(e) order by e.ts), '[]') from salt_entries e
                  where (d->>'from' is null or (e.ts at time zone v_tz)::date >= (d->>'from')::date)
                    and (d->>'to' is null or (e.ts at time zone v_tz)::date <= (d->>'to')::date)),
      'fills', (select coalesce(jsonb_agg(to_jsonb(f) order by f.ts), '[]') from fills f
                  where (d->>'from' is null or (f.ts at time zone v_tz)::date >= (d->>'from')::date)
                    and (d->>'to' is null or (f.ts at time zone v_tz)::date <= (d->>'to')::date)),
      'clear_log', (select coalesce(jsonb_agg(to_jsonb(c) order by c.ts), '[]') from clear_log c
                  where (d->>'from' is null or (c.ts at time zone v_tz)::date >= (d->>'from')::date)
                    and (d->>'to' is null or (c.ts at time zone v_tz)::date <= (d->>'to')::date))
    );

  when 'start_run' then
    insert into runs(id, crew, started) values ((d->>'id')::uuid, v_name, coalesce((d->>'ts')::timestamptz, now()))
      on conflict (id) do nothing;
    return '{}'::jsonb;

  when 'finish_run' then
    update runs set ended = coalesce((d->>'ts')::timestamptz, now())
      where id = (d->>'id')::uuid and (crew = v_name or v_role = 'owner');
    return '{}'::jsonb;

  when 'salt' then
    insert into salt_entries(id, run_id, prop_id, area, amt, note, crew, ts)
      values ((d->>'id')::uuid, nullif(d->>'run_id','')::uuid, d->>'prop_id', d->>'area', (d->>'amt')::numeric,
              coalesce(d->>'note',''), v_name, coalesce((d->>'ts')::timestamptz, now()))
      on conflict (id) do nothing;
    return '{}'::jsonb;

  when 'salt_edit' then
    update salt_entries set amt = (d->>'amt')::numeric, note = coalesce(d->>'note',''), ts = coalesce((d->>'ts')::timestamptz, ts)
      where id = (d->>'id')::uuid and (crew = v_name or v_role = 'owner');
    return '{}'::jsonb;

  when 'salt_delete' then
    delete from salt_entries where id = (d->>'id')::uuid and (crew = v_name or v_role = 'owner');
    return '{}'::jsonb;

  when 'fill' then
    insert into fills(id, crew, kind, bags, yard, run_id, ts)
      values ((d->>'id')::uuid, v_name, d->>'kind', nullif(d->>'bags','')::int, d->>'yard', nullif(d->>'run_id','')::uuid,
              coalesce((d->>'ts')::timestamptz, now()))
      on conflict (id) do nothing;
    return '{}'::jsonb;

  when 'fill_delete' then
    delete from fills where id = (d->>'id')::uuid and (crew = v_name or v_role = 'owner');
    return '{}'::jsonb;

  when 'clear' then
    if v_storm.id is null or v_storm.id <> (d->>'storm_id')::uuid then raise exception 'no_storm'; end if;
    if (d->>'checked')::boolean then
      insert into clears(storm_id, prop_id, part, crew, ts)
        values (v_storm.id, d->>'prop_id', d->>'part', v_name, coalesce((d->>'ts')::timestamptz, now()))
        on conflict (storm_id, prop_id, part) do nothing;
    else
      delete from clears where storm_id = v_storm.id and prop_id = d->>'prop_id' and part = d->>'part';
    end if;
    insert into clear_log(storm_id, storm_name, prop_id, part, checked, crew, ts)
      values (v_storm.id, v_storm.name, d->>'prop_id', d->>'part', (d->>'checked')::boolean, v_name, coalesce((d->>'ts')::timestamptz, now()));
    return '{}'::jsonb;

  when 'storm_start' then
    update storms set ended = now() where ended is null;
    insert into storms(name) values (coalesce(nullif(trim(d->>'name'),''), 'Storm ' || to_char(now() at time zone v_tz, 'MM/DD')));
    return '{}'::jsonb;

  when 'storm_end' then
    update storms set ended = now() where ended is null;
    return '{}'::jsonb;

  when 'set_coords' then
    update properties set lat = (d->>'lat')::double precision, lng = (d->>'lng')::double precision where id = d->>'prop_id';
    return '{}'::jsonb;

  else
    raise exception 'unknown_action';
  end case;
end;
$$;

revoke all on function api(text, text, text, jsonb) from public;
grant execute on function api(text, text, text, jsonb) to anon, authenticated;
