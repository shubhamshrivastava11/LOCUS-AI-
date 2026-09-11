-- Real gap this closes: handle_new_user() unconditionally auto-created a
-- solo tenant the instant an allowlisted email signed in, synchronously,
-- before the frontend could ever ask "individual or team?" - by the time
-- any UI could show a choice, the decision was already made. This moves
-- the allowlist into a real, frontend-checkable table (own-email-only RLS)
-- and removes the auto-provisioning entirely; a new team-invites action
-- (create_workspace) now owns tenant creation on demand, alongside the
-- existing invite-accept path for joining an existing one.

create table public.early_access_allowlist (
  email      text primary key,
  added_at   timestamptz not null default now()
);
alter table public.early_access_allowlist enable row level security;
alter table public.early_access_allowlist force row level security;

-- A user can only ever check their OWN eligibility - never enumerate or
-- probe who else is allowlisted.
create policy early_access_allowlist_select_own on public.early_access_allowlist
  for select
  to authenticated
  using (lower(email) = lower(auth.email()));

insert into public.early_access_allowlist (email) values
  ('djagani@umich.edu'),
  ('saishrivastava09@gmail.com'),
  ('saiapurva.shrivastava04@gmail.com'),
  ('kirtirungta60@gmail.com'),
  ('lam.dao@cstu.edu'),
  ('tansalmir.digi@gmail.com'),
  ('apply@pmaccelerator.io'),
  ('soumyasharma364@gmail.com'),
  ('moniqueamavour@gmail.com'),
  ('anil.thomas.mba@gmail.com'),
  ('shrivastavashubham213@gmail.com'),
  ('abbasrahman37483@gmail.com');

-- Going forward, granting access is a plain insert into this table - no
-- more full migration + function redefinition per person.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
