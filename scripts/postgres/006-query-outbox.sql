create table if not exists chatbi_query_outbox (
  event_id text not null,
  tenant_id text not null,
  workspace_id text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  topic text not null,
  payload_fingerprint text not null,
  payload_json jsonb not null,
  status text not null default 'pending'
    constraint chatbi_query_outbox_status_check
    check (status = any(array['pending', 'leased', 'retry_wait', 'published', 'dead_lettered']::text[])),
  attempt integer not null default 0,
  max_attempts integer not null,
  fence bigint not null default 0,
  occurred_at timestamptz not null,
  available_at timestamptz not null,
  lease_owner text,
  lease_token_hash text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  dead_lettered_at timestamptz,
  publication_fingerprint text,
  last_failure_json jsonb,
  terminal_kind text
    check (terminal_kind in ('published', 'retry_scheduled', 'dead_lettered')),
  terminal_attempt integer,
  terminal_fence bigint,
  terminal_publisher_id text,
  terminal_lease_token_hash text,
  terminal_fingerprint text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint chatbi_query_outbox_pkey
    primary key (event_id),
  constraint chatbi_query_outbox_aggregate_type_check
    check (aggregate_type = any(array['query_run', 'conversation', 'workspace']::text[])),
  constraint chatbi_query_outbox_attempt_check
    check (attempt >= 0),
  constraint chatbi_query_outbox_max_attempts_check
    check (max_attempts > 0),
  constraint chatbi_query_outbox_fence_check
    check (fence >= 0),
  constraint chatbi_query_outbox_scope_event_key
    unique (tenant_id, workspace_id, event_id),
  constraint chatbi_query_outbox_payload_fingerprint_check
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint chatbi_query_outbox_available_time_check
    check (available_at >= occurred_at),
  constraint chatbi_query_outbox_lease_shape_check
    check (
      (
        status = 'leased'
        and lease_owner is not null
        and lease_token_hash is not null
        and lease_token_hash ~ '^[0-9a-f]{64}$'
        and lease_expires_at is not null
      )
      or
      (
        status <> 'leased'
        and lease_owner is null
        and lease_token_hash is null
        and lease_expires_at is null
      )
    ),
  constraint chatbi_query_outbox_terminal_shape_check
    check (
      (
        status = 'published'
        and published_at is not null
        and publication_fingerprint is not null
        and dead_lettered_at is null
      )
      or
      (
        status = 'dead_lettered'
        and dead_lettered_at is not null
        and published_at is null
        and publication_fingerprint is null
      )
      or
      (
        status <> all(array['published', 'dead_lettered']::text[])
        and published_at is null
        and dead_lettered_at is null
        and publication_fingerprint is null
      )
    ),
  constraint chatbi_query_outbox_terminal_metadata_check
    check (
      (
        terminal_kind is null
        and terminal_attempt is null
        and terminal_fence is null
        and terminal_publisher_id is null
        and terminal_lease_token_hash is null
        and terminal_fingerprint is null
      )
      or
      (
        terminal_kind is not null
        and terminal_attempt > 0
        and terminal_fence > 0
        and terminal_publisher_id is not null
        and terminal_lease_token_hash ~ '^[0-9a-f]{64}$'
        and terminal_fingerprint is not null
        and (
          (terminal_kind = 'published' and status = 'published')
          or (terminal_kind = 'retry_scheduled' and status = 'retry_wait')
          or (terminal_kind = 'dead_lettered' and status = 'dead_lettered')
        )
      )
    )
);

create index if not exists chatbi_query_outbox_claim_idx
  on chatbi_query_outbox (available_at, occurred_at, event_id)
  where status = any(array['pending', 'retry_wait']::text[]);

create index if not exists chatbi_query_outbox_expired_lease_idx
  on chatbi_query_outbox (lease_expires_at, event_id)
  where status = 'leased';

create index if not exists chatbi_query_outbox_scope_idx
  on chatbi_query_outbox (tenant_id, workspace_id, status, updated_at desc);

create table if not exists chatbi_query_outbox_attempts (
  event_id text not null,
  tenant_id text not null,
  workspace_id text not null,
  attempt integer not null,
  fence bigint not null,
  publisher_id text not null,
  lease_token_hash text not null,
  started_at timestamptz not null,
  lease_expires_at timestamptz not null,
  ended_at timestamptz,
  outcome text,
  failure_json jsonb,
  constraint chatbi_query_outbox_attempts_pkey
    primary key (event_id, attempt),
  constraint chatbi_query_outbox_attempts_event_fence_key
    unique (event_id, fence),
  constraint chatbi_query_outbox_attempts_attempt_check
    check (attempt > 0),
  constraint chatbi_query_outbox_attempts_fence_check
    check (fence > 0),
  constraint chatbi_query_outbox_attempts_lease_token_hash_check
    check (lease_token_hash ~ '^[0-9a-f]{64}$'),
  constraint chatbi_query_outbox_attempts_outcome_check
    check (outcome = any(array['published', 'retry_scheduled', 'dead_lettered', 'lease_expired']::text[])),
  constraint chatbi_query_outbox_attempts_scope_event_fk
    foreign key (tenant_id, workspace_id, event_id)
    references chatbi_query_outbox (tenant_id, workspace_id, event_id)
    on delete cascade,
  constraint chatbi_query_outbox_attempts_terminal_shape_check
    check (
      (ended_at is null and outcome is null and failure_json is null)
      or
      (
        ended_at is not null
        and outcome is not null
        and (
          (outcome = 'published' and failure_json is null)
          or (outcome <> 'published' and failure_json is not null)
        )
      )
    )
);

create index if not exists chatbi_query_outbox_attempts_scope_idx
  on chatbi_query_outbox_attempts (tenant_id, workspace_id, started_at desc);
