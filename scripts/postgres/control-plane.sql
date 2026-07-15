create table if not exists chatbi_run_jobs (
  run_id text primary key,
  tenant_id text not null,
  workspace_id text not null,
  payload_fingerprint text not null,
  payload_json jsonb not null,
  status text not null check (status in ('queued', 'leased', 'retry_wait', 'completed', 'failed', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null check (max_attempts > 0),
  fence bigint not null default 0 check (fence >= 0),
  enqueued_at timestamptz not null,
  available_at timestamptz not null,
  lease_owner text,
  lease_token_hash text,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  last_failure_json jsonb,
  result_fingerprint text,
  result_json jsonb,
  terminal_kind text check (terminal_kind in ('completed', 'failed', 'retry_scheduled')),
  terminal_attempt integer,
  terminal_fence bigint,
  terminal_worker_id text,
  terminal_lease_token_hash text,
  terminal_fingerprint text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (
    (status = 'leased' and lease_owner is not null and lease_token_hash is not null and lease_expires_at is not null)
    or
    (status <> 'leased' and lease_owner is null and lease_token_hash is null and lease_expires_at is null)
  )
);

create index if not exists chatbi_run_jobs_claim_idx
  on chatbi_run_jobs (available_at, enqueued_at, run_id)
  where status in ('queued', 'retry_wait');

create index if not exists chatbi_run_jobs_expired_lease_idx
  on chatbi_run_jobs (lease_expires_at, run_id)
  where status = 'leased';

create index if not exists chatbi_run_jobs_scope_idx
  on chatbi_run_jobs (tenant_id, workspace_id, status, updated_at desc);

create table if not exists chatbi_run_job_attempts (
  run_id text not null references chatbi_run_jobs (run_id) on delete cascade,
  tenant_id text not null,
  workspace_id text not null,
  attempt integer not null check (attempt > 0),
  fence bigint not null check (fence > 0),
  worker_id text not null,
  lease_token_hash text not null,
  started_at timestamptz not null,
  lease_expires_at timestamptz not null,
  ended_at timestamptz,
  outcome text check (outcome in ('completed', 'failed', 'retry_scheduled', 'cancelled', 'lease_expired')),
  failure_json jsonb,
  primary key (run_id, attempt),
  unique (run_id, fence)
);

create index if not exists chatbi_run_job_attempts_scope_idx
  on chatbi_run_job_attempts (tenant_id, workspace_id, started_at desc);
