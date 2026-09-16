begin;

create table public.quality_correction_files (
  id bigint generated always as identity primary key,
  correction_id uuid not null references public.analysis_correcoes(id) on delete cascade,
  name text not null,
  object_path text not null unique,
  size_bytes bigint not null check (size_bytes >= 0),
  mime_type text not null,
  created_at timestamptz not null default now(),
  check (object_path ~ '^corrections/[0-9a-f-]{36}/[a-zA-Z0-9._-]+$')
);
create index quality_correction_files_correction_id_idx
  on public.quality_correction_files(correction_id);

alter table public.quality_correction_files enable row level security;
revoke all on public.quality_correction_files from anon,authenticated;
grant select on public.quality_correction_files to authenticated;
grant all on public.quality_correction_files to service_role;
create policy quality_correction_files_member_read on public.quality_correction_files
for select to authenticated using (
  exists(select 1 from public.quality_members m where m.user_id=(select auth.uid()) and m.active)
);

create view public.quality_corrections_view
with (security_invoker=true) as
select distinct on (c.id)
  c.id,
  qt.tool,
  qt.sequence,
  c.ferramenta_code as system_tool_code,
  c.__file_name as source_file,
  c.__uploaded_at as source_uploaded_at,
  c.payload,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',f.id,'name',f.name,'objectPath',f.object_path,
      'size',f.size_bytes,'mimeType',f.mime_type
    ) order by f.created_at,f.id)
    from public.quality_correction_files f where f.correction_id=c.id
  ),'[]'::jsonb) as files
from public.analysis_correcoes c
join public.quality_tests qt
  on upper(c.ferramenta_code)=upper(qt.tool)||'-'||lpad(qt.sequence,3,'0')
order by c.id,qt.received_at desc;

revoke all on public.quality_corrections_view from anon,authenticated;
grant select on public.quality_corrections_view to authenticated,service_role;

update storage.buckets
set file_size_limit=209715200
where id='quality-files';

commit;
