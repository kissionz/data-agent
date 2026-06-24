import { collaborationAssets } from '../features/collaboration/fixtures'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  validationError,
  type ApiEnvelope,
  type CollaborationAssetView,
  type CollaborationAuditEvent,
  type GetAssetAuditRequest,
  type ListAssetsRequest,
  type PublicApiError,
  type SubscriptionCadence,
  type UpdateAssetFavoriteRequest,
  type UpdateAssetSubscriptionRequest,
} from '../contracts'

export interface CollaborationAssetApplicationService {
  listAssets(request: ListAssetsRequest): ApiEnvelope<{ items: CollaborationAssetView[]; total: number }>
  updateFavorite(request: UpdateAssetFavoriteRequest): ApiEnvelope<CollaborationAssetView>
  updateSubscription(request: UpdateAssetSubscriptionRequest): ApiEnvelope<CollaborationAssetView>
  getAudit(request: GetAssetAuditRequest): ApiEnvelope<{ assetId: string; events: CollaborationAuditEvent[] }>
}

export interface CollaborationAssetApplicationOptions {
  now?: () => string
}

export function createCollaborationAssetApplicationService(
  options: CollaborationAssetApplicationOptions = {},
): CollaborationAssetApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const assets = collaborationAssets.map((asset) => ({ ...asset, reviewers: asset.reviewers.map((reviewer) => ({ ...reviewer })) }))
  const auditEvents = new Map<string, CollaborationAuditEvent[]>()

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
  }

  function requestIds() {
    return { requestId: nextId('req'), traceId: nextId('trace') }
  }

  function failure(error: PublicApiError): ApiEnvelope<never> {
    return { ok: false, ...requestIds(), error }
  }

  function actorFailure(request: { actor: ListAssetsRequest['actor'] }): ApiEnvelope<never> | null {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function notFound(assetId: string): PublicApiError {
    return {
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可访问的协作资产',
      retryable: false,
      debugReference: `asset_${assetId}`,
    }
  }

  function canSeeAsset(asset: typeof assets[number], request: { actor: ListAssetsRequest['actor'] }) {
    if (asset.isArchived) return request.actor.roles.some((role) => ['analyst', 'metric_admin', 'security_admin'].includes(role))
    if (asset.status === 'review') return request.actor.roles.some((role) => ['analyst', 'metric_admin'].includes(role))
    return asset.shareScope !== 'external_blocked'
  }

  function audit(type: CollaborationAuditEvent['type'], request: { actor: ListAssetsRequest['actor'] }, assetId: string, summary: string) {
    const event: CollaborationAuditEvent = {
      id: nextId('asset_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      assetId,
      summary,
    }
    const existing = auditEvents.get(assetId) ?? []
    auditEvents.set(assetId, [...existing, event])
    return event
  }

  function view(asset: typeof assets[number]): CollaborationAssetView {
    const events = auditEvents.get(asset.id) ?? []
    return {
      contractVersion: CONTRACT_VERSION,
      ...asset,
      permissionSummary: {
        workspaceScoped: asset.shareScope === 'workspace' || asset.shareScope === 'domain_leads',
        requiresRecipientReauth: true,
        exportWatermarkRequired: asset.watermarkedExport,
      },
      audit: [
        {
          id: `${asset.id}_seed`,
          at: asset.updatedAt,
          type: 'asset.audit_viewed',
          actorUserId: 'system',
          tenantId: 'tenant_demo',
          workspaceId: 'workspace_sales',
          assetId: asset.id,
          summary: asset.lastAudit,
        },
        ...events,
      ],
    }
  }

  function findVisibleAsset(assetId: string, request: { actor: ListAssetsRequest['actor'] }) {
    const asset = assets.find((candidate) => candidate.id === assetId)
    if (!asset || !canSeeAsset(asset, request)) return undefined
    return asset
  }

  function success<T>(data: T): ApiEnvelope<T> {
    return { ok: true, ...requestIds(), data }
  }

  return {
    listAssets(request) {
      const invalid = actorFailure(request)
      if (invalid) return invalid
      const normalizedQuery = request.query?.trim().toLowerCase()
      const items = assets
        .filter((asset) => canSeeAsset(asset, request))
        .filter((asset) => !request.status || request.status === 'all' || asset.status === request.status)
        .filter((asset) => {
          if (!normalizedQuery) return true
          return [
            asset.title,
            asset.description,
            asset.owner,
            asset.businessDomain,
            asset.questionTemplate,
          ].some((value) => value.toLowerCase().includes(normalizedQuery))
        })
        .map((asset) => {
          audit('asset.listed', request, asset.id, '协作资产进入当前用户列表，已按可见范围过滤。')
          return view(asset)
        })
      return success({ items, total: items.length })
    },

    updateFavorite(request) {
      const invalid = actorFailure(request)
      if (invalid) return invalid
      const asset = findVisibleAsset(request.assetId, request)
      if (!asset) return failure(notFound(request.assetId))
      asset.isFavorite = request.favorite
      asset.updatedAt = now()
      audit(
        'asset.favorite_updated',
        request,
        asset.id,
        request.favorite ? '用户收藏协作资产。' : '用户取消收藏协作资产。',
      )
      return success(view(asset))
    },

    updateSubscription(request) {
      const invalid = actorFailure(request)
      if (invalid) return invalid
      const asset = findVisibleAsset(request.assetId, request)
      if (!asset) return failure(notFound(request.assetId))
      if (!isSubscriptionCadence(request.cadence)) return failure(validationError('订阅频率无效'))
      if (asset.status !== 'active') {
        audit('asset.subscription_blocked', request, asset.id, '非活跃资产不能开启订阅。')
        return failure({
          code: 'VALIDATION_FAILED',
          message: '审核中或已归档的资产不能订阅',
          retryable: true,
          debugReference: `asset_subscription_${asset.id}`,
        })
      }
      const hadSubscription = asset.subscriptionCadence !== 'none'
      const willSubscribe = request.cadence !== 'none'
      asset.subscriptionCadence = request.cadence
      asset.subscribers = Math.max(0, asset.subscribers + (willSubscribe && !hadSubscription ? 1 : !willSubscribe && hadSubscription ? -1 : 0))
      asset.updatedAt = now()
      audit('asset.subscription_updated', request, asset.id, `订阅频率更新为 ${request.cadence}，接收者仍需重新鉴权。`)
      return success(view(asset))
    },

    getAudit(request) {
      const invalid = actorFailure(request)
      if (invalid) return invalid
      const asset = findVisibleAsset(request.assetId, request)
      if (!asset) return failure(notFound(request.assetId))
      audit('asset.audit_viewed', request, asset.id, '用户查看协作资产审计链路。')
      return success({ assetId: asset.id, events: view(asset).audit })
    },
  }
}

export function isSubscriptionCadence(value: unknown): value is SubscriptionCadence {
  return value === 'daily' || value === 'weekly' || value === 'threshold' || value === 'none'
}

export function httpStatusForAssetEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
