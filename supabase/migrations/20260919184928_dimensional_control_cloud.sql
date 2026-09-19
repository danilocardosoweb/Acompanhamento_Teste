begin;

-- Perfis de controle e seus desenhos deixam de depender do disco do computador
-- que executou a primeira análise. O acesso público continua bloqueado; somente
-- o coletor com service role opera estas tabelas.
create table public.quality_control_profiles (
  id uuid primary key,
  tool text not null check (length(tool) between 1 and 80),
  sequence integer,
  revision text not null default '00' check (length(revision) between 1 and 40),
  name text not null check (length(name) between 1 and 200),
  dimensions jsonb not null check (jsonb_typeof(dimensions)='array' and jsonb_array_length(dimensions) between 1 and 500),
  drawing_path text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (tool, sequence, revision),
  check (sequence is null or sequence >= 1),
  check (drawing_path is null or drawing_path ~ '^control-drawings/[0-9a-f-]{36}\.pdf$')
);
create index quality_control_profiles_lookup_idx
  on public.quality_control_profiles(tool, sequence, revision);

create table public.quality_dimensional_inspections (
  id uuid primary key,
  profile_id uuid not null references public.quality_control_profiles(id),
  tool text not null,
  sequence integer,
  test_date date not null,
  client text not null default '',
  part text not null default '',
  quantity integer not null default 1 check (quantity >= 1),
  lot text not null default '',
  operator text not null default '',
  shift text not null default '',
  observations text not null default '',
  measurements jsonb not null check (jsonb_typeof(measurements)='array' and jsonb_array_length(measurements) between 1 and 500),
  created_by uuid,
  created_by_name text not null default '',
  created_at timestamptz not null default now()
);
create index quality_dimensional_inspections_profile_created_idx
  on public.quality_dimensional_inspections(profile_id, created_at desc);

create table public.quality_dimensional_evidence (
  id uuid primary key,
  inspection_id uuid not null references public.quality_dimensional_inspections(id) on delete cascade,
  name text not null check (length(name) between 1 and 255),
  object_path text not null unique check (object_path ~ '^control-evidence/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 3145728),
  created_at timestamptz not null default now()
);
create index quality_dimensional_evidence_inspection_idx
  on public.quality_dimensional_evidence(inspection_id, created_at);

alter table public.quality_control_profiles enable row level security;
alter table public.quality_dimensional_inspections enable row level security;
alter table public.quality_dimensional_evidence enable row level security;

revoke all on public.quality_control_profiles, public.quality_dimensional_inspections, public.quality_dimensional_evidence from anon, authenticated;
grant all on public.quality_control_profiles, public.quality_dimensional_inspections, public.quality_dimensional_evidence to service_role;

commit;
