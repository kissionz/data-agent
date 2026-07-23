import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { bindNodeDisconnect } from '../api/nodeServer'

describe('Node request disconnect boundary', () => {
  it('aborts durable waits and removes request/response listeners', () => {
    const request = new EventEmitter() as unknown as IncomingMessage
    const response = new EventEmitter() as unknown as ServerResponse
    const binding = bindNodeDisconnect(request, response)

    expect(binding.signal.aborted).toBe(false)
    expect(request.listenerCount('aborted')).toBe(1)
    expect(response.listenerCount('close')).toBe(1)

    response.emit('close')
    expect(binding.signal.aborted).toBe(true)
    binding.dispose()
    expect(request.listenerCount('aborted')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  })

  it('also treats an aborted incoming request as a disconnect', () => {
    const request = new EventEmitter() as unknown as IncomingMessage
    const response = new EventEmitter() as unknown as ServerResponse
    const binding = bindNodeDisconnect(request, response)

    request.emit('aborted')

    expect(binding.signal.aborted).toBe(true)
    binding.dispose()
  })
})
