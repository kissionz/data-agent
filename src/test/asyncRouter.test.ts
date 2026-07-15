import { describe, expect, it, vi } from 'vitest'
import {
  createAsyncHttpRouter,
  type AsyncRouteContext,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../api'
import { resolveNodeBffResponse } from '../api/nodeServer'

const delegatedResponse: HttpResponseLike = {
  status: 204,
  headers: { 'x-delegated': 'true' },
  body: '',
}

describe('async HTTP route override boundary', () => {
  it('overrides only submit, cancel, clarify, get-run and result-page routes', async () => {
    const delegate = { handle: vi.fn(() => delegatedResponse) }
    const calls: Array<{ request: HttpRequestLike; context: AsyncRouteContext }> = []
    const override = async (request: HttpRequestLike, context: AsyncRouteContext): Promise<HttpResponseLike> => {
      calls.push({ request, context })
      return { status: 202, headers: { 'x-route': context.route }, body: context }
    }
    const router = createAsyncHttpRouter(delegate, {
      submit: override,
      cancel: override,
      clarify: override,
      getRun: override,
      resultPage: override,
    })

    const requests: HttpRequestLike[] = [
      { method: 'POST', path: '/v1/questions/' },
      { method: 'POST', path: '/v1/runs/run%2F42/cancel' },
      { method: 'POST', path: '/v1/runs/run%2F42/clarify' },
      { method: 'GET', path: '/v1/runs/run%2F42' },
      { method: 'GET', path: '/v1/results/run%2F42?cursor=next' },
    ]
    const responses = await Promise.all(requests.map((request) => router.handle(request)))

    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202])
    expect(calls.map(({ context }) => context)).toEqual([
      { route: 'submit' },
      { route: 'cancel', runId: 'run/42' },
      { route: 'clarify', runId: 'run/42' },
      { route: 'getRun', runId: 'run/42' },
      { route: 'resultPage', runId: 'run/42' },
    ])
    expect(delegate.handle).not.toHaveBeenCalled()
  })

  it('delegates events, health, management and method-mismatched requests unchanged', async () => {
    const delegate = { handle: vi.fn(() => delegatedResponse) }
    const override = vi.fn(async () => ({ status: 202, headers: {}, body: 'override' }))
    const router = createAsyncHttpRouter(delegate, {
      submit: override,
      cancel: override,
      clarify: override,
      getRun: override,
      resultPage: override,
    })
    const requests: HttpRequestLike[] = [
      { method: 'GET', path: '/v1/runs/run_1/events' },
      { method: 'GET', path: '/healthz' },
      { method: 'GET', path: '/v1/assets' },
      { method: 'GET', path: '/v1/questions' },
      { method: 'POST', path: '/v1/results/run_1' },
    ]

    await Promise.all(requests.map((request) => router.handle(request)))

    expect(override).not.toHaveBeenCalled()
    expect(delegate.handle).toHaveBeenCalledTimes(requests.length)
  })

  it('converts override rejection and delegate throws into a safe non-leaking 500', async () => {
    const secret = 'postgresql://admin:password@database.internal/chatbi'
    const rejected = createAsyncHttpRouter(
      { handle: () => delegatedResponse },
      { submit: async () => { throw new Error(`${secret}: relation chatbi_runs does not exist`) } },
    )
    const thrown = createAsyncHttpRouter({
      handle: () => { throw new Error(`${secret}: SELECT * FROM private_table`) },
    })

    for (const response of [
      await rejected.handle({ method: 'POST', path: '/v1/questions' }),
      await thrown.handle({ method: 'GET', path: '/healthz' }),
    ]) {
      expect(response).toMatchObject({
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
        body: {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' },
        },
      })
      expect(JSON.stringify(response)).not.toContain(secret)
      expect(JSON.stringify(response)).not.toContain('private_table')
      expect(JSON.stringify(response)).not.toContain('chatbi_runs')
    }
  })

  it('lets the Node server boundary await an async router', async () => {
    const router = createAsyncHttpRouter(
      { handle: () => delegatedResponse },
      {
        submit: async () => {
          await Promise.resolve()
          return {
            status: 202,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: { ok: true, accepted: true },
          }
        },
      },
    )
    const response = await resolveNodeBffResponse(router, {
      method: 'POST',
      path: '/v1/questions',
      body: { question: '过去 12 个月净收入趋势' },
    })

    expect(response).toMatchObject({ status: 202, body: { ok: true, accepted: true } })
  })
})
