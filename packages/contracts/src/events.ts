import type { AuditEvent, PublicRunView } from './api'

export type RunSseEventName =
  | AuditEvent['type']
  | 'run.snapshot'
  | 'run.clarification_required'
  | 'run.result_ready'
  | 'run.failed'

export interface RunSseEvent<T = unknown> {
  id: string
  event: RunSseEventName
  data: T
  retry?: number
}

export function runViewToSseEvents(view: PublicRunView): RunSseEvent[] {
  const auditEvents: RunSseEvent[] = view.audit.map((event) => ({
    id: event.id,
    event: event.type,
    data: {
      at: event.at,
      runId: event.runId,
      summary: event.summary,
      traceId: view.traceId,
    },
  }))

  const snapshot: RunSseEvent = {
    id: `${view.runId}:v${view.version}`,
    event: 'run.snapshot',
    retry: 3000,
    data: {
      runId: view.runId,
      conversationId: view.conversationId,
      displayStatus: view.displayStatus,
      version: view.version,
      executedQuery: view.executedQuery,
      semanticVersion: view.semanticVersion,
      updatedAt: view.updatedAt,
    },
  }

  const terminal: RunSseEvent[] = []
  if (view.clarification) {
    terminal.push({
      id: `${view.runId}:clarification:${view.version}`,
      event: 'run.clarification_required',
      data: {
        prompt: view.clarification.prompt,
        irRevision: view.clarification.irRevision,
        expiresAt: view.clarification.expiresAt,
        candidates: view.clarification.candidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          description: candidate.description,
          candidateVersion: candidate.candidateVersion,
        })),
      },
    })
  }
  if (view.result) {
    terminal.push({
      id: `${view.runId}:result:${view.version}`,
      event: 'run.result_ready',
      data: {
        resultId: view.result.id,
        completeness: view.result.completeness,
        warnings: view.result.warnings,
        freshnessAt: view.result.freshnessAt,
      },
    })
  }
  if (view.error) {
    terminal.push({
      id: `${view.runId}:error:${view.version}`,
      event: 'run.failed',
      data: {
        code: view.error.code,
        message: view.error.message,
        retryable: view.error.retryable,
        debugReference: view.error.debugReference,
      },
    })
  }

  return [...auditEvents, snapshot, ...terminal]
}

export function filterSseEventsAfter(events: RunSseEvent[], lastEventId?: string): RunSseEvent[] {
  if (!lastEventId) return events
  const index = events.findIndex((event) => event.id === lastEventId)
  return index === -1 ? events : events.slice(index + 1)
}

export function serializeSseEvents(events: RunSseEvent[]): string {
  return events.map((event) => {
    const lines = [
      `id: ${event.id}`,
      `event: ${event.event}`,
      ...(event.retry ? [`retry: ${event.retry}`] : []),
      ...JSON.stringify(event.data).split('\n').map((line) => `data: ${line}`),
      '',
    ]
    return lines.join('\n')
  }).join('\n')
}
