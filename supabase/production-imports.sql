-- Estruturas exclusivas do AluPilot. Não altera tabelas compartilhadas,
-- incluindo analysis_correcoes, usadas por outro aplicativo.
create table if not exists public.quality_production_imports (
  id uuid primary key default gen_random_uuid(),
  source_name text not null default 'Relatório de produção',
  source_hash text not null,
  imported_at timestamptz not null default now(),
  imported_by uuid not null,
  imported_by_name text not null default '',
  total_rows integer not null check (total_rows >= 0),
  accepted_rows integer not null check (accepted_rows >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.quality_production_records (
  id uuid primary key,
  import_id uuid not null references public.quality_production_imports(id) on delete restrict,
  source_fingerprint text not null unique,
  tool text not null,
  sequence integer,
  lot bigint,
  production_date date,
  source_row integer,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quality_production_records_tool_sequence_idx
  on public.quality_production_records (upper(tool), sequence, production_date desc);
create index if not exists quality_production_records_lot_idx
  on public.quality_production_records (lot);

-- Registra a correção no espaço deste painel, sem escrever na tabela compartilhada.
create table if not exists public.quality_production_actions (
  production_id uuid primary key references public.quality_production_records(id) on delete cascade,
  correction_text text not null default '',
  corrected_at date,
  corrector text not null default '',
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.quality_production_imports enable row level security;
alter table public.quality_production_records enable row level security;
alter table public.quality_production_actions enable row level security;

revoke all on public.quality_production_imports, public.quality_production_records, public.quality_production_actions from anon, authenticated;
grant all on public.quality_production_imports, public.quality_production_records, public.quality_production_actions to service_role;
