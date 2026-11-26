-- =============================================================================
-- PLANEJAMENTO EDITORIAL • ASCOM COHAB MINAS
-- Schema Supabase com segurança em profundidade:
--   • Row Level Security (RLS) em TODAS as tabelas
--   • Papéis no servidor: admin | editor | leitor (nunca definidos pelo navegador)
--   • Administrador só exerce poderes de admin com MFA (aal2)
--   • Auditoria gerada por triggers no banco (não pode ser forjada pelo cliente)
--   • Log imutável (sem UPDATE/DELETE para ninguém via API)
--   • Validações de tamanho/valores com CHECK constraints
--
-- Como usar: Supabase → SQL Editor → New query → cole TODO este arquivo → Run.
-- O script pode ser executado novamente com segurança (idempotente).
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. TIPOS
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('admin', 'editor', 'leitor');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- 2. TABELAS
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nome        text not null default '' check (char_length(nome) <= 120),
  email       text not null default '',
  role        public.app_role not null default 'leitor',
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.pautas (
  id           uuid primary key default gen_random_uuid(),
  titulo       text not null check (char_length(btrim(titulo)) between 1 and 200),
  data         date not null,
  tipo         text not null default 'FRIA' check (tipo in ('QUENTE', 'FRIA')),
  prioridade   integer not null default 1 check (prioridade between 1 and 9999),
  status       text not null default 'A Fazer'
                 check (status in ('A Fazer', 'Produzindo', 'Aprovado', 'Publicado')),
  responsaveis text[] not null default '{}' check (cardinality(responsaveis) <= 20),
  formato      text check (formato is null or char_length(formato) <= 60),
  editoria     text not null default 'Serviços' check (char_length(editoria) <= 60),
  descricao    text check (descricao is null or char_length(descricao) <= 5000),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pautas_data_idx on public.pautas (data);
create index if not exists pautas_status_idx on public.pautas (status);

create table if not exists public.sugestoes (
  id          uuid primary key default gen_random_uuid(),
  titulo      text not null check (char_length(btrim(titulo)) between 1 and 200),
  tipo        text not null default 'FRIA' check (tipo in ('QUENTE', 'FRIA')),
  formato     text check (formato is null or char_length(formato) <= 60),
  editoria    text not null default 'Serviços' check (char_length(editoria) <= 60),
  descricao   text check (descricao is null or char_length(descricao) <= 2000),
  autor_id    uuid references auth.users(id) on delete set null,
  autor_nome  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.editorias (
  nome        text primary key check (char_length(btrim(nome)) between 1 and 60),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists editorias_nome_lower_idx on public.editorias (lower(nome));
insert into public.editorias (nome) values ('Serviços') on conflict do nothing;

create table if not exists public.logs (
  id          bigint generated always as identity primary key,
  acao        text not null check (acao in
                ('CRIAÇÃO','EDIÇÃO','EXCLUSÃO','STATUS','HIERARQUIA','SUGESTÃO','NOTA','USUÁRIO','ACESSO')),
  detalhe     text not null check (char_length(detalhe) between 1 and 1000),
  user_id     uuid references auth.users(id) on delete set null,
  user_nome   text,
  created_at  timestamptz not null default now()
);
create index if not exists logs_created_idx on public.logs (created_at desc);

-- -----------------------------------------------------------------------------
-- 3. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO
--    SECURITY DEFINER + search_path fixo (evita sequestro de search_path)
-- -----------------------------------------------------------------------------

-- Altere para "select false" SOMENTE em emergência (ex.: admin perdeu o app autenticador).
create or replace function public.mfa_required_for_admin()
returns boolean language sql immutable as $$ select true $$;

create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and ativo
$$;

create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_app_role() is not null
$$;

create or replace function public.can_edit()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() in ('admin', 'editor'), false)
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = 'admin', false)
     and (not public.mfa_required_for_admin()
          or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2')
$$;

-- Registro interno de auditoria (NÃO exposto à API)
create or replace function public.log_event(p_acao text, p_detalhe text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.logs (acao, detalhe, user_id, user_nome)
  values (
    p_acao,
    left(coalesce(nullif(btrim(p_detalhe), ''), '-'), 1000),
    auth.uid(),
    coalesce((select nome from public.profiles where id = auth.uid()), 'Sistema')
  );
end $$;

-- -----------------------------------------------------------------------------
-- 4. TRIGGERS
-- -----------------------------------------------------------------------------

-- 4.1 Novo usuário no Auth → perfil "leitor" (papel NUNCA vem do metadata do cliente)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome, email, role)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''), split_part(coalesce(new.email, ''), '@', 1)), 120),
    coalesce(new.email, ''),
    'leitor'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4.2 Proteção de perfil: só admin (com MFA) muda papel/status; ninguém muda o próprio
create or replace function public.protect_profile()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- service_role (Edge Function) e SQL Editor (sem JWT) passam
  if coalesce(auth.role(), '') <> 'authenticated' then
    new.updated_at := now();
    return new;
  end if;

  if new.id <> old.id or new.email <> old.email or new.created_at <> old.created_at then
    raise exception 'Campo protegido do perfil.' using errcode = '42501';
  end if;

  if new.role <> old.role or new.ativo <> old.ativo then
    if not public.is_admin() then
      raise exception 'Apenas administradores (com verificação em duas etapas) podem alterar papel ou status.'
        using errcode = '42501';
    end if;
    if old.id = auth.uid() then
      raise exception 'Você não pode alterar o seu próprio papel ou status.' using errcode = '42501';
    end if;
  end if;

  new.nome := left(btrim(new.nome), 120);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect
  before update on public.profiles
  for each row execute function public.protect_profile();

create or replace function public.audit_profiles()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
  if new.role <> old.role then
    perform public.log_event('USUÁRIO', format('Papel de "%s" alterado de "%s" para "%s".', new.nome, old.role, new.role));
  end if;
  if new.ativo <> old.ativo then
    perform public.log_event('USUÁRIO', format('Acesso de "%s" %s.', new.nome, case when new.ativo then 'reativado' else 'desativado' end));
  end if;
  return new;
end $$;

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after update on public.profiles
  for each row execute function public.audit_profiles();

-- 4.3 Pautas: carimbo de autoria pelo servidor
create or replace function public.stamp_pautas()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.titulo := btrim(new.titulo);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists pautas_stamp on public.pautas;
create trigger pautas_stamp
  before insert or update on public.pautas
  for each row execute function public.stamp_pautas();

-- 4.4 Pautas: auditoria automática
create or replace function public.audit_pautas()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event('CRIAÇÃO', format('Nova pauta criada: "%s" (%s).', new.titulo, to_char(new.data, 'DD/MM/YYYY')));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform public.log_event('STATUS', format('Status de "%s" alterado de "%s" para "%s".', new.titulo, old.status, new.status));
    end if;
    if (new.titulo, new.data, new.tipo, new.responsaveis, new.formato, new.editoria, new.descricao)
       is distinct from
       (old.titulo, old.data, old.tipo, old.responsaveis, old.formato, old.editoria, old.descricao) then
      perform public.log_event('EDIÇÃO', format('Pauta "%s" atualizada.', new.titulo));
    end if;
  elsif tg_op = 'DELETE' then
    perform public.log_event('EXCLUSÃO', format('Pauta excluída: "%s".', old.titulo));
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists pautas_audit on public.pautas;
create trigger pautas_audit
  after insert or update or delete on public.pautas
  for each row execute function public.audit_pautas();

-- 4.5 Sugestões: autoria + auditoria
create or replace function public.stamp_sugestoes()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.titulo := btrim(new.titulo);
  new.autor_id := auth.uid();
  new.autor_nome := coalesce((select nome from public.profiles where id = auth.uid()), 'Equipe Ascom');
  new.created_at := now();
  return new;
end $$;

drop trigger if exists sugestoes_stamp on public.sugestoes;
create trigger sugestoes_stamp
  before insert on public.sugestoes
  for each row execute function public.stamp_sugestoes();

create or replace function public.audit_sugestoes()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event('SUGESTÃO', format('Nova sugestão adicionada: "%s".', new.titulo));
  elsif tg_op = 'DELETE' then
    perform public.log_event('SUGESTÃO', format('Sugestão removida ou agendada: "%s".', old.titulo));
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists sugestoes_audit on public.sugestoes;
create trigger sugestoes_audit
  after insert or delete on public.sugestoes
  for each row execute function public.audit_sugestoes();

-- 4.6 Editorias: autoria
create or replace function public.stamp_editorias()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.nome := btrim(new.nome);
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end $$;

drop trigger if exists editorias_stamp on public.editorias;
create trigger editorias_stamp
  before insert on public.editorias
  for each row execute function public.stamp_editorias();

-- 4.7 Logs: usuário logado não pode se passar por outro
create or replace function public.stamp_logs()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    new.user_id := auth.uid();
    new.user_nome := coalesce((select nome from public.profiles where id = auth.uid()), 'Sistema');
    new.created_at := now();
  end if;
  new.detalhe := left(btrim(new.detalhe), 1000);
  return new;
end $$;

drop trigger if exists logs_stamp on public.logs;
create trigger logs_stamp
  before insert on public.logs
  for each row execute function public.stamp_logs();

-- -----------------------------------------------------------------------------
-- 5. RPCs (funções chamadas pelo app)
-- -----------------------------------------------------------------------------
create or replace function public.reordenar_prioridades(p_ids uuid[], p_motivo text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then
    raise exception 'Sem permissão para reordenar prioridades.' using errcode = '42501';
  end if;
  if cardinality(p_ids) > 2000 then
    raise exception 'Lista muito grande.';
  end if;

  update public.pautas p
     set prioridade = x.ord
    from unnest(p_ids) with ordinality as x(id, ord)
   where p.id = x.id
     and p.status <> 'Publicado'
     and p.prioridade is distinct from x.ord::int;

  if p_motivo is not null and btrim(p_motivo) <> '' then
    perform public.log_event('HIERARQUIA', left(p_motivo, 300));
  end if;
end $$;

create or replace function public.registrar_acesso()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then return; end if;
  perform public.log_event('ACESSO', 'Login realizado no sistema.');
end $$;

-- -----------------------------------------------------------------------------
-- 6. PERMISSÕES (menor privilégio)
-- -----------------------------------------------------------------------------
revoke all on public.profiles, public.pautas, public.sugestoes, public.editorias, public.logs from anon;
revoke all on public.profiles, public.pautas, public.sugestoes, public.editorias, public.logs from authenticated;

grant select, update            on public.profiles  to authenticated;
grant select, insert, update, delete on public.pautas to authenticated;
grant select, insert, delete    on public.sugestoes to authenticated;
grant select, insert, delete    on public.editorias to authenticated;
grant select, insert            on public.logs      to authenticated;

revoke execute on function public.log_event(text, text)              from public, anon, authenticated;
revoke execute on function public.handle_new_user()                  from public, anon, authenticated;
revoke execute on function public.reordenar_prioridades(uuid[], text) from public, anon;
revoke execute on function public.registrar_acesso()                 from public, anon;
grant  execute on function public.reordenar_prioridades(uuid[], text) to authenticated;
grant  execute on function public.registrar_acesso()                 to authenticated;
grant  execute on function public.is_admin(), public.can_edit(), public.is_member(),
                           public.current_app_role(), public.mfa_required_for_admin() to authenticated;
revoke execute on function public.is_admin(), public.can_edit(), public.is_member(),
                           public.current_app_role() from anon;

-- -----------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.pautas    enable row level security;
alter table public.sugestoes enable row level security;
alter table public.editorias enable row level security;
alter table public.logs      enable row level security;


-- Remove políticas antigas (permite reexecutar)
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('profiles','pautas','sugestoes','editorias','logs')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- PROFILES
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_member());
create policy profiles_update on public.profiles for update to authenticated
  using ((id = auth.uid() and public.is_member()) or public.is_admin())
  with check ((id = auth.uid() and public.is_member()) or public.is_admin());

-- PAUTAS
create policy pautas_select on public.pautas for select to authenticated
  using (public.is_member());
create policy pautas_insert on public.pautas for insert to authenticated
  with check (public.can_edit());
create policy pautas_update on public.pautas for update to authenticated
  using (public.can_edit()) with check (public.can_edit());
create policy pautas_delete on public.pautas for delete to authenticated
  using (public.is_admin());

-- SUGESTÕES
create policy sugestoes_select on public.sugestoes for select to authenticated
  using (public.is_member());
create policy sugestoes_insert on public.sugestoes for insert to authenticated
  with check (public.can_edit());
create policy sugestoes_delete on public.sugestoes for delete to authenticated
  using (public.can_edit());

-- EDITORIAS
create policy editorias_select on public.editorias for select to authenticated
  using (public.is_member());
create policy editorias_insert on public.editorias for insert to authenticated
  with check (public.can_edit());
create policy editorias_delete on public.editorias for delete to authenticated
  using (public.is_admin());

-- LOGS (imutáveis: sem update/delete)
create policy logs_select on public.logs for select to authenticated
  using (public.is_member());
create policy logs_insert_nota on public.logs for insert to authenticated
  with check (public.can_edit() and acao = 'NOTA');

-- -----------------------------------------------------------------------------
-- 8. REALTIME (sincronização ao vivo entre a equipe — respeita RLS)
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pautas','sugestoes','editorias','logs','profiles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
              when undefined_object then null;
    end;
  end loop;
end $$;

-- =============================================================================
-- 9. PRIMEIRO ADMINISTRADOR (rode separadamente, depois de criar o usuário
--    em Authentication → Users → Add user). Troque o e-mail:
--
--    update public.profiles set role = 'admin', nome = 'Seu Nome'
--    where email = 'seu.email@cohab.mg.gov.br';
-- =============================================================================
