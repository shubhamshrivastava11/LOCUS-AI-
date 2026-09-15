-- Invites can name any role the inviter is allowed to hand out.
--
-- invites.role was constrained to admin | member, which was the whole role
-- model at the time. With Lead and Guest added it has to widen or the two
-- new levels are unreachable by the only route anybody joins a workspace
-- through.
--
-- Owner is deliberately NOT in the list. Ownership is transferred, never
-- invited: an invite is accepted by whoever holds the link, and "click here
-- to become an owner of this workspace" is not a thing that should exist.

alter table public.invites drop constraint if exists invites_role_check;
alter table public.invites add constraint invites_role_check
  check (role in ('admin', 'lead', 'member', 'guest'));

-- How long a Guest's membership lasts, carried on the invite so the expiry is
-- decided when the invitation is written rather than negotiated at accept
-- time. Null for every other role, and null for a Guest means "no expiry set",
-- which accept turns into the default window rather than into forever.
alter table public.invites
  add column if not exists membership_expires_at timestamptz;
