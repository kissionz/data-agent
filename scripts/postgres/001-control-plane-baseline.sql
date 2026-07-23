-- Production control-plane baseline.
-- The migrator bootstraps this ledger before executing version 001 so that the
-- baseline can record itself in the same transaction as every later migration.
create table if not exists chatbi_schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null
);
