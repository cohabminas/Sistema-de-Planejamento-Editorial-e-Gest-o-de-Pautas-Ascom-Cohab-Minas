-- =============================================================================
-- 002 • Usuários ativos com papel do cadastro, dispositivos confiáveis (2FA),
--       preferência de tema e permissões da Edge Function
-- (já incluído no schema.sql; use este arquivo só em bancos criados antes)
-- =============================================================================

-- 1. Permissões para a Edge Function (service_role) -----------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

-- 2. Preferência de tema -------------------------------------------------------
alter table public.profiles
  add column if not exists tema text check (tema in ('claro', 'escuro'));

-- 3. Novo usuário: ATIVO e com o papel definido pelo administrador -------------
--    O papel vem de raw_app_meta_data, que só o servidor (service_role) grava.
--    Cadastro público está desligado no Supabase.
alter table public.profiles alter column ativo set default true;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := 'leitor';
begin
  if (new.raw_app_meta_data ->> 'role') in ('admin', 'editor', 'leitor') then
    v_role := (new.raw_app_meta_data ->> 'role')::public.app_role;
  end if;

  insert into public.profiles (id, nome, email, role, ativo)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''), split_part(coalesce(new.email, ''), '@', 1)), 120),
    coalesce(new.email, ''),
    v_role,
    true
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- 4. Dispositivos confiáveis ---------------------------------------------------
create table if not exists public.trusted_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  token_hash   text not null unique,
  ua_hash      text not null,
  label        text not null default 'Dispositivo' check (char_length(label) <= 120),
  last_ip      text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists trusted_devices_user_idx on public.trusted_devices (user_id);

-- Sessão (login) liberada por um dispositivo confiável. Some quando a sessão termina.
create table if not exists public.trusted_sessions (
  session_id  uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  device_id   uuid not null references public.trusted_devices(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists trusted_sessions_user_idx on public.trusted_sessions (user_id);
create index if not exists trusted_sessions_device_idx on public.trusted_sessions (device_id);

do $$ begin
  alter table public.trusted_sessions
    add constraint trusted_sessions_session_fk
    foreign key (session_id) references auth.sessions(id) on delete cascade;
exception when duplicate_object then null;
          when undefined_table then null;
end $$;

alter table public.trusted_devices  enable row level security;
alter table public.trusted_sessions enable row level security;

revoke all on public.trusted_devices, public.trusted_sessions from anon, authenticated;
grant select (id, label, last_ip, created_at, last_used_at, expires_at), delete
  on public.trusted_devices to authenticated;
grant select, insert, update, delete on public.trusted_devices, public.trusted_sessions to service_role;

drop policy if exists trusted_devices_select_own on public.trusted_devices;
drop policy if exists trusted_devices_delete_own on public.trusted_devices;
create policy trusted_devices_select_own on public.trusted_devices for select to authenticated
  using (user_id = (select auth.uid()));
create policy trusted_devices_delete_own on public.trusted_devices for delete to authenticated
  using (user_id = (select auth.uid()));
-- trusted_sessions: nenhuma política → inacessível pela API (só service_role / funções definer)

-- 5. Administrador: MFA (aal2) OU sessão liberada por dispositivo confiável ----
create or replace function public.session_is_trusted()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.trusted_sessions ts
     where ts.user_id = auth.uid()
       and ts.session_id::text = coalesce(auth.jwt() ->> 'session_id', '')
       and ts.expires_at > now()
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = 'admin', false)
     and (not public.mfa_required_for_admin()
          or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
          or public.session_is_trusted())
$$;

-- Senha temporária: enquanto não trocar, o usuário não acessa nenhum dado
create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles
   where id = auth.uid() and ativo
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'must_change_password', 'false') <> 'true'
$$;

revoke execute on function public.session_is_trusted() from public, anon;
grant  execute on function public.session_is_trusted() to authenticated, service_role;
grant  execute on function public.is_admin(), public.can_edit(), public.is_member(),
                           public.current_app_role(), public.mfa_required_for_admin() to service_role;

-- 6. Situações de risco → revoga dispositivos confiáveis automaticamente --------
create or replace function public.revoke_trusted_devices(p_user uuid)
returns void
language sql security definer set search_path = public as $$
  delete from public.trusted_devices where user_id = p_user;
$$;
revoke execute on function public.revoke_trusted_devices(uuid) from public, anon, authenticated;

-- 6a. Senha alterada
create or replace function public.on_auth_password_change()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    perform public.revoke_trusted_devices(new.id);
  end if;
  return new;
end $$;
drop trigger if exists on_auth_password_change on auth.users;
create trigger on_auth_password_change
  after update of encrypted_password on auth.users
  for each row execute function public.on_auth_password_change();

-- 6b. Fator 2FA removido ou trocado
create or replace function public.on_mfa_factor_removed()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.revoke_trusted_devices(old.user_id);
  return old;
end $$;
do $$ begin
  drop trigger if exists on_mfa_factor_removed on auth.mfa_factors;
  create trigger on_mfa_factor_removed
    after delete on auth.mfa_factors
    for each row execute function public.on_mfa_factor_removed();
exception when undefined_table then null;
end $$;

-- 6c. Usuário desativado ou com papel alterado
create or replace function public.on_profile_risk_change()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.ativo and not new.ativo) or new.role <> old.role then
    perform public.revoke_trusted_devices(new.id);
  end if;
  return new;
end $$;
drop trigger if exists profiles_risk_change on public.profiles;
create trigger profiles_risk_change
  after update on public.profiles
  for each row execute function public.on_profile_risk_change();

-- 7. Corrige perfis criados antes desta correção --------------------------------
update public.profiles p
   set ativo = true
  from auth.users u
 where u.id = p.id and not p.ativo and u.banned_until is null;
