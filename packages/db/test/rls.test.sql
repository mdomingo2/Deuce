-- Row-level security tests.
--
-- Every assertion runs as a real `authenticated` session with auth.uid() set,
-- because RLS is bypassed for superusers and a test that forgets to switch role
-- proves nothing at all.
--
-- Run: psql -v ON_ERROR_STOP=1 -d deuce_test -f test/rls.test.sql

\set ORG_A   '11111111-1111-1111-1111-111111111111'
\set ORG_B   '22222222-2222-2222-2222-222222222222'
\set ADMIN_A 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set ADMIN_B 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set MEMBER_A 'cccccccc-cccc-cccc-cccc-cccccccccccc'

begin;

--------------------------------------------------------------------------------
-- Seed two independent orgs as superuser.
--------------------------------------------------------------------------------

insert into auth.users (id, email) values
  (:'ADMIN_A', 'admin-a@example.test'),
  (:'ADMIN_B', 'admin-b@example.test'),
  (:'MEMBER_A', 'member-a@example.test');

insert into public.orgs (id, slug, name) values
  (:'ORG_A', 'org-a', 'Jamison Mixed Doubles'),
  (:'ORG_B', 'org-b', 'Rival Club');

insert into public.org_members (org_id, user_id, role) values
  (:'ORG_A', :'ADMIN_A', 'admin'),
  (:'ORG_B', :'ADMIN_B', 'admin'),
  (:'ORG_A', :'MEMBER_A', 'member');

insert into public.players (id, org_id, first_name, last_name, pairing_category) values
  ('a0000000-0000-0000-0000-000000000001', :'ORG_A', 'Mike',  'Domingo',  'M'),
  ('a0000000-0000-0000-0000-000000000002', :'ORG_A', 'Sarah', 'Domingo',  'F'),
  ('a0000000-0000-0000-0000-000000000003', :'ORG_A', 'Dana',  'Hoffman',  'F'),
  ('b0000000-0000-0000-0000-000000000001', :'ORG_B', 'Rival', 'Player',   'M');

insert into public.leagues (id, org_id, name) values
  ('a1000000-0000-0000-0000-000000000001', :'ORG_A', 'Tuesday Mixed');

insert into public.seasons (id, org_id, league_id, name, start_date, night_of_week) values
  ('a2000000-0000-0000-0000-000000000001', :'ORG_A',
   'a1000000-0000-0000-0000-000000000001', 'Spring 2026', '2026-04-07', 2);

insert into public.teams (id, org_id, season_id, name, male_player_id, female_player_id) values
  ('a3000000-0000-0000-0000-000000000001', :'ORG_A',
   'a2000000-0000-0000-0000-000000000001', 'Domingo',
   'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000002');

insert into public.entitlement_ledger (org_id, season_id, team_id, delta, reason) values
  (:'ORG_A', 'a2000000-0000-0000-0000-000000000001',
   'a3000000-0000-0000-0000-000000000001', 12, 'purchase');

--------------------------------------------------------------------------------
-- The tenant boundary: org A sees none of org B.
--------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

do $$
declare
  visible int;
begin
  select count(*) into visible from public.players;
  if visible <> 3 then
    raise exception 'admin A should see exactly org A''s 3 players, saw %', visible;
  end if;

  select count(*) into visible from public.players where org_id = '22222222-2222-2222-2222-222222222222';
  if visible <> 0 then
    raise exception 'admin A leaked % rows from org B', visible;
  end if;

  select count(*) into visible from public.orgs;
  if visible <> 1 then
    raise exception 'admin A should see exactly 1 org, saw %', visible;
  end if;

  select count(*) into visible from public.teams;
  if visible <> 1 then
    raise exception 'admin A should see 1 team, saw %', visible;
  end if;
end;
$$;

reset role;

--------------------------------------------------------------------------------
-- A plain member reads but does not write.
--------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

do $$
declare
  visible int;
  blocked boolean := false;
begin
  select count(*) into visible from public.players;
  if visible <> 3 then
    raise exception 'member should read the roster, saw %', visible;
  end if;

  begin
    insert into public.players (org_id, first_name, last_name, pairing_category)
    values ('11111111-1111-1111-1111-111111111111', 'Sneaky', 'Insert', 'M');
  exception when insufficient_privilege then
    blocked := true;
  end;

  if not blocked then
    raise exception 'a plain member was able to insert a player';
  end if;
end;
$$;

reset role;

--------------------------------------------------------------------------------
-- The entitlement ledger is append-only, even for an admin.
--------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

do $$
declare
  blocked boolean := false;
  balance int;
begin
  select sum(delta) into balance from public.entitlement_ledger;
  if balance <> 12 then
    raise exception 'expected a balance of 12 weeks, got %', balance;
  end if;

  begin
    update public.entitlement_ledger set delta = 99;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'entitlement_ledger accepted an UPDATE';
  end if;

  blocked := false;
  begin
    delete from public.entitlement_ledger;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'entitlement_ledger accepted a DELETE';
  end if;

  -- A correction is a compensating row, which leaves the history readable.
  insert into public.entitlement_ledger (org_id, season_id, team_id, delta, reason, note)
  values ('11111111-1111-1111-1111-111111111111',
          'a2000000-0000-0000-0000-000000000001',
          'a3000000-0000-0000-0000-000000000001',
          -1, 'admin_adjust', 'Sold one week too many');

  select sum(delta) into balance from public.entitlement_ledger;
  if balance <> 11 then
    raise exception 'compensating row should leave a balance of 11, got %', balance;
  end if;
end;
$$;

reset role;

--------------------------------------------------------------------------------
-- A mixed-doubles team must field one of each pairing category.
--------------------------------------------------------------------------------

do $$
declare
  blocked boolean := false;
begin
  begin
    insert into public.teams (org_id, season_id, name, male_player_id, female_player_id)
    values ('11111111-1111-1111-1111-111111111111',
            'a2000000-0000-0000-0000-000000000001',
            'Invalid',
            'a0000000-0000-0000-0000-000000000003',  -- Dana, category F
            'a0000000-0000-0000-0000-000000000002');
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'teams accepted an F player in the male seat';
  end if;
end;
$$;

--------------------------------------------------------------------------------
-- Nobody can be on two teams in the same season.
--------------------------------------------------------------------------------

do $$
declare
  blocked boolean := false;
begin
  begin
    insert into public.teams (org_id, season_id, name, male_player_id, female_player_id)
    values ('11111111-1111-1111-1111-111111111111',
            'a2000000-0000-0000-0000-000000000001',
            'Domingo again',
            'a0000000-0000-0000-0000-000000000001',  -- already on team Domingo
            'a0000000-0000-0000-0000-000000000003');
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a player was placed on two teams in one season';
  end if;
end;
$$;

rollback;

\echo 'RLS + constraint tests passed.'
