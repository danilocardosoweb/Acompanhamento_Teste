-- Estruturas exclusivas do painel de Qualidade. Nenhuma tabela compartilhada é alterada.
begin;

create table if not exists public.quality_whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  whatsapp_group_id text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quality_whatsapp_event_settings (
  event_type text primary key check (event_type in ('novo_teste','ferramenta_aprovada','ferramenta_reprovada','nova_correcao','ferramenta_liberada','ferramenta_enviada_correcao','ferramenta_recebida','ferramenta_atrasada')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.quality_whatsapp_event_settings(event_type,enabled) values
  ('novo_teste',false),('ferramenta_aprovada',false),('ferramenta_reprovada',false),('nova_correcao',false),
  ('ferramenta_liberada',false),('ferramenta_enviada_correcao',false),('ferramenta_recebida',false),('ferramenta_atrasada',false)
on conflict (event_type) do nothing;

create table if not exists public.quality_whatsapp_notifications (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null references public.quality_whatsapp_event_settings(event_type),
  entity_id text,
  tool text not null default '',
  client text not null default '',
  title text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  responsible text not null default '',
  event_status text not null default '',
  event_at timestamptz not null default now(),
  whatsapp_group_id text not null,
  whatsapp_group_name text not null default '',
  delivery_status text not null default 'pendente' check (delivery_status in ('pendente','processando','enviado','erro')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quality_whatsapp_notifications_pending_idx
  on public.quality_whatsapp_notifications(delivery_status,created_at)
  where delivery_status in ('pendente','erro','processando');
create index if not exists quality_whatsapp_notifications_tool_idx
  on public.quality_whatsapp_notifications(upper(tool),event_at desc);

alter table public.quality_whatsapp_groups enable row level security;
alter table public.quality_whatsapp_event_settings enable row level security;
alter table public.quality_whatsapp_notifications enable row level security;
revoke all on public.quality_whatsapp_groups,public.quality_whatsapp_event_settings,public.quality_whatsapp_notifications from anon,authenticated;
grant all on public.quality_whatsapp_groups,public.quality_whatsapp_event_settings,public.quality_whatsapp_notifications to service_role;

create or replace function public.quality_whatsapp_claim_pending(p_worker_id text,p_limit integer default 10)
returns setof public.quality_whatsapp_notifications
language plpgsql security definer set search_path=public as $$
begin
  return query
  with next_rows as (
    select id from public.quality_whatsapp_notifications
    where delivery_status in ('pendente','erro')
    order by created_at
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  )
  update public.quality_whatsapp_notifications n
  set delivery_status='processando', attempts=n.attempts+1, locked_at=now(), locked_by=left(coalesce(p_worker_id,''),120), updated_at=now(), last_error=null
  from next_rows
  where n.id=next_rows.id
  returning n.*;
end;
$$;

create or replace function public.quality_whatsapp_recover_stale(p_age_minutes integer default 15)
returns integer language plpgsql security definer set search_path=public as $$
declare recovered integer;
begin
  update public.quality_whatsapp_notifications
  set delivery_status='erro', last_error='Envio interrompido; aguardando nova tentativa.', locked_at=null, locked_by=null, updated_at=now()
  where delivery_status='processando' and locked_at < now()-make_interval(mins=>greatest(1,least(coalesce(p_age_minutes,15),1440)));
  get diagnostics recovered=row_count;
  return recovered;
end;
$$;

revoke all on function public.quality_whatsapp_claim_pending(text,integer),public.quality_whatsapp_recover_stale(integer) from public,anon,authenticated;
grant execute on function public.quality_whatsapp_claim_pending(text,integer),public.quality_whatsapp_recover_stale(integer) to service_role;
commit;
