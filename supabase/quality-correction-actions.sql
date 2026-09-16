create table if not exists public.quality_correction_actions (
  correction_id uuid primary key references public.analysis_correcoes(id) on delete cascade,
  correction_text text not null default '',
  corrected_at timestamptz not null default now(),
  corrected_by uuid references public.users(id),
  corrected_by_name text not null default '',
  updated_at timestamptz not null default now(),
  constraint quality_correction_text_length check (char_length(correction_text) <= 10000)
);

alter table public.quality_correction_actions enable row level security;
revoke all on public.quality_correction_actions from anon, authenticated;
grant all on public.quality_correction_actions to service_role;
