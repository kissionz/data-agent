import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createEvaluationApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const opsActor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_ops',
  roles: ['platform_ops', 'analyst'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const opsHeaders = {
  'x-tenant-id': opsActor.tenantId,
  'x-workspace-id': opsActor.workspaceId,
  'x-user-id': opsActor.userId,
  'x-user-roles': opsActor.roles.join(','),
  'x-business-domain-id': opsActor.businessDomainId,
  'x-semantic-version': opsActor.semanticVersion,
}

describe('Evaluation service', () => {
  it('blocks release when any P0 golden metric misses its target', () => {
    const service = createEvaluationApplicationService({ now: () => '2026-06-24T10:30:00+08:00' })
    const report = service.evaluateReleaseGate({ actor: opsActor, candidateVersion: 'planner-3.3-rc2' })

    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.data).toMatchObject({
      contractVersion: 'chatbi.contracts.v0.2',
      candidateVersion: 'planner-3.3-rc2',
      sampleSize: 2480,
      decision: 'blocked',
      releaseAllowed: false,
      failedP0: 1,
    })
    expect(report.data.failedMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '澄清召回率', result: 'fail', severity: 'p0' }),
    ]))
    expect(report.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'evaluation.release_blocked' }),
    ]))
  })

  it('lists replay runs and marks replay plans as safe, desensitized and non-production credentialed', () => {
    const service = createEvaluationApplicationService({ now: () => '2026-06-24T10:31:00+08:00' })
    const listed = service.listReplayRuns({ actor: opsActor, status: 'blocked' })

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.total).toBe(1)
    expect(listed.data.items[0]).toMatchObject({
      id: 'RUN-28403',
      status: 'blocked',
      safeForReplay: true,
      replayPlan: {
        candidateVersion: 'planner-3.3-rc2',
        requiresDesensitization: true,
        canUseProductionCredentials: false,
      },
    })
    expect(JSON.stringify(listed.data.items[0])).not.toMatch(/password|secret|token/i)
  })

  it('hides blocked replay records from ordinary business users', () => {
    const service = createEvaluationApplicationService()
    const listed = service.listReplayRuns({
      actor: { ...opsActor, userId: 'user_business', roles: ['business_user'] },
      status: 'blocked',
    })

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data).toMatchObject({ total: 0, items: [] })

    const denied = service.getReplayRun({
      actor: { ...opsActor, userId: 'user_business', roles: ['business_user'] },
      runId: 'RUN-28403',
    })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toMatchObject({ code: 'SEMANTIC_NOT_FOUND' })
  })

  it('guards golden sample promotion and schedules regression only for approved samples', () => {
    const service = createEvaluationApplicationService({ now: () => '2026-06-24T10:32:00+08:00' })
    const unsafe = service.ingestGoldenSample({
      actor: opsActor,
      sourceRunId: 'RUN-28419',
      sanitizedQuestion: '最近销售情况怎么样？',
      domain: 'sales',
      expectedIntent: 'trend',
      expectedMetricIds: ['net_revenue'],
      expectedDimensionIds: ['order_date'],
      semanticVersion: opsActor.semanticVersion,
      tags: ['clarification', 'time_ambiguity'],
      desensitized: true,
      deduplicated: false,
      humanLabeled: true,
    })
    expect(unsafe.ok).toBe(false)
    if (unsafe.ok) return
    expect(unsafe.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '线上样本必须先脱敏、去重并人工标注，不能直接进入候选集',
    })

    const regressionWithoutSamples = service.scheduleRegressionRun({
      actor: opsActor,
      candidateVersion: 'planner-3.3-rc2',
    })
    expect(regressionWithoutSamples.ok).toBe(false)

    const ingested = service.ingestGoldenSample({
      actor: opsActor,
      sourceRunId: 'RUN-28419',
      sanitizedQuestion: '最近销售情况怎么样？',
      domain: 'sales',
      expectedIntent: 'trend',
      expectedMetricIds: ['net_revenue'],
      expectedDimensionIds: ['order_date'],
      semanticVersion: opsActor.semanticVersion,
      tags: ['clarification', 'time_ambiguity'],
      desensitized: true,
      deduplicated: true,
      humanLabeled: true,
    })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok) return
    expect(ingested.data).toMatchObject({
      status: 'candidate_dataset',
      qualityGates: {
        desensitized: true,
        deduplicated: true,
        humanLabeled: true,
        productionCredentialsRemoved: true,
      },
    })
    expect(ingested.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'evaluation.sample_ingested' }),
    ]))

    const approved = service.approveGoldenSample({
      actor: opsActor,
      sampleId: ingested.data.id,
      note: '人工标注复核通过',
    })
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(approved.data).toMatchObject({
      status: 'golden_approved',
      approvedBy: 'user_ops',
    })

    const regression = service.scheduleRegressionRun({
      actor: opsActor,
      candidateVersion: 'planner-3.3-rc2',
    })
    expect(regression.ok).toBe(true)
    if (!regression.ok) return
    expect(regression.data).toMatchObject({
      status: 'queued',
      candidateVersion: 'planner-3.3-rc2',
      sampleIds: [ingested.data.id],
      sampleCount: 1,
      usesProductionCredentials: false,
      releaseGateLinked: true,
      stages: ['retrieval', 'planner', 'compiler', 'query_gateway', 'answer_grounding'],
    })
  })

  it('exposes gate and replay contracts through the BFF', () => {
    const router = createChatBiBffRouter()
    const gate = router.handle({
      method: 'GET',
      path: '/v1/evaluation/gates/current',
      headers: opsHeaders,
      query: { candidate_version: 'planner-3.3-rc2' },
    })
    expect(gate.status).toBe(200)
    expect(gate.body).toMatchObject({
      ok: true,
      data: {
        decision: 'blocked',
        releaseAllowed: false,
      },
    })

    const replays = router.handle({
      method: 'GET',
      path: '/v1/evaluation/replays',
      headers: opsHeaders,
      query: { status: 'failed', q: '最近' },
    })
    expect(replays.status).toBe(200)
    expect(replays.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [expect.objectContaining({ id: 'RUN-28419' })],
      },
    })

    const replay = router.handle({
      method: 'GET',
      path: '/v1/evaluation/replays/RUN-28419',
      headers: opsHeaders,
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({
      ok: true,
      data: {
        id: 'RUN-28419',
        replayPlan: {
          canUseProductionCredentials: false,
        },
      },
    })

    const sample = router.handle({
      method: 'POST',
      path: '/v1/evaluation/golden-samples',
      headers: opsHeaders,
      body: {
        source_run_id: 'RUN-28419',
        sanitized_question: '最近销售情况怎么样？',
        domain: 'sales',
        expected_intent: 'trend',
        expected_metric_ids: ['net_revenue'],
        expected_dimension_ids: ['order_date'],
        semantic_version: opsActor.semanticVersion,
        tags: ['clarification'],
        desensitized: true,
        deduplicated: true,
        human_labeled: true,
      },
    })
    expect(sample.status).toBe(200)
    const sampleId = (sample.body as { data: { id: string } }).data.id

    const approved = router.handle({
      method: 'POST',
      path: `/v1/evaluation/golden-samples/${sampleId}/approve`,
      headers: opsHeaders,
      body: { note: '通过' },
    })
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({
      ok: true,
      data: { id: sampleId, status: 'golden_approved' },
    })

    const regression = router.handle({
      method: 'POST',
      path: '/v1/evaluation/regression-runs',
      headers: opsHeaders,
      body: { candidate_version: 'planner-3.3-rc2' },
    })
    expect(regression.status).toBe(200)
    expect(regression.body).toMatchObject({
      ok: true,
      data: {
        status: 'queued',
        usesProductionCredentials: false,
        releaseGateLinked: true,
      },
    })
  })
})
