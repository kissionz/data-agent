import type { WebhookDeliveryPlanView } from '../contracts'

export interface WebhookHttpRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  timeoutMs: number
}

export interface WebhookHttpResponse {
  httpStatus: number
  responseDigest: string
}

export interface WebhookHttpClient {
  post(request: WebhookHttpRequest): WebhookHttpResponse
}

export interface WebhookDeliveryJob {
  delivery: WebhookDeliveryPlanView
  payload: Record<string, unknown>
  enqueuedAt: string
}

export interface WebhookDeliveryJobView {
  deliveryId: string
  webhookId: string
  event: WebhookDeliveryPlanView['event']
  url: string
  headers: WebhookDeliveryPlanView['headers']
  status: 'queued' | 'delivered' | 'dead_lettered'
  enqueuedAt: string
  completedAt?: string
  attempts: {
    attempt: number
    scheduledAt: string
    httpStatus?: number
    result: 'pending' | 'accepted' | 'retry_scheduled' | 'dead_lettered'
    responseDigest?: string
  }[]
  payloadRedacted: true
  deliversOnlyAuthorizedData: true
}

export interface WebhookDeliveryQueue {
  enqueue(job: WebhookDeliveryJob): WebhookDeliveryJobView
  listQueued(): WebhookDeliveryJobView[]
  listDeadLetters(): WebhookDeliveryJobView[]
  getPayload(deliveryId: string): Record<string, unknown> | undefined
  markCompleted(view: WebhookDeliveryJobView): void
}

export interface WebhookDeliveryDispatcher {
  enqueue(delivery: WebhookDeliveryPlanView, payload: Record<string, unknown>): WebhookDeliveryJobView
  drain(): WebhookDeliveryJobView[]
  listQueued(): WebhookDeliveryJobView[]
  listDeadLetters(): WebhookDeliveryJobView[]
}

export function createInMemoryWebhookDeliveryQueue(): WebhookDeliveryQueue {
  const queued = new Map<string, WebhookDeliveryJobView>()
  const payloads = new Map<string, Record<string, unknown>>()
  const deadLetters = new Map<string, WebhookDeliveryJobView>()

  return {
    enqueue(job) {
      const view = toQueuedView(job)
      queued.set(view.deliveryId, view)
      payloads.set(view.deliveryId, clonePayload(job.payload))
      return cloneView(view)
    },
    listQueued() {
      return [...queued.values()].map(cloneView)
    },
    listDeadLetters() {
      return [...deadLetters.values()].map(cloneView)
    },
    getPayload(deliveryId) {
      const payload = payloads.get(deliveryId)
      return payload ? clonePayload(payload) : undefined
    },
    markCompleted(view) {
      queued.delete(view.deliveryId)
      payloads.delete(view.deliveryId)
      if (view.status === 'dead_lettered') deadLetters.set(view.deliveryId, cloneView(view))
      else deadLetters.delete(view.deliveryId)
    },
  }
}

export function createDeterministicWebhookHttpClient(statuses: number[]): WebhookHttpClient {
  let index = 0
  return {
    post(request) {
      const httpStatus = statuses[index] ?? 202
      index += 1
      return {
        httpStatus,
        responseDigest: digestResponse(request.url, httpStatus, index),
      }
    },
  }
}

export function createWebhookDeliveryDispatcher(options: {
  queue?: WebhookDeliveryQueue
  httpClient: WebhookHttpClient
  now?: () => string
  timeoutMs?: number
}): WebhookDeliveryDispatcher {
  const queue = options.queue ?? createInMemoryWebhookDeliveryQueue()
  const now = options.now ?? (() => new Date().toISOString())
  const timeoutMs = options.timeoutMs ?? 5000

  return {
    enqueue(delivery, payload) {
      return queue.enqueue({ delivery, payload, enqueuedAt: now() })
    },
    drain() {
      return queue.listQueued().map((queued) => {
        const payload = queue.getPayload(queued.deliveryId) ?? {}
        let finished = false
        const attempts = queued.attempts.map((attempt) => {
          if (finished) return attempt
          if (attempt.result !== 'pending') return attempt
          const response = options.httpClient.post({
            url: queued.url,
            headers: queued.headers,
            body: payload,
            timeoutMs,
          })
          const accepted = response.httpStatus >= 200 && response.httpStatus < 300
          const finalAttempt = attempt.attempt === queued.attempts.length
          finished = accepted || finalAttempt
          return {
            ...attempt,
            httpStatus: response.httpStatus,
            responseDigest: response.responseDigest,
            result: accepted
              ? 'accepted' as const
              : finalAttempt
                ? 'dead_lettered' as const
                : 'retry_scheduled' as const,
          }
        })
        const accepted = attempts.some((attempt) => attempt.result === 'accepted')
        const deadLettered = attempts.at(-1)?.result === 'dead_lettered'
        const completed: WebhookDeliveryJobView = {
          ...queued,
          status: accepted ? 'delivered' : deadLettered ? 'dead_lettered' : 'queued',
          attempts,
          ...(accepted || deadLettered ? { completedAt: now() } : {}),
        }
        if (completed.status !== 'queued') queue.markCompleted(completed)
        return cloneView(completed)
      })
    },
    listQueued() {
      return queue.listQueued()
    },
    listDeadLetters() {
      return queue.listDeadLetters()
    },
  }
}

function toQueuedView(job: WebhookDeliveryJob): WebhookDeliveryJobView {
  return {
    deliveryId: job.delivery.id,
    webhookId: job.delivery.webhookId,
    event: job.delivery.event,
    url: job.delivery.url,
    headers: { ...job.delivery.headers },
    status: 'queued',
    enqueuedAt: job.enqueuedAt,
    attempts: job.delivery.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      scheduledAt: attempt.scheduledAt,
      ...(attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus }),
      result: attempt.result,
    })),
    payloadRedacted: true,
    deliversOnlyAuthorizedData: job.delivery.deliversOnlyAuthorizedData,
  }
}

function clonePayload(payload: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
}

function cloneView(view: WebhookDeliveryJobView): WebhookDeliveryJobView {
  return {
    ...view,
    headers: { ...view.headers },
    attempts: view.attempts.map((attempt) => ({ ...attempt })),
  }
}

function digestResponse(url: string, httpStatus: number, sequence: number) {
  return `response:${url.length}:${httpStatus}:${sequence}`
}
