-- Estrutura do painel de qualidade; projeto sldhpwtdipndnljbzojm.
begin;

create table public.quality_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.quality_tests (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  tool text not null,
  sequence text not null default '',
  test_number text not null default '',
  test_date date,
  received_at timestamptz not null,
  result text not null check (result in ('APROVADO','REPROVADO','REVISAR')),
  subject text not null,
  comment text not null default '',
  email_body text not null default '',
  sender text not null default '',
  source_record jsonb not null,
  synced_at timestamptz not null default now()
);
create index quality_tests_tool_sequence_date_idx
  on public.quality_tests(tool,sequence,test_date desc,received_at desc);

create table public.quality_attachments (
  id text primary key,
  test_id text not null references public.quality_tests(id),
  name text not null,
  object_path text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  preview_manifest jsonb,
  synced_at timestamptz not null default now()
);
create index quality_attachments_test_id_idx on public.quality_attachments(test_id);

create table public.quality_collectors (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.quality_collectors enable row level security;
revoke all on public.quality_collectors from anon,authenticated;
grant select on public.quality_collectors to service_role;
create policy quality_collector_service on public.quality_collectors
for select to service_role using (true);

create table public.quality_sync_state (
  id text primary key,
  data jsonb not null,
  synced_at timestamptz not null default now()
);
alter table public.quality_sync_state enable row level security;
revoke all on public.quality_sync_state from anon,authenticated;
grant select on public.quality_sync_state to authenticated;
grant all on public.quality_sync_state to service_role;
create policy quality_sync_member_read on public.quality_sync_state
for select to authenticated using (
  exists(select 1 from public.quality_members m where m.user_id=(select auth.uid()) and m.active)
);

alter table public.quality_members enable row level security;
alter table public.quality_tests enable row level security;
alter table public.quality_attachments enable row level security;

revoke all on public.quality_members,public.quality_tests,public.quality_attachments from anon,authenticated;
grant select on public.quality_members,public.quality_tests,public.quality_attachments to authenticated;
grant all on public.quality_members,public.quality_tests,public.quality_attachments to service_role;

create policy quality_member_self on public.quality_members
for select to authenticated using (user_id=(select auth.uid()));

create policy quality_tests_member_read on public.quality_tests
for select to authenticated using (
  exists(select 1 from public.quality_members m where m.user_id=(select auth.uid()) and m.active)
);
create policy quality_attachments_member_read on public.quality_attachments
for select to authenticated using (
  exists(select 1 from public.quality_members m where m.user_id=(select auth.uid()) and m.active)
);

-- Criar o bucket privado quality-files pela API Storage antes do envio de arquivos.
-- A politica nao concede leitura de outros buckets do projeto.
create policy quality_files_member_read on storage.objects
for select to authenticated using (
  bucket_id='quality-files' and
  exists(select 1 from public.quality_members m where m.user_id=(select auth.uid()) and m.active)
);
commit;
