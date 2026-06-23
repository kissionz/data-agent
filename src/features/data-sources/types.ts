export type DataSourceEngine = 'Snowflake' | 'BigQuery' | 'PostgreSQL' | 'ClickHouse'
export type DataSourceStatus = 'healthy' | 'degraded' | 'failed' | 'syncing' | 'draft'
export type QualityGateStatus = 'pass' | 'warning' | 'fail'
export type FieldClassification = 'public' | 'internal' | 'confidential' | 'restricted'

export interface DataSourceColumn {
  name: string
  type: string
  nullable: boolean
  classification: FieldClassification
  description: string
  samplePolicy: string
}

export interface DataSourceTable {
  id: string
  name: string
  displayName: string
  rowCount: string
  freshness: string
  owner: string
  qualityScore: number
  columns: DataSourceColumn[]
}

export interface QualityGate {
  name: string
  status: QualityGateStatus
  value: string
  target: string
  detail: string
}

export interface SyncEvent {
  at: string
  status: 'success' | 'warning' | 'failed'
  summary: string
}

export interface DataSource {
  id: string
  name: string
  engine: DataSourceEngine
  businessDomain: string
  status: DataSourceStatus
  connection: string
  lastSyncAt: string
  nextSyncAt: string
  freshness: string
  owner: string
  credentialRef: string
  scannedTables: number
  classifiedFields: number
  qualityScore: number
  scanBudget: string
  qualityGates: QualityGate[]
  syncEvents: SyncEvent[]
  tables: DataSourceTable[]
}
