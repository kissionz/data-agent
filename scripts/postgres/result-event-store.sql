create table if not exists chatbi_result_pages (
  tenant_id text not null,
  workspace_id text not null,
  run_id text not null,
  attempt integer not null check (attempt > 0),
  page_index integer not null check (page_index >= 0),
  checksum text not null,
  content_fingerprint text not null,
  row_count integer not null check (row_count >= 0),
  payload_json jsonb not null,
  staged_at timestamptz not null,
  primary key (tenant_id, workspace_id, run_id, attempt, page_index)
);

create index if not exists chatbi_result_pages_attempt_idx
  on chatbi_result_pages (tenant_id, workspace_id, run_id, attempt, page_index);

create table if not exists chatbi_result_manifests (
  tenant_id text not null,
  workspace_id text not null,
  run_id text not null,
  attempt integer not null check (attempt > 0),
  result_id text not null,
  manifest_checksum text not null,
  content_fingerprint text not null,
  page_checksums text[] not null,
  page_count integer not null check (page_count >= 0),
  total_rows integer not null check (total_rows >= 0),
  metadata_json jsonb not null,
  published_at timestamptz not null,
  primary key (tenant_id, workspace_id, run_id),
  unique (tenant_id, workspace_id, result_id),
  check (cardinality(page_checksums) = page_count)
);

create or replace function chatbi_reject_published_result_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'published result manifests are immutable' using errcode = '55000';
end
$$;

drop trigger if exists chatbi_result_manifests_immutable on chatbi_result_manifests;
create trigger chatbi_result_manifests_immutable
before update or delete on chatbi_result_manifests
for each row execute function chatbi_reject_published_result_mutation();

create or replace function chatbi_reject_published_page_mutation()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from chatbi_result_manifests manifest
    where manifest.tenant_id = old.tenant_id
      and manifest.workspace_id = old.workspace_id
      and manifest.run_id = old.run_id
      and manifest.attempt = old.attempt
  ) then
    raise exception 'published result pages are immutable' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' and exists (
    select 1 from chatbi_result_manifests manifest
    where manifest.tenant_id = new.tenant_id
      and manifest.workspace_id = new.workspace_id
      and manifest.run_id = new.run_id
      and manifest.attempt = new.attempt
  ) then
    raise exception 'published result pages are immutable' using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists chatbi_result_pages_published_immutable on chatbi_result_pages;
create trigger chatbi_result_pages_published_immutable
before update or delete on chatbi_result_pages
for each row execute function chatbi_reject_published_page_mutation();

create table if not exists chatbi_run_event_streams (
  tenant_id text not null,
  workspace_id text not null,
  run_id text not null,
  current_sequence bigint not null default 0 check (current_sequence >= 0),
  updated_at timestamptz not null,
  primary key (tenant_id, workspace_id, run_id)
);

create table if not exists chatbi_run_events (
  tenant_id text not null,
  workspace_id text not null,
  run_id text not null,
  sequence bigint not null check (sequence > 0),
  idempotency_key text not null,
  content_fingerprint text not null,
  event_json jsonb not null,
  occurred_at timestamptz not null,
  primary key (tenant_id, workspace_id, run_id, sequence),
  unique (tenant_id, workspace_id, run_id, idempotency_key),
  foreign key (tenant_id, workspace_id, run_id)
    references chatbi_run_event_streams (tenant_id, workspace_id, run_id)
    on delete cascade
);

create index if not exists chatbi_run_events_cursor_idx
  on chatbi_run_events (tenant_id, workspace_id, run_id, sequence);
