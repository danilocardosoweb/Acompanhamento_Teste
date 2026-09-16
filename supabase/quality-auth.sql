create or replace function public.quality_verify_existing_user(p_email text, p_password text)
returns table(user_id uuid, email text, name text, role text)
language sql
security definer
set search_path = public, extensions
as $$
  select u.id, u.email, u.name, u.role
  from public.users u
  where lower(u.email) = lower(trim(p_email))
    and coalesce(u.is_active, true)
    and (
      u.password_hash = encode(convert_to(p_password, 'UTF8'), 'base64')
      or (u.password_hash like '$2%' and extensions.crypt(p_password, u.password_hash) = u.password_hash)
    )
  limit 1;
$$;

revoke all on function public.quality_verify_existing_user(text,text) from public, anon, authenticated;
grant execute on function public.quality_verify_existing_user(text,text) to service_role;
