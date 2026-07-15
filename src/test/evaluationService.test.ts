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

  it('lists and filters seeded golden samples while keeping management roles explicit', () => {
    const service = createEvaluationApplicationService({ seedGoldenSamples: true })
    const candidate = service.listGoldenSamples({
      actor: opsActor,
      status: 'candidate_dataset',
      query: '最近',
      tag: '澄清',
    })
    expect(candidate.ok).toBe(true)
    if (!candidate.ok) return
    expect(candidate.data).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          id: 'golden_seed_002',
          status: 'candidate_dataset',
          sanitizedQuestion: '最近销售情况怎么样？',
          qualityGates: {
            desensitized: true,
            deduplicated: true,
            humanLabeled: true,
            productionCredentialsRemoved: true,
          },
        }),
      ],
    })

    const detail = service.getGoldenSample({ actor: opsActor, sampleId: 'golden_seed_002' })
    expect(detail.ok).toBe(true)
    const denied = service.listGoldenSamples({
      actor: { ...opsActor, userId: 'user_business', roles: ['business_user'] },
    })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('isolates approved samples and regression plans across tenant and workspace boundaries', () => {
    const service = createEvaluationApplicationService()
    const sameTenantOtherWorkspace = {
      ...opsActor,
      workspaceId: 'workspace_other',
      userId: 'user_workspace_ops',
    }
    const otherTenantSameWorkspace = {
      ...opsActor,
      tenantId: 'tenant_other',
      userId: 'user_tenant_ops',
    }

    for (const [index, actor] of [sameTenantOtherWorkspace, otherTenantSameWorkspace].entries()) {
      const ingested = service.ingestGoldenSample({
        actor,
        sourceRunId: `RUN-OTHER-${index + 1}`,
        sanitizedQuestion: `其他作用域样本 ${index + 1}`,
        domain: '销售分析',
        expectedIntent: 'lookup',
        expectedMetricIds: ['net_revenue'],
        expectedDimensionIds: [],
        semanticVersion: actor.semanticVersion,
        tags: ['标准'],
        desensitized: true,
        deduplicated: true,
        humanLabeled: true,
      })
      expect(ingested.ok).toBe(true)
      if (!ingested.ok) return
      const approved = service.approveGoldenSample({ actor, sampleId: ingested.data.id, note: '作用域内复核通过' })
      expect(approved.ok).toBe(true)
      const plan = service.scheduleRegressionRun({
        actor,
        candidateVersion: `planner-other-${index + 1}`,
        sampleIds: [ingested.data.id],
      })
      expect(plan.ok).toBe(true)
      if (!plan.ok) return

      const invisibleSample = service.getGoldenSample({ actor: opsActor, sampleId: ingested.data.id })
      expect(invisibleSample.ok).toBe(false)
      if (!invisibleSample.ok) expect(invisibleSample.error).toMatchObject({ code: 'SEMANTIC_NOT_FOUND' })
      const invisiblePlan = service.getRegressionRun({ actor: opsActor, regressionRunId: plan.data.id })
      expect(invisiblePlan.ok).toBe(false)
      if (!invisiblePlan.ok) expect(invisiblePlan.error).toMatchObject({ code: 'SEMANTIC_NOT_FOUND' })
    }

    const samples = service.listGoldenSamples({ actor: opsActor })
    const plans = service.listRegressionRuns({ actor: opsActor })
    expect(samples.ok && samples.data.total).toBe(0)
    expect(plans.ok && plans.data.total).toBe(0)
  })

  it('separates evaluation read, ingest, approval and scheduling roles', () => {
    const service = createEvaluationApplicationService({ seedGoldenSamples: true })
    const analyst = { ...opsActor, userId: 'user_analyst', roles: ['analyst'] as ActorContext['roles'] }
    const metricAdmin = { ...opsActor, userId: 'user_metric_admin', roles: ['metric_admin'] as ActorContext['roles'] }

    expect(service.listGoldenSamples({ actor: analyst }).ok).toBe(true)
    const analystApproval = service.approveGoldenSample({
      actor: analyst,
      sampleId: 'golden_seed_002',
      note: '分析师不应拥有审批权',
    })
    expect(analystApproval.ok).toBe(false)
    if (!analystApproval.ok) expect(analystApproval.error).toMatchObject({ code: 'PERMISSION_DENIED' })

    const adminApproval = service.approveGoldenSample({
      actor: metricAdmin,
      sampleId: 'golden_seed_002',
      note: '指标管理员复核通过',
    })
    expect(adminApproval.ok).toBe(true)
    const adminSchedule = service.scheduleRegressionRun({
      actor: metricAdmin,
      candidateVersion: 'planner-3.3-rc2',
    })
    expect(adminSchedule.ok).toBe(false)
    if (!adminSchedule.ok) expect(adminSchedule.error).toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('requires and sanitizes approval notes before writing audit events', () => {
    const service = createEvaluationApplicationService({ seedGoldenSamples: true })
    const missing = service.approveGoldenSample({
      actor: opsActor,
      sampleId: 'golden_seed_002',
      note: '   ',
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatchObject({ code: 'VALIDATION_FAILED' })

    const approved = service.approveGoldenSample({
      actor: opsActor,
      sampleId: 'golden_seed_002',
      note: '联系 13800138000 analyst@example.com token=plain-secret 后复核通过',
    })
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    const serializedAudit = JSON.stringify(approved.data.audit)
    expect(serializedAudit).not.toContain('13800138000')
    expect(serializedAudit).not.toContain('analyst@example.com')
    expect(serializedAudit).not.toContain('plain-secret')
    expect(serializedAudit).toContain('[手机号已脱敏]')
    expect(serializedAudit).toContain('[邮箱已脱敏]')
    expect(serializedAudit).toContain('[敏感值已脱敏]')
  })

  it('rejects partial regression scopes and de-duplicates approved sample ids', () => {
    const service = createEvaluationApplicationService({ seedGoldenSamples: true })
    const partial = service.scheduleRegressionRun({
      actor: opsActor,
      candidateVersion: 'planner-3.3-rc2',
      sampleIds: ['golden_seed_001', 'golden_seed_002'],
    })
    expect(partial.ok).toBe(false)
    if (!partial.ok) expect(partial.error).toMatchObject({ code: 'VALIDATION_FAILED' })
    const afterRejected = service.listRegressionRuns({ actor: opsActor })
    expect(afterRejected.ok && afterRejected.data.total).toBe(0)

    const deduplicated = service.scheduleRegressionRun({
      actor: opsActor,
      candidateVersion: 'planner-3.3-rc2',
      sampleIds: ['golden_seed_001', 'golden_seed_001'],
    })
    expect(deduplicated.ok).toBe(true)
    if (!deduplicated.ok) return
    expect(deduplicated.data).toMatchObject({
      sampleIds: ['golden_seed_001'],
      sampleCount: 1,
    })
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
      completedStages: [],
    })

    const listed = service.listRegressionRuns({
      actor: opsActor,
      status: 'queued',
      candidateVersion: 'planner-3.3-rc2',
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: regression.data.id, requestedBy: 'user_ops' })],
    })
    const detail = service.getRegressionRun({
      actor: opsActor,
      regressionRunId: regression.data.id,
    })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.data).toMatchObject({
      id: regression.data.id,
      status: 'queued',
      sampleCount: 1,
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

    const missingApprovalNote = router.handle({
      method: 'POST',
      path: `/v1/evaluation/golden-samples/${sampleId}/approve`,
      headers: opsHeaders,
      body: { note: '' },
    })
    expect(missingApprovalNote.status).toBe(400)

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

    const samples = router.handle({
      method: 'GET',
      path: '/v1/evaluation/golden-samples',
      headers: opsHeaders,
      query: { status: 'golden_approved', q: sampleId },
    })
    expect(samples.status).toBe(200)
    expect(samples.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [expect.objectContaining({ id: sampleId })],
      },
    })
    const sampleDetail = router.handle({
      method: 'GET',
      path: `/v1/evaluation/golden-samples/${sampleId}`,
      headers: opsHeaders,
    })
    expect(sampleDetail.status).toBe(200)
    expect(sampleDetail.body).toMatchObject({ ok: true, data: { id: sampleId, status: 'golden_approved' } })
    const invalidSampleStatus = router.handle({
      method: 'GET',
      path: '/v1/evaluation/golden-samples',
      headers: opsHeaders,
      query: { status: 'not-a-status' },
    })
    expect(invalidSampleStatus.status).toBe(400)

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
    const regressionId = (regression.body as { data: { id: string } }).data.id
    const regressionList = router.handle({
      method: 'GET',
      path: '/v1/evaluation/regression-runs',
      headers: opsHeaders,
      query: { status: 'queued', candidate_version: 'planner-3.3-rc2' },
    })
    expect(regressionList.status).toBe(200)
    expect(regressionList.body).toMatchObject({
      ok: true,
      data: { total: 1, items: [expect.objectContaining({ id: regressionId })] },
    })
    const regressionDetail = router.handle({
      method: 'GET',
      path: `/v1/evaluation/regression-runs/${regressionId}`,
      headers: opsHeaders,
    })
    expect(regressionDetail.status).toBe(200)
    expect(regressionDetail.body).toMatchObject({
      ok: true,
      data: {
        id: regressionId,
        status: 'queued',
        completedStages: [],
      },
    })

    const invalidRegressionStatus = router.handle({
      method: 'GET',
      path: '/v1/evaluation/regression-runs',
      headers: opsHeaders,
      query: { status: 'not-a-status' },
    })
    expect(invalidRegressionStatus.status).toBe(400)

    const invalidIntent = router.handle({
      method: 'POST',
      path: '/v1/evaluation/golden-samples',
      headers: opsHeaders,
      body: {
        source_run_id: 'RUN-INVALID',
        sanitized_question: '无效意图样本',
        domain: 'sales',
        expected_intent: 'unsupported',
        expected_metric_ids: [],
        expected_dimension_ids: [],
        semantic_version: opsActor.semanticVersion,
        tags: [],
        desensitized: true,
        deduplicated: true,
        human_labeled: true,
      },
    })
    expect(invalidIntent.status).toBe(400)
  })
})
