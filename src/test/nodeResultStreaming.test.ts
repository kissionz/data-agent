import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  writeNodeBffResponse,
  writeNodeInternalErrorResponse,
  writeNodeStreamingBody,
} from '../api/nodeServer'

class BackpressureResponse extends EventEmitter {
  destroyed = false
  headersSent = false
  ended = false
  readonly writes: Array<string | Uint8Array> = []
  readonly statuses: number[] = []

  constructor(private blockNextWrite = true) {
    super()
  }

  writeHead(status: number) {
    this.headersSent = true
    this.statuses.push(status)
    return this
  }

  write(chunk: string | Uint8Array) {
    this.writes.push(chunk)
    if (!this.blockNextWrite) return true
    this.blockNextWrite = false
    return false
  }

  end() {
    this.ended = true
    return this
  }

  destroy() {
    this.destroyed = true
    return this
  }
}

function responseLike(response: BackpressureResponse) {
  return response as unknown as Pick<
    ServerResponse,
    'write' | 'end' | 'once' | 'removeListener' | 'destroyed'
  >
}

describe('Node result streaming transport', () => {
  it('does not pull the next NDJSON chunk until the response drains', async () => {
    const response = new BackpressureResponse()
    let pulls = 0
    async function* body() {
      pulls += 1
      yield '{"type":"row","index":0}\n'
      pulls += 1
      yield '{"type":"row","index":1}\n'
    }

    const writing = writeNodeStreamingBody(responseLike(response), body())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(response.writes).toEqual(['{"type":"row","index":0}\n'])
    expect(pulls).toBe(1)
    expect(response.ended).toBe(false)

    response.emit('drain')
    await writing
    expect(response.writes).toEqual([
      '{"type":"row","index":0}\n',
      '{"type":"row","index":1}\n',
    ])
    expect(pulls).toBe(2)
    expect(response.ended).toBe(true)
  })

  it('stops iteration and runs generator cleanup when the client disconnects under backpressure', async () => {
    const response = new BackpressureResponse()
    const controller = new AbortController()
    let cleaned = false
    async function* body() {
      try {
        yield '{"type":"row","index":0}\n'
        yield '{"type":"row","index":1}\n'
      } finally {
        cleaned = true
      }
    }

    const writing = writeNodeStreamingBody(responseLike(response), body(), controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await writing

    expect(cleaned).toBe(true)
    expect(response.writes).toEqual(['{"type":"row","index":0}\n'])
    expect(response.ended).toBe(false)
    expect(response.listenerCount('drain')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  })

  it('never attempts a JSON 500 after the first streamed byte has been sent', async () => {
    const response = new BackpressureResponse(false)
    try {
      await writeNodeBffResponse(response as unknown as ServerResponse, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        body: (async function* () {
          yield '{"type":"manifest"}\n'
          throw new Error('postgresql://admin:secret@private-db/result_pages')
        })(),
      })
    } catch {
      writeNodeInternalErrorResponse(response as unknown as ServerResponse)
    }
    expect(response.statuses).toEqual([200])
    expect(response.writes).toEqual(['{"type":"manifest"}\n'])
    expect(response.destroyed).toBe(true)
    expect(response.ended).toBe(false)
    expect(JSON.stringify(response.writes)).not.toMatch(/req_node_adapter|INTERNAL_ERROR|postgresql|secret|private-db/)
  })
})
