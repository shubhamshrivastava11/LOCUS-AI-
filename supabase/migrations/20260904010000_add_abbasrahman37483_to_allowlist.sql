-- Add abbasrahman37483@gmail.com to the early access allowlist.
-- See 20260812000000_early_access_allowlist.sql for the original gate and
-- 20260816010000_add_shubham_to_allowlist.sql for the previous addition -
-- same function, same behavior, one more email.

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
    'abbasrahman37483@gmail.com'
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
