-- RECOVERED FILE. The original was never committed; this content was read
-- back out of supabase_migrations.schema_migrations.statements on
-- 14 Sep 2026, which is where Supabase records the SQL it actually ran.
-- Byte-for-byte what was applied to production on 2026-08-24, so the repo and
-- the ledger now agree. Do not re-run it by hand; it is already applied.
--
-- Adds 13 new early-access emails to the signup allowlist. Same function,
-- same behavior as every prior allowlist migration (20260812000000,
-- 20260816010000) - only the array grows, one more entry each time,
-- append-only so no existing early-access user's access is affected.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_tenant_id uuid := gen_random_uuid();
  base_slug text;
  final_slug text;
  allowed_emails text[] := array[
    'djagani@umich.edu',
    'saishrivastava09@gmail.com',
    'saiapurva.shrivastava04@gmail.com',
    'kirtirungta60@gmail.com',
    'lam.dao@cstu.edu',
    'tansalmir.digi@gmail.com',
    'apply@pmaccelerator.io',
    'soumyasharma364@gmail.com',
    'moniqueamavour@gmail.com',
    'anil.thomas.mba@gmail.com',
    'shrivastavashubham213@gmail.com',
    'shivani.krovvidi88@gmail.com',
    'omowunmiabosedejimoh@gmail.com',
    'ankita.bhargava301@gmail.com',
    'niranjcb@gmail.com',
    'smithajadhav.sm@gmail.com',
    'aadisur1234@gmail.com',
    'yashpise98@gmail.com',
    'ashishshrivastava2911@gmail.com',
    'pandhare.paras6@gmail.com',
    'mvsadi5@gmail.com',
    'beohar13@gmail.com',
    'animeshshukla2510@gmail.com',
    'kratikaixit3@gmail.com'
  ];
begin
  if not (lower(new.email) = any(allowed_emails)) then
    return new;
  end if;

  base_slug := lower(
    regexp_replace(
      coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1), 'workspace'),
      '[^a-zA-Z0-9]+',
      '-',
      'g'
    )
  );
  final_slug := trim(both '-' from base_slug) || '-' || substr(replace(new_tenant_id::text, '-', ''), 1, 8);

  insert into public.tenants (id, name, slug, plan)
  values (
    new_tenant_id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email, 'My Workspace'),
    final_slug,
    'self_serve'
  );

  insert into public.memberships (tenant_id, user_id, role)
  values (new_tenant_id, new.id, 'owner');

  return new;
end;
$$;
