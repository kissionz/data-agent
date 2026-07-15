create table if not exists chatbi_query_conversations (
  conversation_id text primary key,
  tenant_id text not null,
  workspace_id text not null,
  business_domain_id text not null,
  active_run_id text,
  payload_json jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, workspace_id, conversation_id)
);

create index if not exists chatbi_query_conversations_scope_idx
  on chatbi_query_conversations (tenant_id, workspace_id, updated_at desc);

create table if not exists chatbi_query_runs (
  run_id text primary key,
  tenant_id text not null,
  workspace_id text not null,
  conversation_id text not null,
  request_fingerprint text not null,
  display_status text not null,
  internal_status text not null,
  request_id text not null,
  trace_id text not null,
  stored_record_json jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, workspace_id, run_id),
  foreign key (tenant_id, workspace_id, conversation_id)
    references chatbi_query_conversations (tenant_id, workspace_id, conversation_id)
);

create index if not exists chatbi_query_runs_conversation_idx
  on chatbi_query_runs (tenant_id, workspace_id, conversation_id, updated_at desc);

create table if not exists chatbi_query_idempotency (
  tenant_id text not null,
  workspace_id text not null,
  conversation_id text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  run_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id, workspace_id, conversation_id, idempotency_key),
  foreign key (tenant_id, workspace_id, conversation_id)
    references chatbi_query_conversations (tenant_id, workspace_id, conversation_id)
    deferrable initially deferred,
  foreign key (tenant_id, workspace_id, run_id)
    references chatbi_query_runs (tenant_id, workspace_id, run_id)
    deferrable initially deferred
);

create index if not exists chatbi_query_idempotency_run_idx
  on chatbi_query_idempotency (tenant_id, workspace_id, run_id);

create table if not exists chatbi_query_audit_events (
  tenant_id text not null,
  workspace_id text not null,
  run_id text not null,
  event_id text not null,
  event_type text not null,
  actor_user_id text not null,
  occurred_at timestamptz not null,
  payload_json jsonb not null,
  primary key (tenant_id, workspace_id, run_id, event_id),
  foreign key (tenant_id, workspace_id, run_id)
    references chatbi_query_runs (tenant_id, workspace_id, run_id)
    on delete cascade
);

create index if not exists chatbi_query_audit_events_scope_idx
  on chatbi_query_audit_events (tenant_id, workspace_id, event_type, occurred_at desc);
