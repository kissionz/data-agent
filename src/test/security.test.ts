import { describe, expect, it } from 'vitest'
import { sanitizeRunError, transitionRun } from '../domain'
import { questionScenarios } from '../mocks'

describe('PRD security gates', () => {
  it('blocks unauthorized questions before query execution', () => {
    const scenario = questionScenarios.permission_denied
    expect(scenario.executedQuery).toBe(false)
    expect(scenario.run.displayStatus).toBe('failed')
    expect(scenario.run.error).toMatchObject({
      code: 'PERMISSION_DENIED',
      userMessage: '无权访问该内容',
      retryable: false,
    })
    expect(scenario.run.result).toBeUndefined()
    expect(scenario.run.clarification).toBeUndefined()
  })

  it('removes SQL, resource and policy details from permission failures', () => {
    const sanitized = sanitizeRunError({
      code: 'PERMISSION_DENIED',
      userMessage: 'table customer exists but policy sales denied it',
      retryable: true,
      debugReference: 'security_ref',
      safeDetails: 'SELECT phone FROM customer',
    })
    expect(sanitized.userMessage).toBe('无权访问该内容')
    expect(sanitized.safeDetails).toBeUndefined()
    expect(sanitized.retryable).toBe(false)
    expect(JSON.stringify(sanitized)).not.toMatch(/customer|phone|SELECT|policy/i)
  })

  it('blocks over-budget questions before query execution and offers safe recovery', () => {
    const scenario = questionScenarios.over_budget
    expect(scenario.executedQuery).toBe(false)
    expect(scenario.run.error?.code).toBe('QUERY_TOO_EXPENSIVE')
    expect(scenario.run.error?.retryable).toBe(true)
    expect(scenario.run.error?.userMessage).toContain('缩短时间')
    expect(scenario.run.result).toBeUndefined()
  })

  it('does not allow failure records to expose a result', () => {
    const run = questionScenarios.permission_denied.run
    expect(() => transitionRun(run, { type: 'FAILED', error: run.error!, at: run.updatedAt })).toThrow()
  })
})
