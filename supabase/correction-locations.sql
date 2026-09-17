begin;

create table if not exists public.quality_tool_drawings (
  id uuid primary key,
  tool text not null,
  sequence integer,
  name text not null,
  object_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  uploaded_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (object_path ~ '^drawings/[0-9a-f-]{36}/[a-zA-Z0-9._-]+\.pdf$')
);
create unique index if not exists quality_tool_drawings_tool_sequence_idx
  on public.quality_tool_drawings (upper(tool),coalesce(sequence,-1));

create table if not exists public.quality_correction_locations (
  id uuid primary key,
  correction_id uuid not null references public.analysis_correcoes(id) on delete cascade,
  drawing_id uuid not null references public.quality_tool_drawings(id) on delete restrict,
  location_type text not null default 'pdf' check (location_type in ('pdf')),
  page_pdf integer not null check (page_pdf > 0),
  x_normalized numeric(8,7) not null check (x_normalized between 0 and 1),
  y_normalized numeric(8,7) not null check (y_normalized between 0 and 1),
  view_name text not null default 'Frontal',
  component text not null default '',
  region text not null default '',
  hole_region text not null default '',
  action_name text not null default '',
  measure_value text not null default '',
  unit_name text not null default '',
  method_name text not null default '',
  description text not null default '',
  created_by uuid not null,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(description) <= 10000)
);
create index if not exists quality_correction_locations_correction_idx
  on public.quality_correction_locations(correction_id,created_at);

alter table public.quality_tool_drawings enable row level security;
alter table public.quality_correction_locations enable row level security;
revoke all on public.quality_tool_drawings,public.quality_correction_locations from anon,authenticated;
grant all on public.quality_tool_drawings,public.quality_correction_locations to service_role;

commit;
