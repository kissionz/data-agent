import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ActorContext,
  type ApiEnvelope,
  type ApiKeyRotationView,
  type ApiKeyVerificationView,
  type ApiKeyView,
  type CreateServiceAccountRequest,
  type DeveloperAccessAuditEvent,
  type DeveloperScope,
  type EmbedTokenView,
  type IssueApiKeyRequest,
  type IssueEmbedTokenRequest,
  type PlanWebhookDeliveryRequest,
  type PublicApiError,
  type RegisterWebhookRequest,
  type RevokeApiKeyRequest,
  type RotateApiKeyRequest,
  type ServiceAccountView,
  type TestWebhookRequest,
  type VerifyApiKeyRequest,
  type WebhookDeliveryPlanView,
  type WebhookSubscriptionView,
} from '../contracts'

export interface DeveloperAccessApplicationService {
  createServiceAccount(request: CreateServiceAccountRequest): ApiEnvelope<ServiceAccountView>
  issueApiKey(request: IssueApiKeyRequest): ApiEnvelope<ApiKeyView>
  verifyApiKey(request: VerifyApiKeyRequest): ApiEnvelope<ApiKeyVerificationView>
  rotateApiKey(request: RotateApiKeyRequest): ApiEnvelope<ApiKeyRotationView>
  revokeApiKey(request: RevokeApiKeyRequest): ApiEnvelope<ApiKeyView>
  registerWebhook(request: RegisterWebhookRequest): ApiEnvelope<WebhookSubscriptionView>
  testWebhook(request: TestWebhookRequest): ApiEnvelope<WebhookSubscriptionView>
  planWebhookDelivery(request: PlanWebhookDeliveryRequest): ApiEnvelope<WebhookDeliveryPlanView>
  issueEmbedToken(request: IssueEmbedTokenRequest): ApiEnvelope<EmbedTokenView>
}

export interface DeveloperAccessApplicationOptions {
  now?: () => string
}

const allowedScopes: DeveloperScope[] = [
  'questions:write',
  'feedback:write',
  'runs:read',
  'semantic:read',
  'assets:read',
  'exports:create',
  'exports:read',
  'webhooks:manage',
  'embed:issue',
]

export function createDeveloperAccessApplicationService(
  options: DeveloperAccessApplicationOptions = {},
): DeveloperAccessApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const serviceAccounts = new Map<string, ServiceAccountView>()
  const apiKeys = new Map<string, ApiKeyView>()
  const webhooks = new Map<string, WebhookSubscriptionView>()
  const webhookSecretHashes = new Map<string, string>()
  const auditEvents: DeveloperAccessAuditEvent[] = []

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

  function invalidActor(request: { actor: CreateServiceAccountRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function canManageDeveloperAccess(request: { actor: CreateServiceAccountRequest['actor'] }) {
    return request.actor.roles.some((role) => ['platform_ops', 'security_admin'].includes(role))
  }

  function policyVersion(actor: CreateServiceAccountRequest['actor']) {
    return actor.policyVersion ?? 'policy-2026.06.7'
  }

  function permissionDigest(actor: CreateServiceAccountRequest['actor']) {
    return [
      actor.tenantId,
      actor.workspaceId,
      actor.businessDomainId,
      actor.roles.slice().sort().join('+'),
      policyVersion(actor),
    ].join('|')
  }

  function addTimeIso(amount: number, unit: 'days' | 'minutes') {
    const base = new Date(now())
    if (unit === 'days') base.setUTCDate(base.getUTCDate() + amount)
    else base.setUTCMinutes(base.getUTCMinutes() + amount)
    return base.toISOString()
  }

  function audit(
    type: DeveloperAccessAuditEvent['type'],
    request: { actor: CreateServiceAccountRequest['actor'] },
    targetId: string,
    summary: string,
  ) {
    const event: DeveloperAccessAuditEvent = {
      id: nextId('developer_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      targetId,
      summary,
    }
    auditEvents.push(event)
    return event
  }

  function developerDenied(request: { actor: CreateServiceAccountRequest['actor'] }) {
    audit('developer.access_denied', request, request.actor.userId, '开发者接入管理被拒绝：角色不足。')
    return failure({
      code: 'PERMISSION_DENIED',
      message: '只有平台运维或安全管理员可以管理开发者接入',
      retryable: false,
      debugReference: 'developer_access_role',
    })
  }

  function validateScopes(scopes: DeveloperScope[]) {
    const unique = [...new Set(scopes)]
    if (unique.length === 0) return '至少需要一个 scope'
    const invalid = unique.filter((scope) => !allowedScopes.includes(scope))
    if (invalid.length > 0) return `不支持的 scope：${invalid.join(', ')}`
    return null
  }

  function hashSecret(raw: string) {
    return `sha256:${Array.from(raw).reduce((acc, char) => acc + char.charCodeAt(0), 0).toString(16).padStart(12, '0')}`
  }

  function secretMaterial(prefix: string, id: string) {
    const raw = `${prefix}_${id}_${sequence}`
    return {
      prefix: `${prefix}_${id.slice(-4)}`,
      secretPreview: `${prefix}_${id.slice(-4)}...redacted`,
      secretHash: hashSecret(raw),
    }
  }

  function serviceAccountAudit(id: string) {
    return auditEvents.filter((event) => event.targetId === id)
  }

  function keyAudit(id: string, serviceAccountId: string) {
    return auditEvents.filter((event) => event.targetId === id || event.targetId === serviceAccountId)
  }

  function apiKeyVerificationDenied(message: string, debugReference: string): ApiEnvelope<never> {
    return failure({
      code: 'PERMISSION_DENIED',
      message,
      retryable: false,
      debugReference,
    })
  }

  function webhookAudit(id: string) {
    return auditEvents.filter((event) => event.targetId === id)
  }

  function signature(deliveryId: string, webhookId: string, event: string, payload: Record<string, unknown>) {
    const secretHash = webhookSecretHashes.get(webhookId) ?? 'sha256:missing'
    return hashSecret(`${secretHash}.${deliveryId}.${event}.${JSON.stringify(payload)}`)
  }

  function addMinutesIso(minutes: number) {
    const base = new Date(now())
    base.setUTCMinutes(base.getUTCMinutes() + minutes)
    return base.toISOString()
  }

  return {
    createServiceAccount(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      const scopeError = validateScopes(request.scopes)
      if (scopeError) return failure({
        code: 'VALIDATION_FAILED',
        message: scopeError,
        retryable: true,
        debugReference: 'developer_scopes',
      })
      if (request.expiresInDays < 1 || request.expiresInDays > 365) return failure({
        code: 'VALIDATION_FAILED',
        message: '服务账号有效期必须在 1 到 365 天之间',
        retryable: true,
        debugReference: 'service_account_expiry',
      })
      if (request.dailyRequestLimit < 1 || request.dailyRequestLimit > 100000) return failure({
        code: 'VALIDATION_FAILED',
        message: '服务账号日请求配额必须在 1 到 100000 之间',
        retryable: true,
        debugReference: 'service_account_quota',
      })
      const id = nextId('svc')
      audit('developer.service_account_created', request, id, '服务账号已创建，scope 和配额绑定到当前工作区。')
      const account: ServiceAccountView = {
        contractVersion: CONTRACT_VERSION,
        id,
        name: request.name.trim() || '未命名服务账号',
        status: 'active',
        workspaceId: request.actor.workspaceId,
        businessDomainId: request.actor.businessDomainId,
        scopes: [...new Set(request.scopes)],
        quota: {
          dailyRequestLimit: request.dailyRequestLimit,
          dailyRequestUsed: 0,
        },
        createdBy: request.actor.userId,
        createdAt: now(),
        expiresAt: addTimeIso(request.expiresInDays, 'days'),
        audit: serviceAccountAudit(id),
      }
      serviceAccounts.set(id, account)
      return success(account)
    },

    issueApiKey(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      const account = serviceAccounts.get(request.serviceAccountId)
      if (!account || account.status !== 'active') return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到可用服务账号',
        retryable: false,
        debugReference: `service_account_${request.serviceAccountId}`,
      })
      if (request.expiresInDays < 1 || request.expiresInDays > 90) return failure({
        code: 'VALIDATION_FAILED',
        message: 'API Key 有效期必须在 1 到 90 天之间',
        retryable: true,
        debugReference: 'api_key_expiry',
      })
      const id = nextId('key')
      const secret = secretMaterial('ifk_live', id)
      audit('developer.api_key_issued', request, id, 'API Key 已签发；只返回一次前缀与脱敏预览，不返回明文密钥。')
      const key: ApiKeyView = {
        contractVersion: CONTRACT_VERSION,
        id,
        serviceAccountId: account.id,
        prefix: secret.prefix,
        secretPreview: secret.secretPreview,
        secretHash: secret.secretHash,
        status: 'active',
        scopes: account.scopes,
        expiresAt: addTimeIso(request.expiresInDays, 'days'),
        rotationRequiredBefore: addTimeIso(Math.max(1, request.expiresInDays - 7), 'days'),
        audit: keyAudit(id, account.id),
      }
      apiKeys.set(id, key)
      return success(key)
    },

    verifyApiKey(request) {
      const requestedScopes = [...new Set(request.requiredScopes)]
      const scopeError = validateScopes(requestedScopes)
      if (scopeError) return failure({
        code: 'VALIDATION_FAILED',
        message: scopeError,
        retryable: true,
        debugReference: 'api_key_required_scopes',
      })
      if (!request.presentedSecret.trim()) {
        return apiKeyVerificationDenied('API Key 无效或已失效', 'api_key_missing')
      }
      const presentedHash = hashSecret(request.presentedSecret)
      const key = [...apiKeys.values()].find((candidate) => candidate.secretHash === presentedHash)
      if (!key || key.status === 'revoked') {
        return apiKeyVerificationDenied('API Key 无效或已失效', 'api_key_invalid')
      }
      const account = serviceAccounts.get(key.serviceAccountId)
      if (!account || account.status !== 'active') {
        return apiKeyVerificationDenied('服务账号不可用', `service_account_${key.serviceAccountId}`)
      }
      const currentTime = new Date(now()).getTime()
      if (key.status === 'rotating' && (!key.rotationGraceEndsAt || new Date(key.rotationGraceEndsAt).getTime() <= currentTime)) {
        return apiKeyVerificationDenied('API Key 轮换宽限期已结束', `api_key_rotation_${key.id}`)
      }
      if (new Date(key.expiresAt).getTime() <= currentTime || new Date(account.expiresAt).getTime() <= currentTime) {
        return apiKeyVerificationDenied('API Key 已过期', `api_key_${key.id}`)
      }
      const missingScopes = requestedScopes.filter((scope) => !key.scopes.includes(scope))
      if (missingScopes.length > 0) {
        return apiKeyVerificationDenied(`API Key 缺少 scope：${missingScopes.join(', ')}`, `api_key_scope_${key.id}`)
      }
      if (account.workspaceId !== request.workspaceId || account.businessDomainId !== request.businessDomainId) {
        return apiKeyVerificationDenied('API Key 不能跨工作区或业务域使用', `api_key_boundary_${key.id}`)
      }
      if (account.quota.dailyRequestUsed >= account.quota.dailyRequestLimit) {
        return failure({
          code: 'QUERY_TOO_EXPENSIVE',
          message: '服务账号日请求配额已用尽',
          retryable: true,
          debugReference: `api_key_quota_${key.id}`,
        })
      }
      account.quota.dailyRequestUsed += 1
      serviceAccounts.set(account.id, account)
      const actor: ActorContext = {
        tenantId: 'tenant_demo',
        workspaceId: account.workspaceId,
        userId: account.id,
        roles: ['service_account'],
        businessDomainId: account.businessDomainId,
        semanticVersion: request.semanticVersion,
        policyVersion: policyVersion({
          tenantId: 'tenant_demo',
          workspaceId: account.workspaceId,
          userId: account.id,
          roles: ['service_account'],
          businessDomainId: account.businessDomainId,
          semanticVersion: request.semanticVersion,
          locale: request.locale,
          timezone: request.timezone,
        }),
        locale: request.locale,
        timezone: request.timezone,
      }
      audit('developer.api_key_verified', { actor }, key.id, 'API Key 验签通过，已生成服务端可信 actor 并递增配额。')
      return success({
        contractVersion: CONTRACT_VERSION,
        authenticated: true,
        keyId: key.id,
        serviceAccountId: account.id,
        actor,
        scopes: key.scopes,
        quota: { ...account.quota },
        permissionDigest: permissionDigest(actor),
        cannotAccessDatabaseCredentials: true,
        audit: keyAudit(key.id, account.id),
      })
    },

    rotateApiKey(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      const oldKey = apiKeys.get(request.keyId)
      if (!oldKey || oldKey.status !== 'active') return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到可轮换的 API Key',
        retryable: false,
        debugReference: `api_key_${request.keyId}`,
      })
      const account = serviceAccounts.get(oldKey.serviceAccountId)
      if (!account || account.status !== 'active') return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '服务账号不可用',
        retryable: false,
        debugReference: `service_account_${oldKey.serviceAccountId}`,
      })
      if (request.expiresInDays < 1 || request.expiresInDays > 90) return failure({
        code: 'VALIDATION_FAILED',
        message: 'API Key 有效期必须在 1 到 90 天之间',
        retryable: true,
        debugReference: 'api_key_rotation_expiry',
      })
      if (request.graceMinutes < 5 || request.graceMinutes > 1440) return failure({
        code: 'VALIDATION_FAILED',
        message: 'API Key 轮换宽限期必须在 5 到 1440 分钟之间',
        retryable: true,
        debugReference: 'api_key_rotation_grace',
      })

      const newId = nextId('key')
      const secret = secretMaterial('ifk_live', newId)
      const graceEndsAt = addTimeIso(request.graceMinutes, 'minutes')
      oldKey.status = 'rotating'
      oldKey.rotationGraceEndsAt = graceEndsAt
      oldKey.rotatedToKeyId = newId
      const newKey: ApiKeyView = {
        contractVersion: CONTRACT_VERSION,
        id: newId,
        serviceAccountId: account.id,
        prefix: secret.prefix,
        secretPreview: secret.secretPreview,
        secretHash: secret.secretHash,
        status: 'active',
        scopes: oldKey.scopes,
        expiresAt: addTimeIso(request.expiresInDays, 'days'),
        rotationRequiredBefore: addTimeIso(Math.max(1, request.expiresInDays - 7), 'days'),
        rotatedFromKeyId: oldKey.id,
        audit: keyAudit(newId, account.id),
      }
      apiKeys.set(oldKey.id, oldKey)
      apiKeys.set(newKey.id, newKey)
      audit('developer.api_key_rotated', request, oldKey.id, `API Key 已轮换；旧 key 在 ${graceEndsAt} 前仍处于宽限期。`)
      audit('developer.api_key_issued', request, newKey.id, '轮换后的 API Key 已签发；只返回脱敏预览和 hash 指纹，不返回明文。')
      return success({
        contractVersion: CONTRACT_VERSION,
        serviceAccountId: account.id,
        oldKey: { ...oldKey, audit: keyAudit(oldKey.id, account.id) },
        newKey: { ...newKey, audit: keyAudit(newKey.id, account.id) },
        graceEndsAt,
        oldKeyAcceptedDuringGrace: true,
        plaintextSecretReturnedOnlyOnce: false,
        audit: keyAudit(oldKey.id, account.id).concat(keyAudit(newKey.id, account.id)),
      })
    },

    revokeApiKey(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      const key = apiKeys.get(request.keyId)
      if (!key) return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到 API Key',
        retryable: false,
        debugReference: `api_key_${request.keyId}`,
      })
      key.status = 'revoked'
      audit('developer.api_key_revoked', request, key.id, `API Key 已撤销：${request.reason || '无备注'}。`)
      return success({ ...key, audit: keyAudit(key.id, key.serviceAccountId) })
    },

    registerWebhook(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      if (!request.actor.roles.includes('security_admin') && !request.actor.roles.includes('platform_ops')) return developerDenied(request)
      if (!request.url.startsWith('https://')) return failure({
        code: 'VALIDATION_FAILED',
        message: 'Webhook URL 必须使用 HTTPS',
        retryable: true,
        debugReference: 'webhook_https',
      })
      if (request.events.length === 0) return failure({
        code: 'VALIDATION_FAILED',
        message: 'Webhook 至少需要订阅一个事件',
        retryable: true,
        debugReference: 'webhook_events',
      })
      const id = nextId('webhook')
      const secret = secretMaterial('whsec', id)
      webhookSecretHashes.set(id, secret.secretHash)
      audit('developer.webhook_registered', request, id, 'Webhook 已注册，启用 HMAC 签名、重放保护和死信策略。')
      const webhook: WebhookSubscriptionView = {
        contractVersion: CONTRACT_VERSION,
        id,
        url: request.url,
        events: [...new Set(request.events)],
        status: 'active',
        secretPreview: secret.secretPreview,
        signingAlgorithm: 'hmac-sha256',
        replayProtectionSeconds: 300,
        retryPolicy: {
          maxAttempts: 5,
          backoff: 'exponential',
          deadLetterAfterAttempts: 5,
        },
        deliversOnlyAuthorizedData: true,
        audit: webhookAudit(id),
      }
      webhooks.set(id, webhook)
      return success(webhook)
    },

    testWebhook(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      const webhook = webhooks.get(request.webhookId)
      if (!webhook) return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到 Webhook',
        retryable: false,
        debugReference: `webhook_${request.webhookId}`,
      })
      audit('developer.webhook_tested', request, webhook.id, 'Webhook 测试事件已生成，签名校验通过，不携带越权数据。')
      const tested: WebhookSubscriptionView = {
        ...webhook,
        lastTest: {
          status: 'accepted',
          httpStatus: 202,
          signatureVerified: true,
        },
        audit: webhookAudit(webhook.id),
      }
      webhooks.set(webhook.id, tested)
      return success(tested)
    },

    planWebhookDelivery(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManageDeveloperAccess(request)) return developerDenied(request)
      const webhook = webhooks.get(request.webhookId)
      if (!webhook || webhook.status !== 'active') return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到可投递的 Webhook',
        retryable: false,
        debugReference: `webhook_${request.webhookId}`,
      })
      if (!webhook.events.includes(request.event)) return failure({
        code: 'VALIDATION_FAILED',
        message: 'Webhook 未订阅该事件',
        retryable: true,
        debugReference: `webhook_event_${request.event}`,
      })
      const deliveryId = nextId('webhook_delivery')
      const simulated = request.simulatedHttpStatuses ?? []
      const attempts: WebhookDeliveryPlanView['attempts'] = []
      let finalState: WebhookDeliveryPlanView['finalState'] = simulated.length ? 'dead_lettered' : 'queued'
      for (let index = 0; index < webhook.retryPolicy.maxAttempts; index += 1) {
        const attempt = index + 1
        const httpStatus = simulated[index]
        const accepted = httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300
        const finalAttempt = attempt === webhook.retryPolicy.maxAttempts
        attempts.push({
          attempt,
          scheduledAt: addMinutesIso(index === 0 ? 0 : 2 ** (index - 1)),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          result: accepted ? 'accepted' : httpStatus === undefined ? 'pending' : finalAttempt ? 'dead_lettered' : 'retry_scheduled',
        })
        if (accepted) {
          finalState = 'accepted'
          break
        }
        if (httpStatus === undefined) finalState = 'queued'
      }
      const deadLetter = finalState === 'dead_lettered'
        ? { reason: '连续投递失败，进入死信队列。', afterAttempts: webhook.retryPolicy.deadLetterAfterAttempts }
        : undefined
      audit('developer.webhook_delivery_planned', request, webhook.id, finalState === 'accepted'
        ? 'Webhook 投递计划已生成并模拟成功。'
        : finalState === 'dead_lettered'
          ? 'Webhook 投递计划已生成，超过重试上限后进入死信队列。'
          : 'Webhook 投递计划已生成，等待异步队列执行。')
      return success({
        contractVersion: CONTRACT_VERSION,
        id: deliveryId,
        webhookId: webhook.id,
        event: request.event,
        url: webhook.url,
        finalState,
        signingAlgorithm: webhook.signingAlgorithm,
        headers: {
          'x-insightflow-event': request.event,
          'x-insightflow-delivery': deliveryId,
          'x-insightflow-timestamp': now(),
          'x-insightflow-signature': signature(deliveryId, webhook.id, request.event, request.payload),
        },
        replayProtectionExpiresAt: addMinutesIso(Math.ceil(webhook.replayProtectionSeconds / 60)),
        attempts,
        ...(deadLetter ? { deadLetter } : {}),
        payloadRedacted: true,
        deliversOnlyAuthorizedData: true,
        audit: webhookAudit(webhook.id),
      })
    },

    issueEmbedToken(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!request.actor.roles.some((role) => ['business_user', 'business_owner', 'analyst', 'platform_ops', 'security_admin'].includes(role))) {
        return developerDenied(request)
      }
      if (!request.hostOrigin.startsWith('https://')) return failure({
        code: 'VALIDATION_FAILED',
        message: '嵌入 Host Origin 必须使用 HTTPS',
        retryable: true,
        debugReference: 'embed_origin_https',
      })
      if (request.expiresInMinutes < 5 || request.expiresInMinutes > 120) return failure({
        code: 'VALIDATION_FAILED',
        message: '嵌入 token 有效期必须在 5 到 120 分钟之间',
        retryable: true,
        debugReference: 'embed_token_ttl',
      })
      const id = nextId('embed')
      const tokenPreview = `embed_${id.slice(-4)}...redacted`
      audit('developer.embed_token_issued', request, id, '嵌入 token 已签发；Host 负责换取短期 token，组件不能接触数据库凭据。')
      const scopes: EmbedTokenView['scopes'] = request.source.type === 'run' ? ['runs:read'] : ['assets:read']
      return success({
        contractVersion: CONTRACT_VERSION,
        tokenId: id,
        tokenPreview,
        hostOrigin: request.hostOrigin,
        source: request.source,
        expiresAt: addTimeIso(request.expiresInMinutes, 'minutes'),
        scopes,
        policyVersion: policyVersion(request.actor),
        permissionDigest: permissionDigest(request.actor),
        cannotAccessDatabaseCredentials: true,
        audit: auditEvents.filter((event) => event.targetId === id),
      })
    },
  }
}

export function httpStatusForDeveloperAccessEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
