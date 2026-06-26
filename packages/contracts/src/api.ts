import type {
  Clarification,
  PublicErrorCode,
  RunDisplayStatus,
  RunMode,
  RunResult,
} from './domain'

export type { PublicErrorCode } from './domain'

export const CONTRACT_VERSION = 'chatbi.contracts.v0.2' as const
export const ANALYSIS_IR_VERSION = 'analysis_ir.v1' as const

export type UserRole =
  | 'business_user'
  | 'business_owner'
  | 'analyst'
  | 'metric_admin'
  | 'data_admin'
  | 'security_admin'
  | 'platform_ops'
  | 'service_account'

export interface ActorContext {
  tenantId: string
  workspaceId: string
  userId: string
  roles: UserRole[]
  businessDomainId: string
  semanticVersion: string
  policyVersion?: string
  locale: 'zh-CN'
  timezone: string
}

export interface TimeRangeIR {
  kind: 'relative' | 'absolute'
  expression: string
  timezone: string
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year'
}

export interface FilterIR {
  dimensionId: string
  operator: 'eq' | 'in' | 'between' | 'contains'
  values: string[]
  source: 'user' | 'system_default' | 'clarification'
}

export interface AnalysisIR {
  schemaVersion: typeof ANALYSIS_IR_VERSION
  irId: string
  revision: number
  mode: RunMode
  semanticVersion: string
  intent: 'trend' | 'breakdown' | 'ranking' | 'lookup' | 'clarification' | 'empty_check'
  metricIds: string[]
  dimensionIds: string[]
  filters: FilterIR[]
  timeRange: TimeRangeIR
  limit: number
  assumptions: string[]
  safety: {
    requiresClarification: boolean
    executedQuery: boolean
    permissionChecked: boolean
    budgetChecked: boolean
  }
}

export type QueryDialect = 'postgresql' | 'snowflake'

export interface QueryCancellationPlan {
  token: string
  propagationTargets: Array<'planner' | 'compiler' | 'query_adapter' | 'result_writer'>
  deadlineMs: number
  status: 'pending' | 'propagated' | 'not_required'
  propagatedAt?: string
}

export interface QueryExecutionSummary {
  dialect: QueryDialect
  sqlFingerprint: string
  cacheKey: string
  permissionDigest: string
  dataVersion: string
  estimatedRows: number
  estimatedScanBytes: number
  timeoutMs: number
  maxRows: number
  appliedGuards: string[]
  cancellation: QueryCancellationPlan
  status: 'executed' | 'blocked' | 'cancelled'
}

export interface AuditEvent {
  id: string
  at: string
  type:
    | 'question.accepted'
    | 'planner.ir_created'
    | 'planner.clarification_required'
    | 'security.denied'
    | 'compiler.plan_created'
    | 'query.blocked'
    | 'query.started'
    | 'query.completed'
    | 'query.cancelled'
    | 'result.ready'
  actorUserId: string
  tenantId: string
  workspaceId: string
  runId: string
  summary: string
}

export interface PublicRunView {
  contractVersion: typeof CONTRACT_VERSION
  requestId: string
  traceId: string
  runId: string
  conversationId: string
  question: string
  displayStatus: RunDisplayStatus
  mode: RunMode
  semanticVersion: string
  version: number
  executedQuery: boolean
  analysisIr?: AnalysisIR
  queryExecution?: QueryExecutionSummary
  clarification?: Clarification
  result?: RunResult
  error?: PublicApiError
  audit: AuditEvent[]
  updatedAt: string
}

export interface ResultPageRequest {
  runId: string
  conversationId: string
  actor: ActorContext
  cursor?: string
  limit?: number
}

export interface ResultPageView {
  contractVersion: typeof CONTRACT_VERSION
  requestId: string
  traceId: string
  runId: string
  conversationId: string
  resultId: string
  semanticVersion: string
  columns: RunResult['columns']
  rows: RunResult['rows']
  page: {
    limit: number
    cursor?: string
    nextCursor?: string
    hasMore: boolean
    totalRows: number
  }
  completeness: RunResult['completeness']
  warnings: string[]
  freshnessAt: string
  queryExecution?: QueryExecutionSummary
  permissionDigest: string
  policyVersion: string
  rawSqlExposed: false
  rawDatabaseCredentialsExposed: false
  audit: AuditEvent[]
}

export type AssetType = 'conversation' | 'verified_case' | 'template' | 'subscription'
export type AssetStatus = 'active' | 'review' | 'archived'
export type ShareScope = 'private' | 'workspace' | 'domain_leads' | 'external_blocked'
export type SubscriptionCadence = 'daily' | 'weekly' | 'threshold' | 'none'

export interface CollaborationAuditEvent {
  id: string
  at: string
  type:
    | 'asset.listed'
    | 'asset.favorite_updated'
    | 'asset.subscription_updated'
    | 'asset.subscription_blocked'
    | 'asset.audit_viewed'
  actorUserId: string
  tenantId: string
  workspaceId: string
  assetId: string
  summary: string
}

export interface CollaborationAssetView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  title: string
  type: AssetType
  status: AssetStatus
  businessDomain: string
  owner: string
  updatedAt: string
  description: string
  semanticVersion: string
  analysisIrVersion: string
  questionTemplate: string
  scope: string
  isFavorite: boolean
  isArchived: boolean
  shareScope: ShareScope
  subscriptionCadence: SubscriptionCadence
  subscribers: number
  reviewers: Array<{ name: string; role: string }>
  lastAudit: string
  watermarkedExport: boolean
  permissionSummary: {
    workspaceScoped: boolean
    requiresRecipientReauth: boolean
    exportWatermarkRequired: boolean
  }
  audit: CollaborationAuditEvent[]
}

export interface ListAssetsRequest {
  actor: ActorContext
  query?: string
  status?: AssetStatus | 'all'
}

export interface UpdateAssetFavoriteRequest {
  actor: ActorContext
  assetId: string
  favorite: boolean
}

export interface UpdateAssetSubscriptionRequest {
  actor: ActorContext
  assetId: string
  cadence: SubscriptionCadence
}

export interface GetAssetAuditRequest {
  actor: ActorContext
  assetId: string
}

export type DataSourceConnectionStatus = 'healthy' | 'degraded' | 'failed' | 'syncing' | 'draft'

export interface DataSourceAuditEvent {
  id: string
  at: string
  type: 'data_source.listed' | 'data_source.connection_tested' | 'data_source.metadata_viewed' | 'data_source.quality_blocked'
  actorUserId: string
  tenantId: string
  workspaceId: string
  dataSourceId: string
  summary: string
}

export interface DataSourceView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  name: string
  engine: string
  businessDomain: string
  status: DataSourceConnectionStatus
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
  qualityGates: Array<{
    name: string
    status: 'pass' | 'warning' | 'fail'
    value: string
    target: string
    detail: string
  }>
  syncEvents: Array<{ at: string; status: 'success' | 'warning' | 'failed'; summary: string }>
  tables: Array<{
    id: string
    name: string
    displayName: string
    rowCount: string
    freshness: string
    owner: string
    qualityScore: number
    columns: Array<{
      name: string
      type: string
      nullable: boolean
      classification: 'public' | 'internal' | 'confidential' | 'restricted'
      description: string
      samplePolicy: string
    }>
  }>
  safetySummary: {
    readOnlyCredential: boolean
    credentialRefOnly: boolean
    restrictedFieldsExcludedFromSamples: boolean
    usableInTrustedMode: boolean
  }
  audit: DataSourceAuditEvent[]
}

export interface ListDataSourcesRequest {
  actor: ActorContext
  query?: string
  status?: DataSourceConnectionStatus | 'all'
}

export interface GetDataSourceRequest {
  actor: ActorContext
  dataSourceId: string
}

export interface TestDataSourceConnectionRequest {
  actor: ActorContext
  dataSourceId: string
}

export interface DataSourceConnectionTestResult {
  dataSourceId: string
  status: 'passed' | 'warning' | 'failed'
  latencyMs: number
  readOnlyCredential: boolean
  credentialRef: string
  blockedReason?: string
  audit: DataSourceAuditEvent[]
}

export interface EvaluationAuditEvent {
  id: string
  at: string
  type: 'evaluation.gate_evaluated' | 'evaluation.replay_listed' | 'evaluation.replay_viewed' | 'evaluation.release_blocked'
  actorUserId: string
  tenantId: string
  workspaceId: string
  summary: string
}

export interface EvaluationGateMetricView {
  name: string
  value: number
  target: number
  result: 'pass' | 'fail'
  severity: 'p0' | 'p1'
}

export interface EvaluationGateReport {
  contractVersion: typeof CONTRACT_VERSION
  candidateVersion: string
  sampleSize: number
  decision: 'pass' | 'blocked'
  failedP0: number
  failedMetrics: EvaluationGateMetricView[]
  metrics: EvaluationGateMetricView[]
  releaseAllowed: boolean
  summary: string
  audit: EvaluationAuditEvent[]
}

export interface ReplayRunView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  question: string
  domain: string
  model: string
  status: 'failed' | 'partial' | 'blocked'
  reason: string
  timestamp: string
  duration: string
  traceId: string
  stage: string
  semanticVersion: string
  sqlSummary: string
  resolution: string
  safeForReplay: boolean
  replayPlan: {
    candidateVersion: string
    requiresDesensitization: boolean
    canUseProductionCredentials: false
  }
  audit: EvaluationAuditEvent[]
}

export interface ListReplayRunsRequest {
  actor: ActorContext
  query?: string
  status?: ReplayRunView['status'] | 'all'
  domain?: string
}

export interface GetReplayRunRequest {
  actor: ActorContext
  runId: string
}

export interface EvaluateReleaseGateRequest {
  actor: ActorContext
  candidateVersion?: string
}

export interface SemanticGovernanceAuditEvent {
  id: string
  at: string
  type:
    | 'semantic.metric_listed'
    | 'semantic.metric_viewed'
    | 'semantic.metric_submitted'
    | 'semantic.metric_certified'
    | 'semantic.release_blocked'
  actorUserId: string
  tenantId: string
  workspaceId: string
  semanticObjectId: string
  summary: string
}

export interface SemanticMetricGovernanceView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  name: string
  businessDomainId: string
  semanticVersion: string
  lifecycle: 'draft' | 'review' | 'certified' | 'deprecated' | 'offline'
  expression: string
  sourceTable: string
  supportedGrains: AnalysisIR['timeRange']['grain'][]
  compatibleDimensions: string[]
  immutableVersion: boolean
  canUseInTrustedMode: boolean
  releaseReadiness: {
    referenceSqlReconciled: boolean
    approvedJoinGraph: boolean
    certifiedBy?: string
    blockingReasons: string[]
  }
  audit: SemanticGovernanceAuditEvent[]
}

export interface SemanticDimensionGovernanceView {
  id: string
  name: string
  semanticVersion: string
  lifecycle: 'draft' | 'review' | 'certified' | 'deprecated' | 'offline'
  requiresJoin?: string
}

export interface JoinGraphEdgeView {
  id: string
  leftTable: string
  rightTable: string
  cardinality: 'one_to_one' | 'many_to_one' | 'one_to_many' | 'many_to_many'
  direction: 'left' | 'right' | 'bidirectional'
  risk: 'low' | 'medium' | 'high'
  approved: boolean
}

export interface ListSemanticMetricsRequest {
  actor: ActorContext
  lifecycle?: SemanticMetricGovernanceView['lifecycle'] | 'all'
  query?: string
}

export interface GetSemanticMetricRequest {
  actor: ActorContext
  metricId: string
}

export interface SubmitSemanticMetricReviewRequest {
  actor: ActorContext
  metricId: string
  note: string
}

export interface CertifySemanticMetricRequest {
  actor: ActorContext
  metricId: string
  note: string
  referenceSqlReconciled: boolean
}

export interface IdentityAuditEvent {
  id: string
  at: string
  type:
    | 'identity.context_resolved'
    | 'identity.workspace_listed'
    | 'identity.policy_evaluated'
    | 'identity.policy_updated'
    | 'identity.permission_denied'
  actorUserId: string
  tenantId: string
  workspaceId?: string
  policyVersion: string
  summary: string
}

export interface WorkspaceView {
  id: string
  organizationId: string
  name: string
  businessDomains: Array<{ id: string; name: string }>
  roles: UserRole[]
  lastAccessedAt: string
  policyVersion: string
}

export interface IdentityContextView {
  contractVersion: typeof CONTRACT_VERSION
  actor: ActorContext & { policyVersion: string }
  tenant: { id: string; name: string }
  organization: { id: string; name: string }
  currentWorkspace: WorkspaceView
  availableWorkspaces: WorkspaceView[]
  permissionDigest: string
  policy: {
    version: string
    updatedAt: string
    effectiveWithinSeconds: number
    cacheInvalidAfter: string
  }
  audit: IdentityAuditEvent[]
}

export interface PolicyEvaluationRequest {
  actor: ActorContext
  resource:
    | { type: 'workspace'; workspaceId: string }
    | { type: 'business_domain'; workspaceId: string; businessDomainId: string }
    | { type: 'export'; workspaceId: string; businessDomainId: string; classification: 'public' | 'internal' | 'confidential' | 'restricted' }
  action: 'read' | 'query' | 'export' | 'manage_policy'
}

export interface PolicyEvaluationView {
  contractVersion: typeof CONTRACT_VERSION
  allowed: boolean
  decision: 'allow' | 'deny'
  reason: string
  policyVersion: string
  permissionDigest: string
  cacheKeyScope: string
  effectiveWithinSeconds: number
  audit: IdentityAuditEvent[]
}

export interface UpdatePolicyRequest {
  actor: ActorContext
  note: string
}

export interface IdentityContextRequest {
  actor: ActorContext
}

export type ExportFormat = 'csv' | 'xlsx' | 'png' | 'pdf'
export type ShareGrantScope = 'private_link' | 'workspace' | 'domain_leads'

export interface SharingAuditEvent {
  id: string
  at: string
  type:
    | 'export.requested'
    | 'export.completed'
    | 'export.queued'
    | 'export.blocked'
    | 'export.status_viewed'
    | 'share.created'
    | 'share.reauthorized'
    | 'share.denied'
  actorUserId: string
  tenantId: string
  workspaceId: string
  policyVersion: string
  summary: string
}

export interface ExportRequest {
  actor: ActorContext
  source:
    | { type: 'run'; runId: string; conversationId: string }
    | { type: 'asset'; assetId: string }
  format: ExportFormat
  estimatedRows: number
  estimatedBytes: number
  classification: 'public' | 'internal' | 'confidential' | 'restricted'
}

export interface ExportJobView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  status: 'completed' | 'queued' | 'blocked'
  source: ExportRequest['source']
  format: ExportFormat
  estimatedRows: number
  estimatedBytes: number
  limits: {
    maxRows: number
    maxBytes: number
  }
  policyVersion: string
  permissionDigest: string
  watermark: {
    enabled: boolean
    text: string
  }
  desensitization: {
    required: boolean
    rules: string[]
  }
  download: {
    available: boolean
    expiresAt?: string
    signedUrlPreview?: string
  }
  delivery: {
    mode: 'online' | 'async'
    requiresAuditApproval: boolean
    queueName?: string
    statusUrl?: string
    estimatedReadyAt?: string
  }
  blockingReasons: string[]
  asyncReasons: string[]
  audit: SharingAuditEvent[]
}

export interface GetExportJobRequest {
  actor: ActorContext
  exportId: string
}

export interface CreateShareRequest {
  actor: ActorContext
  source:
    | { type: 'run'; runId: string; conversationId: string }
    | { type: 'asset'; assetId: string }
  scope: ShareGrantScope
  recipientUserIds: string[]
  expiresInDays: number
}

export interface ShareGrantView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  source: CreateShareRequest['source']
  scope: ShareGrantScope
  recipientUserIds: string[]
  expiresAt: string
  policyVersion: string
  storesResultSnapshot: false
  requiresRecipientReauth: true
  audit: SharingAuditEvent[]
}

export interface ReauthorizeShareRequest {
  actor: ActorContext
  shareId: string
}

export interface ShareReauthorizationView {
  contractVersion: typeof CONTRACT_VERSION
  shareId: string
  allowed: boolean
  decision: 'allow' | 'deny'
  reason: string
  rerunRequired: boolean
  policyVersion: string
  audit: SharingAuditEvent[]
}

export type ModelCapability = 'planner' | 'entity_linker' | 'answer'
export type ModelProvider = 'openai' | 'azure_openai' | 'anthropic' | 'local_template'
export type ModelRouteStatus = 'active' | 'canary' | 'blocked' | 'rolled_back'

export interface ModelOpsAuditEvent {
  id: string
  at: string
  type:
    | 'model.route_evaluated'
    | 'model.quota_checked'
    | 'model.fallback_selected'
    | 'model.release_blocked'
    | 'model.rollback_completed'
  actorUserId: string
  tenantId: string
  workspaceId: string
  routeId: string
  summary: string
}

export interface ModelRouteView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  capability: ModelCapability
  provider: ModelProvider
  activeVersion: string
  candidateVersion?: string
  status: ModelRouteStatus
  trafficSplit: { active: number; candidate: number }
  timeoutMs: number
  temperature: number
  quota: {
    tenantDailyLimit: number
    tenantUsedToday: number
    workspaceDailyLimit: number
    workspaceUsedToday: number
  }
  fallbackChain: Array<{
    provider: ModelProvider
    version: string
    reason: 'quota_exhausted' | 'provider_unavailable' | 'policy_blocked'
  }>
  tenantOverride?: {
    tenantId: string
    region: 'cn' | 'us' | 'eu'
    dataRetention: 'none' | 'zero_day' | 'thirty_days'
    trainingAllowed: false
  }
  audit: ModelOpsAuditEvent[]
}

export interface ListModelRoutesRequest {
  actor: ActorContext
  capability?: ModelCapability | 'all'
}

export interface RouteModelRequest {
  actor: ActorContext
  capability: ModelCapability
  estimatedTokens: number
  providerAvailable?: boolean
  requireNoTraining?: boolean
}

export interface ModelRouteDecisionView {
  contractVersion: typeof CONTRACT_VERSION
  routeId: string
  selected: {
    provider: ModelProvider
    version: string
    source: 'active' | 'candidate' | 'fallback'
  }
  status: 'routed' | 'fallback' | 'blocked'
  reason: string
  quotaRemaining: number
  timeoutMs: number
  temperature: number
  policyVersion?: string
  audit: ModelOpsAuditEvent[]
}

export interface RollbackModelRouteRequest {
  actor: ActorContext
  routeId: string
  reason: string
}

export type SloWindow = '7d' | '30d' | '90d'
export type SloObjectiveStatus = 'healthy' | 'warning' | 'breach'
export type SloObjectiveCategory = 'availability' | 'latency' | 'cost' | 'cancellation' | 'quality'
export type SloComparator = 'gte' | 'lte'

export interface SloAuditEvent {
  id: string
  at: string
  type: 'slo.report_generated' | 'slo.budget_evaluated' | 'slo.alert_triggered'
  actorUserId: string
  tenantId: string
  workspaceId: string
  summary: string
}

export interface SloObjectiveView {
  name: string
  category: SloObjectiveCategory
  value: number
  formattedValue: string
  target: number
  comparator: SloComparator
  formattedTarget: string
  status: SloObjectiveStatus
  errorBudgetRemaining: number
  window: SloWindow
  evidence: string[]
}

export interface SloAlertView {
  id: string
  severity: 'info' | 'warning' | 'critical'
  status: 'open' | 'acknowledged' | 'closed'
  objective: string
  message: string
  runbook: string
  rollbackRequired: boolean
  createdAt: string
}

export interface SloReportView {
  contractVersion: typeof CONTRACT_VERSION
  window: SloWindow
  tenantId: string
  workspaceId: string
  generatedAt: string
  summary: {
    status: SloObjectiveStatus
    healthy: number
    warning: number
    breach: number
    costPerSuccessCny: number
    p95LatencySeconds: number
    p95CancelSeconds: number
  }
  objectives: SloObjectiveView[]
  alerts: SloAlertView[]
  audit: SloAuditEvent[]
}

export interface GetSloReportRequest {
  actor: ActorContext
  window?: SloWindow
}

export interface EvaluatePerformanceBudgetRequest {
  actor: ActorContext
  runId: string
  latencySeconds: number
  costCny: number
  scanBytes: number
  cancelledPropagationSeconds?: number
}

export interface PerformanceBudgetDecisionView {
  contractVersion: typeof CONTRACT_VERSION
  runId: string
  decision: 'allow' | 'warn' | 'block'
  reasons: string[]
  budgets: {
    latencySeconds: { actual: number; target: number; status: SloObjectiveStatus }
    costCny: { actual: number; target: number; status: SloObjectiveStatus }
    scanBytes: { actual: number; target: number; status: SloObjectiveStatus }
    cancelledPropagationSeconds?: { actual: number; target: number; status: SloObjectiveStatus }
  }
  audit: SloAuditEvent[]
}

export type DeveloperScope =
  | 'questions:write'
  | 'runs:read'
  | 'semantic:read'
  | 'assets:read'
  | 'exports:create'
  | 'exports:read'
  | 'webhooks:manage'
  | 'embed:issue'

export interface DeveloperAccessAuditEvent {
  id: string
  at: string
  type:
    | 'developer.service_account_created'
    | 'developer.api_key_issued'
    | 'developer.api_key_rotated'
    | 'developer.api_key_revoked'
    | 'developer.api_key_verified'
    | 'developer.webhook_registered'
    | 'developer.webhook_tested'
    | 'developer.webhook_delivery_planned'
    | 'developer.embed_token_issued'
    | 'developer.access_denied'
  actorUserId: string
  tenantId: string
  workspaceId: string
  targetId: string
  summary: string
}

export interface ServiceAccountView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  name: string
  status: 'active' | 'revoked'
  workspaceId: string
  businessDomainId: string
  scopes: DeveloperScope[]
  quota: {
    dailyRequestLimit: number
    dailyRequestUsed: number
  }
  createdBy: string
  createdAt: string
  expiresAt: string
  audit: DeveloperAccessAuditEvent[]
}

export interface CreateServiceAccountRequest {
  actor: ActorContext
  name: string
  scopes: DeveloperScope[]
  expiresInDays: number
  dailyRequestLimit: number
}

export interface ApiKeyView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  serviceAccountId: string
  prefix: string
  secretPreview: string
  secretHash: string
  status: 'active' | 'rotating' | 'revoked'
  scopes: DeveloperScope[]
  expiresAt: string
  rotationRequiredBefore: string
  rotationGraceEndsAt?: string
  rotatedFromKeyId?: string
  rotatedToKeyId?: string
  audit: DeveloperAccessAuditEvent[]
}

export interface IssueApiKeyRequest {
  actor: ActorContext
  serviceAccountId: string
  expiresInDays: number
}

export interface RevokeApiKeyRequest {
  actor: ActorContext
  keyId: string
  reason: string
}

export interface RotateApiKeyRequest {
  actor: ActorContext
  keyId: string
  expiresInDays: number
  graceMinutes: number
}

export interface ApiKeyRotationView {
  contractVersion: typeof CONTRACT_VERSION
  serviceAccountId: string
  oldKey: ApiKeyView
  newKey: ApiKeyView
  graceEndsAt: string
  oldKeyAcceptedDuringGrace: true
  plaintextSecretReturnedOnlyOnce: false
  audit: DeveloperAccessAuditEvent[]
}

export interface VerifyApiKeyRequest {
  presentedSecret: string
  requiredScopes: DeveloperScope[]
  workspaceId: string
  businessDomainId: string
  semanticVersion: string
  locale: 'zh-CN'
  timezone: string
}

export interface ApiKeyVerificationView {
  contractVersion: typeof CONTRACT_VERSION
  authenticated: true
  keyId: string
  serviceAccountId: string
  actor: ActorContext
  scopes: DeveloperScope[]
  quota: ServiceAccountView['quota']
  permissionDigest: string
  cannotAccessDatabaseCredentials: true
  audit: DeveloperAccessAuditEvent[]
}

export interface WebhookSubscriptionView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  url: string
  events: Array<'run.completed' | 'run.failed' | 'asset.updated' | 'export.completed'>
  status: 'active' | 'failed' | 'revoked'
  secretPreview: string
  signingAlgorithm: 'hmac-sha256'
  replayProtectionSeconds: number
  retryPolicy: {
    maxAttempts: number
    backoff: 'exponential'
    deadLetterAfterAttempts: number
  }
  deliversOnlyAuthorizedData: true
  lastTest?: {
    status: 'accepted' | 'failed'
    httpStatus: number
    signatureVerified: boolean
  }
  audit: DeveloperAccessAuditEvent[]
}

export interface RegisterWebhookRequest {
  actor: ActorContext
  url: string
  events: WebhookSubscriptionView['events']
}

export interface TestWebhookRequest {
  actor: ActorContext
  webhookId: string
}

export interface PlanWebhookDeliveryRequest {
  actor: ActorContext
  webhookId: string
  event: WebhookSubscriptionView['events'][number]
  payload: Record<string, unknown>
  simulatedHttpStatuses?: number[]
}

export interface WebhookDeliveryAttemptView {
  attempt: number
  scheduledAt: string
  httpStatus?: number
  result: 'pending' | 'accepted' | 'retry_scheduled' | 'dead_lettered'
}

export interface WebhookDeliveryPlanView {
  contractVersion: typeof CONTRACT_VERSION
  id: string
  webhookId: string
  event: WebhookSubscriptionView['events'][number]
  url: string
  finalState: 'queued' | 'accepted' | 'dead_lettered'
  signingAlgorithm: 'hmac-sha256'
  headers: {
    'x-insightflow-event': string
    'x-insightflow-delivery': string
    'x-insightflow-timestamp': string
    'x-insightflow-signature': string
  }
  replayProtectionExpiresAt: string
  attempts: WebhookDeliveryAttemptView[]
  deadLetter?: {
    reason: string
    afterAttempts: number
  }
  payloadRedacted: true
  deliversOnlyAuthorizedData: true
  audit: DeveloperAccessAuditEvent[]
}

export interface EmbedTokenView {
  contractVersion: typeof CONTRACT_VERSION
  tokenId: string
  tokenPreview: string
  hostOrigin: string
  source:
    | { type: 'run'; runId: string; conversationId: string }
    | { type: 'asset'; assetId: string }
  expiresAt: string
  scopes: Extract<DeveloperScope, 'runs:read' | 'assets:read'>[]
  policyVersion: string
  permissionDigest: string
  cannotAccessDatabaseCredentials: true
  audit: DeveloperAccessAuditEvent[]
}

export interface IssueEmbedTokenRequest {
  actor: ActorContext
  hostOrigin: string
  source: EmbedTokenView['source']
  expiresInMinutes: number
}

export interface PublicApiError {
  code: PublicErrorCode
  message: string
  retryable: boolean
  debugReference: string
}

export interface PublicErrorCatalogItem {
  httpStatus: 200 | 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503
  title: string
  retryableDefault: boolean
  safeForUser: boolean
}

export const PUBLIC_ERROR_CATALOG = {
  AMBIGUOUS_QUERY: { httpStatus: 422, title: '问题需要澄清', retryableDefault: true, safeForUser: true },
  SEMANTIC_NOT_FOUND: { httpStatus: 404, title: '语义对象不存在或不可见', retryableDefault: false, safeForUser: true },
  PERMISSION_DENIED: { httpStatus: 403, title: '无权访问该内容', retryableDefault: false, safeForUser: true },
  QUERY_TOO_EXPENSIVE: { httpStatus: 422, title: '查询范围过大', retryableDefault: true, safeForUser: true },
  DATA_STALE: { httpStatus: 422, title: '数据新鲜度不足', retryableDefault: true, safeForUser: true },
  PARTIAL_RESULT: { httpStatus: 200, title: '结果部分完成', retryableDefault: true, safeForUser: true },
  MODEL_UNAVAILABLE: { httpStatus: 503, title: '模型服务不可用', retryableDefault: true, safeForUser: true },
  RUN_ALREADY_ACTIVE: { httpStatus: 409, title: '当前会话已有运行中的问题', retryableDefault: true, safeForUser: true },
  RUN_CANCELLED: { httpStatus: 409, title: '运行已取消或不可取消', retryableDefault: false, safeForUser: true },
  VALIDATION_FAILED: { httpStatus: 400, title: '请求契约无效', retryableDefault: true, safeForUser: true },
  INTERNAL_ERROR: { httpStatus: 500, title: '内部错误', retryableDefault: false, safeForUser: false },
} as const satisfies Record<PublicErrorCode, PublicErrorCatalogItem>

export function httpStatusForError(code: PublicErrorCode): PublicErrorCatalogItem['httpStatus'] {
  return PUBLIC_ERROR_CATALOG[code].httpStatus
}

export type ApiEnvelope<T> =
  | { ok: true; data: T; requestId: string; traceId: string }
  | { ok: false; error: PublicApiError; requestId: string; traceId: string }

export interface SubmitQuestionRequest {
  idempotencyKey: string
  conversationId: string
  question: string
  mode: RunMode
  actor: ActorContext
}

export interface ClarifyRunRequest {
  runId: string
  conversationId: string
  candidateId: string
  candidateVersion: string
  actor: ActorContext
}

export interface CancelRunRequest {
  runId: string
  conversationId: string
  actor: ActorContext
}

export interface GetRunRequest {
  runId: string
  conversationId: string
  actor: ActorContext
}

export const analysisIrJsonSchema = {
  $id: 'https://insightflow.local/schemas/analysis-ir.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'irId',
    'revision',
    'mode',
    'semanticVersion',
    'intent',
    'metricIds',
    'dimensionIds',
    'filters',
    'timeRange',
    'limit',
    'assumptions',
    'safety',
  ],
  properties: {
    schemaVersion: { const: ANALYSIS_IR_VERSION },
    irId: { type: 'string', minLength: 1 },
    revision: { type: 'integer', minimum: 1 },
    mode: { enum: ['trusted', 'exploration', 'expert'] },
    semanticVersion: { type: 'string', minLength: 1 },
    intent: { enum: ['trend', 'breakdown', 'ranking', 'lookup', 'clarification', 'empty_check'] },
    metricIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    dimensionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    filters: { type: 'array' },
    timeRange: { type: 'object' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    assumptions: { type: 'array', items: { type: 'string' } },
    safety: {
      type: 'object',
      additionalProperties: false,
      required: ['requiresClarification', 'executedQuery', 'permissionChecked', 'budgetChecked'],
      properties: {
        requiresClarification: { type: 'boolean' },
        executedQuery: { type: 'boolean' },
        permissionChecked: { type: 'boolean' },
        budgetChecked: { type: 'boolean' },
      },
    },
  },
} as const

const QUESTION_REQUEST_KEYS = new Set(['idempotencyKey', 'conversationId', 'question', 'mode', 'actor'])

export function validateSubmitQuestionRequest(input: SubmitQuestionRequest): PublicApiError | null {
  const unknown = Object.keys(input as unknown as Record<string, unknown>).filter((key) => !QUESTION_REQUEST_KEYS.has(key))
  if (unknown.length > 0) return validationError(`未知字段：${unknown.join(', ')}`)
  if (!input.idempotencyKey || input.idempotencyKey.length > 128) return validationError('缺少有效幂等键')
  if (!input.conversationId) return validationError('缺少会话 ID')
  if (!input.question || input.question.trim().length === 0) return validationError('问题不能为空')
  if (input.question.length > 500) return validationError('问题不能超过 500 个字符')
  if (!['trusted', 'exploration', 'expert'].includes(input.mode)) return validationError('不支持的运行模式')
  return validateActor(input.actor)
}

export function validateActor(actor: ActorContext): PublicApiError | null {
  if (!actor?.tenantId || !actor.workspaceId || !actor.userId || !actor.businessDomainId) {
    return validationError('缺少身份、租户、工作空间或业务域上下文')
  }
  if (!actor.semanticVersion) return validationError('缺少语义版本')
  if (actor.locale !== 'zh-CN') return validationError('当前演示契约仅支持 zh-CN')
  return null
}

export function assertAnalysisIR(ir: AnalysisIR): void {
  if (ir.schemaVersion !== ANALYSIS_IR_VERSION) throw new Error('Invalid Analysis IR schema version')
  if (!ir.irId || ir.revision < 1) throw new Error('Analysis IR requires id and positive revision')
  if (ir.mode === 'trusted' && ir.metricIds.length === 0) throw new Error('Trusted Analysis IR requires a governed metric')
  if (ir.limit < 1 || ir.limit > 1000) throw new Error('Analysis IR limit is outside the allowed range')
  if (ir.safety.requiresClarification && ir.safety.executedQuery) {
    throw new Error('Analysis IR cannot execute a query while clarification is required')
  }
}

export function validationError(message: string): PublicApiError {
  return {
    code: 'VALIDATION_FAILED',
    message,
    retryable: true,
    debugReference: 'validation_contract',
  }
}

export function toPublicError(input: {
  code: PublicErrorCode
  userMessage: string
  retryable: boolean
  debugReference: string
}): PublicApiError {
  return {
    code: input.code,
    message: input.userMessage,
    retryable: input.retryable,
    debugReference: input.debugReference,
  }
}
