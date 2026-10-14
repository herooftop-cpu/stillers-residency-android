-- =============================================================
-- Stiller's Residency v1.3 security / account-role update
-- Run once in Supabase SQL Editor on the existing Residency project.
--
-- Final limits:
--   1 Main Admin (owner)
--   2 Managers (role='admin', non-owner)
--   2 Viewers
--   Total maximum = 5 accounts
--
-- One account remains bound to one device until Main Admin removes it.
-- Closing the app / going offline DOES NOT release the device binding.
-- =============================================================

begin;

alter table public.app_accounts
  add column if not exists bound_device_id text,
  add column if not exists bound_device_name text,
  add column if not exists bound_at timestamptz;

with latest as (
  select distinct on (account_id)
    account_id, device_id, device_name, last_seen_at
  from public.device_sessions
  order by account_id, last_seen_at desc
)
update public.app_accounts a
set bound_device_id = latest.device_id,
    bound_device_name = latest.device_name,
    bound_at = coalesce(a.bound_at, latest.last_seen_at, now())
from latest
where a.id = latest.account_id
  and a.bound_device_id is null;

delete from public.device_sessions s
using public.app_accounts a
where s.account_id = a.id
  and a.bound_device_id is not null
  and s.device_id is distinct from a.bound_device_id;

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and indexname='device_sessions_one_account_idx'
  ) then
    create unique index device_sessions_one_account_idx on public.device_sessions(account_id);
  end if;
end $$;

create or replace function public.current_app_account_id()
returns uuid language sql stable security definer set search_path=public as $$
  select a.id
  from public.device_sessions s
  join public.app_accounts a on a.id=s.account_id
  where s.auth_uid=auth.uid()
    and s.password_version=a.password_version
    and a.is_blocked=false
    and a.bound_device_id is not null
    and s.device_id=a.bound_device_id
  limit 1
$$;

create or replace function public.current_app_role()
returns text language sql stable security definer set search_path=public as $$
  select a.role
  from public.device_sessions s
  join public.app_accounts a on a.id=s.account_id
  where s.auth_uid=auth.uid()
    and s.password_version=a.password_version
    and a.is_blocked=false
    and a.bound_device_id is not null
    and s.device_id=a.bound_device_id
  limit 1
$$;

create or replace function public.current_is_owner()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1
    from public.app_settings st
    where st.id=true
      and st.owner_admin_id=public.current_app_account_id()
  )
$$;

create or replace function public.bootstrap_admin(
  p_username text,
  p_password text,
  p_lock_password text,
  p_device_id text,
  p_device_name text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_admin uuid;
  v_raw text;
  v_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.app_settings) or exists(select 1 from public.app_accounts where role='admin') then
    raise exception 'Main Admin setup has already been completed';
  end if;
  if length(trim(p_username))<3 then raise exception 'Username must be at least 3 characters'; end if;
  if length(p_password)<6 then raise exception 'Password must be at least 6 characters'; end if;
  if length(p_lock_password)<4 then raise exception 'Lock password must be at least 4 characters'; end if;
  if coalesce(trim(p_device_id),'')='' then raise exception 'Device ID is required'; end if;

  v_raw:=upper(encode(extensions.gen_random_bytes(4),'hex'));
  v_code:='SR-'||substr(v_raw,1,4)||'-'||substr(v_raw,5,4);

  insert into public.app_accounts(username,password_hash,role,bound_device_id,bound_device_name,bound_at)
  values(lower(trim(p_username)),extensions.crypt(p_password,extensions.gen_salt('bf')),'admin',p_device_id,p_device_name,now())
  returning id into v_admin;

  insert into public.app_settings(id,owner_admin_id,lock_password_hash,recovery_code_hash)
  values(true,v_admin,extensions.crypt(p_lock_password,extensions.gen_salt('bf')),extensions.crypt(v_code,extensions.gen_salt('bf')));

  delete from public.device_sessions where account_id=v_admin or auth_uid=auth.uid();
  insert into public.device_sessions(auth_uid,account_id,device_id,device_name,password_version,last_seen_at)
  values(auth.uid(),v_admin,p_device_id,p_device_name,1,now());

  return jsonb_build_object('username',lower(trim(p_username)),'role','admin','recovery_code',v_code);
end $$;

create or replace function public.login_app_account(
  p_username text,
  p_password text,
  p_device_id text,
  p_device_name text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v public.app_accounts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(trim(p_device_id),'')='' then raise exception 'Device ID is required'; end if;

  select a.* into v
  from public.app_accounts a
  where a.username=lower(trim(p_username))
  limit 1;

  if v.id is null or v.password_hash<>extensions.crypt(p_password,v.password_hash) then
    raise exception 'Invalid username or password';
  end if;
  if v.is_blocked then raise exception 'This account is blocked'; end if;

  if v.bound_device_id is not null and v.bound_device_id<>p_device_id then
    raise exception 'This account is already registered on another device. Ask Main Admin to remove the old device first.';
  end if;

  if v.bound_device_id is null then
    update public.app_accounts
    set bound_device_id=p_device_id,
        bound_device_name=p_device_name,
        bound_at=now()
    where id=v.id;
  else
    update public.app_accounts
    set bound_device_name=coalesce(nullif(p_device_name,''),bound_device_name)
    where id=v.id;
  end if;

  delete from public.device_sessions where account_id=v.id or auth_uid=auth.uid();
  insert into public.device_sessions(auth_uid,account_id,device_id,device_name,password_version,last_seen_at)
  values(auth.uid(),v.id,p_device_id,p_device_name,v.password_version,now());

  return jsonb_build_object('username',v.username,'role',v.role);
end $$;

create or replace function public.my_app_session()
returns table(active boolean,username text,role text,is_owner boolean,is_blocked boolean)
language sql stable security definer set search_path=public as $$
  select (
      s.password_version=a.password_version
      and not a.is_blocked
      and a.bound_device_id is not null
      and s.device_id=a.bound_device_id
    ),
    a.username,
    a.role,
    (st.owner_admin_id=a.id),
    a.is_blocked
  from public.device_sessions s
  join public.app_accounts a on a.id=s.account_id
  left join public.app_settings st on st.id=true
  where s.auth_uid=auth.uid()
  limit 1
$$;

create or replace function public.heartbeat(p_device_id text,p_device_name text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.device_sessions s
  set last_seen_at=now(),device_name=p_device_name
  from public.app_accounts a
  where s.auth_uid=auth.uid()
    and a.id=s.account_id
    and a.bound_device_id=p_device_id
    and s.device_id=p_device_id
    and s.password_version=a.password_version
    and not a.is_blocked;
  return found;
end $$;

create or replace function public.logout_app_account()
returns boolean language plpgsql security definer set search_path=public as $$
begin
  delete from public.device_sessions where auth_uid=auth.uid();
  return true;
end $$;

create or replace function public.verify_lock_password(p_password text)
returns boolean language plpgsql security definer set search_path=public,extensions as $$
declare v_hash text;
begin
  if public.current_app_role()<>'admin' then return false; end if;
  select lock_password_hash into v_hash from public.app_settings where id=true;
  return v_hash is not null and v_hash=extensions.crypt(p_password,v_hash);
end $$;

create or replace function public.admin_change_lock_password(p_current_password text,p_new_password text)
returns boolean language plpgsql security definer set search_path=public,extensions as $$
declare v_hash text;
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  if length(p_new_password)<4 then raise exception 'New lock password must be at least 4 characters'; end if;
  select lock_password_hash into v_hash from public.app_settings where id=true;
  if v_hash is null or v_hash<>extensions.crypt(p_current_password,v_hash) then raise exception 'Current lock password is incorrect'; end if;
  update public.app_settings set lock_password_hash=extensions.crypt(p_new_password,extensions.gen_salt('bf')) where id=true;
  return true;
end $$;

create or replace function public.admin_create_user(p_username text,p_password text,p_role text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  v_id uuid;
  v_owner uuid;
  v_total integer;
  v_managers integer;
  v_viewers integer;
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  if p_role not in ('admin','viewer') then raise exception 'Invalid role'; end if;
  if length(trim(p_username))<3 then raise exception 'Username must be at least 3 characters'; end if;
  if length(p_password)<6 then raise exception 'Password must be at least 6 characters'; end if;

  select owner_admin_id into v_owner from public.app_settings where id=true;
  select count(*) into v_total from public.app_accounts;
  select count(*) into v_managers from public.app_accounts where role='admin' and id<>v_owner;
  select count(*) into v_viewers from public.app_accounts where role='viewer';

  if v_total>=5 then raise exception 'Maximum 5 accounts are allowed'; end if;
  if p_role='admin' and v_managers>=2 then raise exception 'Maximum 2 Manager accounts are allowed'; end if;
  if p_role='viewer' and v_viewers>=2 then raise exception 'Maximum 2 Viewer accounts are allowed'; end if;

  insert into public.app_accounts(username,password_hash,role)
  values(lower(trim(p_username)),extensions.crypt(p_password,extensions.gen_salt('bf')),p_role)
  returning id into v_id;

  return jsonb_build_object('id',v_id,'username',lower(trim(p_username)),'role',p_role);
end $$;

drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table(
  id uuid,
  username text,
  role text,
  is_owner boolean,
  is_blocked boolean,
  active_now boolean,
  last_seen_at timestamptz,
  bound_device_id text,
  bound_device_name text,
  bound_at timestamptz
)
language plpgsql security definer set search_path=public as $$
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  return query
  select a.id,a.username,a.role,(st.owner_admin_id=a.id),a.is_blocked,
         coalesce(max(ds.last_seen_at)>now()-interval '2 minutes',false),max(ds.last_seen_at),
         a.bound_device_id,a.bound_device_name,a.bound_at
  from public.app_accounts a
  left join public.app_settings st on st.id=true
  left join public.device_sessions ds on ds.account_id=a.id and ds.password_version=a.password_version and ds.device_id=a.bound_device_id
  group by a.id,a.username,a.role,st.owner_admin_id,a.is_blocked,a.bound_device_id,a.bound_device_name,a.bound_at
  order by case when st.owner_admin_id=a.id then 0 when a.role='admin' then 1 else 2 end,a.username;
end $$;

create or replace function public.admin_change_role(p_account_id uuid,p_new_role text)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_owner uuid;
  v_current text;
  v_count integer;
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  if p_new_role not in ('admin','viewer') then raise exception 'Invalid role'; end if;
  select owner_admin_id into v_owner from public.app_settings where id=true;
  if p_account_id=v_owner then raise exception 'Main Admin role cannot be changed'; end if;
  select role into v_current from public.app_accounts where id=p_account_id;
  if v_current is null then raise exception 'User not found'; end if;
  if v_current=p_new_role then return true; end if;

  if p_new_role='admin' then
    select count(*) into v_count from public.app_accounts where role='admin' and id<>v_owner;
    if v_count>=2 then raise exception 'Maximum 2 Manager accounts are allowed'; end if;
  else
    select count(*) into v_count from public.app_accounts where role='viewer';
    if v_count>=2 then raise exception 'Maximum 2 Viewer accounts are allowed'; end if;
  end if;

  update public.app_accounts set role=p_new_role,password_version=password_version+1 where id=p_account_id;
  delete from public.device_sessions where account_id=p_account_id;
  return true;
end $$;

create or replace function public.admin_set_blocked(p_account_id uuid,p_blocked boolean)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_owner uuid;
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  select owner_admin_id into v_owner from public.app_settings where id=true;
  if p_account_id=v_owner then raise exception 'Main Admin cannot be blocked'; end if;
  update public.app_accounts set is_blocked=p_blocked,password_version=password_version+1 where id=p_account_id;
  if not found then raise exception 'User not found'; end if;
  delete from public.device_sessions where account_id=p_account_id;
  return true;
end $$;

create or replace function public.admin_update_user_login(p_account_id uuid,p_new_username text,p_new_password text)
returns boolean language plpgsql security definer set search_path=public,extensions as $$
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  if p_new_username is null and (p_new_password is null or p_new_password='') then raise exception 'Enter a new username or password'; end if;
  if p_new_username is not null and length(trim(p_new_username))<3 then raise exception 'Username must be at least 3 characters'; end if;
  if p_new_password is not null and p_new_password<>'' and length(p_new_password)<6 then raise exception 'Password must be at least 6 characters'; end if;

  update public.app_accounts
  set username=case when p_new_username is null or trim(p_new_username)='' then username else lower(trim(p_new_username)) end,
      password_hash=case when p_new_password is null or p_new_password='' then password_hash else extensions.crypt(p_new_password,extensions.gen_salt('bf')) end,
      password_version=password_version+1
  where id=p_account_id;
  if not found then raise exception 'User not found'; end if;

  delete from public.device_sessions where account_id=p_account_id;
  return true;
end $$;

create or replace function public.admin_remove_device(p_account_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_owner uuid;
begin
  if not public.current_is_owner() then raise exception 'Main Admin access required'; end if;
  select owner_admin_id into v_owner from public.app_settings where id=true;
  if p_account_id=v_owner then raise exception 'Use Recovery only if the Main Admin device must be replaced'; end if;

  update public.app_accounts
  set bound_device_id=null,bound_device_name=null,bound_at=null,password_version=password_version+1
  where id=p_account_id;
  if not found then raise exception 'User not found'; end if;
  delete from public.device_sessions where account_id=p_account_id;
  return true;
end $$;

create or replace function public.admin_change_my_login(p_current_password text,p_new_username text,p_new_password text)
returns boolean language plpgsql security definer set search_path=public,extensions as $$
declare
  v_id uuid;
  v_hash text;
  v_owner boolean;
begin
  if public.current_app_role()<>'admin' then raise exception 'Admin access required'; end if;
  v_id:=public.current_app_account_id();
  v_owner:=public.current_is_owner();
  select password_hash into v_hash from public.app_accounts where id=v_id;
  if v_hash<>extensions.crypt(p_current_password,v_hash) then raise exception 'Current password is incorrect'; end if;

  if not v_owner and p_new_username is not null and trim(p_new_username)<>'' then
    raise exception 'Managers can change only their own password';
  end if;
  if v_owner and p_new_username is not null and length(trim(p_new_username))<3 then raise exception 'Username must be at least 3 characters'; end if;
  if p_new_password is not null and p_new_password<>'' and length(p_new_password)<6 then raise exception 'Password must be at least 6 characters'; end if;
  if not v_owner and (p_new_password is null or p_new_password='') then raise exception 'Enter a new password'; end if;

  update public.app_accounts
  set username=case when v_owner and p_new_username is not null and trim(p_new_username)<>'' then lower(trim(p_new_username)) else username end,
      password_hash=case when p_new_password is null or p_new_password='' then password_hash else extensions.crypt(p_new_password,extensions.gen_salt('bf')) end,
      password_version=password_version+1
  where id=v_id;

  delete from public.device_sessions where account_id=v_id;
  return true;
end $$;

create or replace function public.recover_owner_admin(p_recovery_code text,p_new_username text,p_new_password text)
returns boolean language plpgsql security definer set search_path=public,extensions as $$
declare v_owner uuid; v_hash text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(p_new_username))<3 then raise exception 'Username must be at least 3 characters'; end if;
  if length(p_new_password)<6 then raise exception 'Password must be at least 6 characters'; end if;
  select owner_admin_id,recovery_code_hash into v_owner,v_hash from public.app_settings where id=true;
  if v_owner is null or v_hash is null or v_hash<>extensions.crypt(upper(trim(p_recovery_code)),v_hash) then raise exception 'Invalid recovery code'; end if;

  update public.app_accounts
  set username=lower(trim(p_new_username)),
      password_hash=extensions.crypt(p_new_password,extensions.gen_salt('bf')),
      password_version=password_version+1,
      is_blocked=false,
      role='admin',
      bound_device_id=null,
      bound_device_name=null,
      bound_at=null
  where id=v_owner;
  delete from public.device_sessions where account_id=v_owner;
  return true;
end $$;

revoke all on function public.current_is_owner() from public;
revoke all on function public.admin_update_user_login(uuid,text,text) from public;
revoke all on function public.admin_remove_device(uuid) from public;
grant execute on function public.current_is_owner() to authenticated;
grant execute on function public.admin_update_user_login(uuid,text,text) to authenticated;
grant execute on function public.admin_remove_device(uuid) to authenticated;

revoke all on function public.bootstrap_admin(text,text,text,text,text) from public;
revoke all on function public.login_app_account(text,text,text,text) from public;
revoke all on function public.my_app_session() from public;
revoke all on function public.heartbeat(text,text) from public;
revoke all on function public.admin_change_lock_password(text,text) from public;
revoke all on function public.admin_create_user(text,text,text) from public;
revoke all on function public.admin_list_users() from public;
revoke all on function public.admin_change_role(uuid,text) from public;
revoke all on function public.admin_set_blocked(uuid,boolean) from public;
revoke all on function public.admin_change_my_login(text,text,text) from public;
revoke all on function public.recover_owner_admin(text,text,text) from public;

grant execute on function public.bootstrap_admin(text,text,text,text,text) to authenticated;
grant execute on function public.login_app_account(text,text,text,text) to authenticated;
grant execute on function public.my_app_session() to authenticated;
grant execute on function public.heartbeat(text,text) to authenticated;
grant execute on function public.admin_change_lock_password(text,text) to authenticated;
grant execute on function public.admin_create_user(text,text,text) to authenticated;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_change_role(uuid,text) to authenticated;
grant execute on function public.admin_set_blocked(uuid,boolean) to authenticated;
grant execute on function public.admin_change_my_login(text,text,text) to authenticated;
grant execute on function public.recover_owner_admin(text,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
