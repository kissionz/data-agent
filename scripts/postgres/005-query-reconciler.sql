create table if not exists chatbi_query_reconciliation_findings (
  finding_id text primary key
    check (finding_id ~ '^qrf:v2:sha256:[0-9a-f]{64}$'),
  identity_schema text not null
    check (identity_schema = 'query_reconciliation_identity.v2'),
  identity_json jsonb not null,
  tenant_id text not null,
  workspace_id text not null,
  run_id text not null,
  conversation_id text not null,
  issue_code text not null,
  severity text not null check (severity in ('warning', 'critical')),
  disposition text not null check (disposition in ('alerted', 'repaired')),
  repair_action text check (repair_action in ('release_conversation', 'fence_job')),
  evidence_json jsonb not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  repaired_at timestamptz,
  unique (identity_schema, identity_json),
  foreign key (tenant_id, workspace_id, run_id)
    references chatbi_query_runs (tenant_id, workspace_id, run_id)
    on delete cascade
);

create index if not exists chatbi_query_reconciliation_findings_open_idx
  on chatbi_query_reconciliation_findings (tenant_id, workspace_id, last_seen_at desc)
  where disposition = 'alerted';

create index if not exists chatbi_query_reconciliation_findings_run_idx
  on chatbi_query_reconciliation_findings (tenant_id, workspace_id, run_id, first_seen_at asc);
