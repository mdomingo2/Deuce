-- Row-level security, the tenant boundary, and the constraints that make an
-- invalid league impossible rather than merely discouraged.
--
-- Written by hand rather than generated: drizzle-kit does not model policies,
-- SECURITY DEFINER helpers, or Supabase's auth schema.

--------------------------------------------------------------------------------
-- 1. Tie profiles to Supabase auth
--------------------------------------------------------------------------------

alter table public.profiles
  add constraint profiles_id_fkey
  foreign key (id) references auth.users (id) on delete cascade;

-- A new auth user gets a profile row automatically, so the app never has to
-- handle a signed-in user with nothing to join against.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

--------------------------------------------------------------------------------
-- 2. Tenancy helpers
--
-- SECURITY DEFINER so a policy on org_members can call them without recursing
-- into its own RLS check. search_path is pinned empty and every reference is
-- schema-qualified, which is what keeps a definer function from being hijacked.
--------------------------------------------------------------------------------

create or replace function public.deuce_org_role(p_org_id uuid)
returns public.org_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.org_members m
  where m.org_id = p_org_id
    and m.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function public.deuce_is_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.deuce_org_role(p_org_id) is not null;
$$;

create or replace function public.deuce_is_admin(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.deuce_org_role(p_org_id) in ('owner', 'admin');
$$;

--------------------------------------------------------------------------------
-- 3. A team must field one of each pairing category
--
-- The column names say male/female; without this trigger nothing stops an admin
-- putting two players of the same category in a mixed-doubles team, and the
-- scheduler would then emit an unplayable match.
--------------------------------------------------------------------------------

create or replace function public.deuce_validate_team_pairing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  male_category public.pairing_category;
  female_category public.pairing_category;
begin
  select pairing_category into male_category
    from public.players where id = new.male_player_id;
  select pairing_category into female_category
    from public.players where id = new.female_player_id;

  if male_category is distinct from 'M' then
    raise exception 'team %: male_player_id must reference a player with pairing_category M', new.id
      using errcode = 'check_violation';
  end if;
  if female_category is distinct from 'F' then
    raise exception 'team %: female_player_id must reference a player with pairing_category F', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger deuce_teams_validate_pairing
  before insert or update of male_player_id, female_player_id on public.teams
  for each row execute function public.deuce_validate_team_pairing();

--------------------------------------------------------------------------------
-- 4. The entitlement ledger is append-only
--
-- The guarantee is a promise about money. A balance that can be edited in place
-- is a balance nobody can audit, so updates and deletes are revoked outright --
-- corrections are made by writing a compensating row with reason 'admin_adjust'.
--------------------------------------------------------------------------------

revoke update, delete on public.entitlement_ledger from anon, authenticated;

create or replace function public.deuce_entitlement_ledger_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'entitlement_ledger is append-only; write a compensating row instead'
    using errcode = 'restrict_violation';
end;
$$;

create trigger deuce_entitlement_ledger_no_mutate
  before update or delete on public.entitlement_ledger
  for each row execute function public.deuce_entitlement_ledger_is_append_only();

--------------------------------------------------------------------------------
-- 5. Enable row-level security everywhere
--------------------------------------------------------------------------------

alter table public.orgs                  enable row level security;
alter table public.org_members           enable row level security;
alter table public.profiles              enable row level security;
alter table public.leagues               enable row level security;
alter table public.venues                enable row level security;
alter table public.courts                enable row level security;
alter table public.seasons               enable row level security;
alter table public.season_courts         enable row level security;
alter table public.time_slots            enable row level security;
alter table public.weeks                 enable row level security;
alter table public.blackouts             enable row level security;
alter table public.players               enable row level security;
alter table public.teams                 enable row level security;
alter table public.season_registrations  enable row level security;
alter table public.entitlement_ledger    enable row level security;
alter table public.products              enable row level security;
alter table public.orders                enable row level security;
alter table public.payments              enable row level security;

--------------------------------------------------------------------------------
-- 6. Policies
--------------------------------------------------------------------------------

-- Profiles: you see and edit your own, and you can see anyone who shares an org
-- with you (so the schedule can show your opponents' names).
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.org_members mine
      join public.org_members theirs on theirs.org_id = mine.org_id
      where mine.user_id = (select auth.uid())
        and theirs.user_id = public.profiles.id
    )
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Orgs and membership.
create policy orgs_select_member on public.orgs
  for select to authenticated
  using (public.deuce_is_member(id));

create policy orgs_update_admin on public.orgs
  for update to authenticated
  using (public.deuce_is_admin(id))
  with check (public.deuce_is_admin(id));

create policy org_members_select on public.org_members
  for select to authenticated
  using (public.deuce_is_member(org_id));

create policy org_members_write_admin on public.org_members
  for all to authenticated
  using (public.deuce_is_admin(org_id))
  with check (public.deuce_is_admin(org_id));

-- Everything else follows the same two-line shape: members read, admins write.
do $$
declare
  t text;
begin
  foreach t in array array[
    'leagues', 'venues', 'courts', 'seasons', 'season_courts', 'time_slots',
    'weeks', 'blackouts', 'players', 'teams', 'season_registrations',
    'products', 'orders', 'payments'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.deuce_is_member(org_id))',
      t || '_select_member', t
    );
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.deuce_is_admin(org_id)) with check (public.deuce_is_admin(org_id))',
      t || '_write_admin', t
    );
  end loop;
end;
$$;

-- The ledger reads like everything else but only ever accepts inserts.
create policy entitlement_ledger_select_member on public.entitlement_ledger
  for select to authenticated
  using (public.deuce_is_member(org_id));

create policy entitlement_ledger_insert_admin on public.entitlement_ledger
  for insert to authenticated
  with check (public.deuce_is_admin(org_id));
