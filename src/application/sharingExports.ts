import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type CreateShareRequest,
  type ExportJobView,
  type ExportRequest,
  type PublicApiError,
  type ReauthorizeShareRequest,
  type ShareGrantView,
  type ShareReauthorizationView,
  type SharingAuditEvent,
} from '../contracts'
import {
  createIdentityPolicyApplicationService,
  type IdentityPolicyApplicationService,
} from './identityPolicy'

export interface SharingExportApplicationService {
  requestExport(request: ExportRequest): ApiEnvelope<ExportJobView>
  createShare(request: CreateShareRequest): ApiEnvelope<ShareGrantView>
  reauthorizeShare(request: ReauthorizeShareRequest): ApiEnvelope<ShareReauthorizationView>
}

export interface SharingExportApplicationOptions {
  now?: () => string
  identity?: IdentityPolicyApplicationService
}

interface StoredShare {
  grant: ShareGrantView
  businessDomainId: string
  workspaceId: string
}

const EXPORT_LIMITS = {
  maxRows: 100_000,
  maxBytes: 50 * 1024 * 1024,
}

export function createSharingExportApplicationService(
  options: SharingExportApplicationOptions = {},
): SharingExportApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  const identity = options.identity ?? createIdentityPolicyApplicationService({ now })
  let sequence = 0
  const auditEvents: SharingAuditEvent[] = []
  const shares = new Map<string, StoredShare>()

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
  }

  function requestIds() {
    return { requestId: nextId('req'), traceId: nextId('trace') }
  }

  function success<T>(data: T): ApiEnvelope<T> {
    return { ok: true, ...requestIds(), data }
  }

  function failure(error: PublicApiError): ApiEnvelope<never> {
    return { ok: false, ...requestIds(), error }
  }

  function invalidActor(request: { actor: ExportRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function policyVersion(actor: ExportRequest['actor']) {
    return actor.policyVersion ?? 'policy-2026.06.7'
  }

  function permissionDigest(actor: ExportRequest['actor']) {
    return [
      actor.tenantId,
      actor.workspaceId,
      actor.businessDomainId,
      actor.roles.slice().sort().join('+'),
      policyVersion(actor),
    ].join('|')
  }

  function audit(type: SharingAuditEvent['type'], request: { actor: ExportRequest['actor'] }, summary: string) {
    const event: SharingAuditEvent = {
      id: nextId('sharing_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      policyVersion: policyVersion(request.actor),
      summary,
    }
    auditEvents.push(event)
    return event
  }

  function addDaysIso(days: number) {
    const base = new Date(now())
    base.setUTCDate(base.getUTCDate() + days)
    return base.toISOString()
  }

  function sourceSummary(source: ExportRequest['source']) {
    return source.type === 'run' ? `run:${source.runId}` : `asset:${source.assetId}`
  }

  function desensitizationRules(classification: ExportRequest['classification']) {
    if (classification === 'restricted') return ['restricted_fields_removed', 'recipient_reauth_required']
    if (classification === 'confidential') return ['mask_direct_identifiers', 'aggregate_small_groups']
    if (classification === 'internal') return ['include_business_context_only']
    return []
  }

  function exportView(
    request: ExportRequest,
    status: ExportJobView['status'],
    blockingReasons: string[],
  ): ExportJobView {
    const id = nextId('export')
    const available = status === 'completed'
    return {
      contractVersion: CONTRACT_VERSION,
      id,
      status,
      source: request.source,
      format: request.format,
      estimatedRows: request.estimatedRows,
      estimatedBytes: request.estimatedBytes,
      limits: EXPORT_LIMITS,
      policyVersion: policyVersion(request.actor),
      permissionDigest: permissionDigest(request.actor),
      watermark: {
        enabled: true,
        text: `${request.actor.tenantId}/${request.actor.workspaceId}/${request.actor.userId}/${policyVersion(request.actor)}`,
      },
      desensitization: {
        required: request.classification !== 'public',
        rules: desensitizationRules(request.classification),
      },
      download: {
        available,
        expiresAt: available ? addDaysIso(1) : undefined,
        signedUrlPreview: available ? `https://download.local/${id}?signature=redacted` : undefined,
      },
      blockingReasons,
      audit: auditEvents,
    }
  }

  return {
    requestExport(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const policy = identity.evaluatePolicy({
        actor: request.actor,
        action: 'export',
        resource: {
          type: 'export',
          workspaceId: request.actor.workspaceId,
          businessDomainId: request.actor.businessDomainId,
          classification: request.classification,
        },
      })
      const blockingReasons: string[] = []
      if (!policy.ok || !policy.data.allowed) blockingReasons.push(policy.ok ? policy.data.reason : policy.error.message)
      if (request.estimatedRows > EXPORT_LIMITS.maxRows) blockingReasons.push('导出超过 100000 行在线上限。')
      if (request.estimatedBytes > EXPORT_LIMITS.maxBytes) blockingReasons.push('导出超过 50MB 在线上限。')

      if (blockingReasons.length > 0) {
        audit('export.blocked', request, `导出被阻断：${blockingReasons.join('；')}`)
        return success(exportView(request, 'blocked', blockingReasons))
      }
      audit('export.requested', request, `导出请求已重新鉴权：${sourceSummary(request.source)}。`)
      audit('export.completed', request, '导出计划完成，已应用水印、脱敏和短期下载链接。')
      return success(exportView(request, 'completed', []))
    },

    createShare(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (request.recipientUserIds.length === 0) return failure({
        code: 'VALIDATION_FAILED',
        message: '分享必须至少包含一个接收者',
        retryable: true,
        debugReference: 'share_recipients',
      })
      if (request.expiresInDays < 1 || request.expiresInDays > 30) return failure({
        code: 'VALIDATION_FAILED',
        message: '分享有效期必须在 1 到 30 天之间',
        retryable: true,
        debugReference: 'share_expiry',
      })
      const id = nextId('share')
      audit('share.created', request, `分享已创建，只保存 ${sourceSummary(request.source)} 引用，不复制高权限结果。`)
      const grant: ShareGrantView = {
        contractVersion: CONTRACT_VERSION,
        id,
        source: request.source,
        scope: request.scope,
        recipientUserIds: request.recipientUserIds,
        expiresAt: addDaysIso(request.expiresInDays),
        policyVersion: policyVersion(request.actor),
        storesResultSnapshot: false,
        requiresRecipientReauth: true,
        audit: auditEvents,
      }
      shares.set(id, {
        grant,
        businessDomainId: request.actor.businessDomainId,
        workspaceId: request.actor.workspaceId,
      })
      return success(grant)
    },

    reauthorizeShare(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const stored = shares.get(request.shareId)
      if (!stored) return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到可访问的分享',
        retryable: false,
        debugReference: `share_${request.shareId}`,
      })
      const recipientListed = stored.grant.recipientUserIds.includes(request.actor.userId)
      const sameWorkspace = stored.workspaceId === request.actor.workspaceId
      const sameDomain = stored.businessDomainId === request.actor.businessDomainId
      const allowed = recipientListed && sameWorkspace && sameDomain
      audit(allowed ? 'share.reauthorized' : 'share.denied', request, allowed
        ? '分享接收者重新鉴权通过，可以按自身权限重新打开。'
        : '分享接收者重新鉴权失败，不复用分享者结果。')
      return success({
        contractVersion: CONTRACT_VERSION,
        shareId: request.shareId,
        allowed,
        decision: allowed ? 'allow' : 'deny',
        reason: allowed ? '接收者权限匹配，可以按自身权限重新运行或查看。' : '接收者当前权限不足，不能继承分享者结果。',
        rerunRequired: allowed,
        policyVersion: policyVersion(request.actor),
        audit: auditEvents,
      })
    },
  }
}

export function httpStatusForSharingEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
