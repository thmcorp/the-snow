-- Site maps per property (image stored as a data URL). Crews read; only the owner uploads.
create table if not exists site_maps (
  prop_id text primary key,
  img text not null,
  updated timestamptz not null default now()
);
alter table site_maps enable row level security;

create or replace function site_map(p_name text, p_pin text, p_action text, p_data jsonb default '{}'::jsonb)
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
  if p_action = 'list' then
    return (select coalesce(jsonb_agg(prop_id), '[]') from site_maps);
  elsif p_action = 'get' then
    return (select jsonb_build_object('img', img, 'updated', updated) from site_maps where prop_id = d->>'prop_id');
  end if;
  if not v_owner then raise exception 'owner_only'; end if;
  if p_action = 'save' then
    if left(coalesce(d->>'img',''), 11) <> 'data:image/' or length(d->>'img') > 4000000 then raise exception 'bad_image'; end if;
    insert into site_maps(prop_id, img, updated) values (d->>'prop_id', d->>'img', now())
      on conflict (prop_id) do update set img = excluded.img, updated = now();
  elsif p_action = 'remove' then
    delete from site_maps where prop_id = d->>'prop_id';
  else
    raise exception 'bad_action';
  end if;
  return '{}'::jsonb;
end;
$$;

revoke all on function site_map(text, text, text, jsonb) from public;
grant execute on function site_map(text, text, text, jsonb) to anon, authenticated;
