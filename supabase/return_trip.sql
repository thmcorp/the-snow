-- Return trips: when a part marked "couldn't fully clear" is later checked cleared,
-- remember the earlier not-cleared note/time so the owner can bill a return-trip fee.
alter table clears add column if not exists was_note text not null default '';
alter table clears add column if not exists was_ts timestamptz;
alter table clear_log add column if not exists was_note text not null default '';
alter table clear_log add column if not exists was_ts timestamptz;

create or replace function clear_return_trip() returns trigger
language plpgsql
set search_path = public
as $$
declare
  prev record;
begin
  if tg_table_name = 'clear_log' then
    if not coalesce(new.checked, false) then return new; end if;
  end if;
  if coalesce(new.note, '') <> '' then new.was_note := ''; new.was_ts := null; return new; end if;
  select l.note, l.ts into prev from clear_log l
    where l.storm_id = new.storm_id and l.prop_id = new.prop_id and l.part = new.part
      and l.checked and l.note <> '' and l.ts <= coalesce(new.ts, now())
    order by l.ts desc limit 1;
  if found then new.was_note := prev.note; new.was_ts := prev.ts; else new.was_note := ''; new.was_ts := null; end if;
  return new;
end;
$$;

drop trigger if exists clears_return_trip on clears;
create trigger clears_return_trip before insert or update on clears for each row execute function clear_return_trip();
drop trigger if exists clear_log_return_trip on clear_log;
create trigger clear_log_return_trip before insert on clear_log for each row execute function clear_return_trip();
