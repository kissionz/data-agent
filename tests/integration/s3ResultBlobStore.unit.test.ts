import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createS3ResultBlobStore,
  S3ResultBlobError,
  type S3ResultBlobFetch,
} from '../../apps/api/src/adapters/s3ResultBlobStore'
import {
  buildImmutableResultBlobKey,
  type GetImmutableResultBlobInput,
  type PutImmutableResultBlobInput,
} from '../../src/persistence/resultBlobPorts'

const body = new TextEncoder().encode('immutable result page')
const checksumHex = createHash('sha256').update(body).digest('hex')
const checksum = `sha256:${checksumHex}` as const
const checksumBase64 = Buffer.from(checksumHex, 'hex').toString('base64')
const etag = '"0123456789abcdef"'
const fixedNow = new Date('2026-07-23T08:09:10.000Z')

function descriptor(
  overrides: Partial<GetImmutableResultBlobInput> = {},
): GetImmutableResultBlobInput {
  return {
    tenantId: 'tenant/acme',
    workspaceId: 'workspace production',
    runId: 'run:2026-07-23',
    attempt: 2,
    kind: 'page',
    checksum,
    byteLength: body.byteLength,
    contentType: 'application/json',
    ...overrides,
  }
}

function putInput(
  overrides: Partial<PutImmutableResultBlobInput> = {},
): PutImmutableResultBlobInput {
  return {
    ...descriptor(),
    body,
    ...overrides,
  }
}

function verifiedHeaders(
  overrides: Record<string, string> = {},
): Headers {
  return new Headers({
    'cache-control': 'private, max-age=31536000, immutable',
    'content-length': String(body.byteLength),
    'content-type': 'application/json',
    etag,
    'x-amz-checksum-sha256': checksumBase64,
    'x-amz-meta-chatbi-byte-length': String(body.byteLength),
    'x-amz-meta-chatbi-content-type': 'application/json',
    'x-amz-meta-chatbi-sha256': checksumHex,
    ...overrides,
  })
}

function options(fetcher: S3ResultBlobFetch, overrides: Record<string, unknown> = {}) {
  return {
    endpoint: 'https://objects.example.test',
    region: 'us-east-1',
    bucket: 'chatbi-results-prod',
    credentialRef: 'env:CHATBI_RESULT_BLOB_CREDENTIAL',
    resolveCredentials: vi.fn(async () => ({
      accessKeyId: 'AKIAEXAMPLEACCESSKEY',
      secretAccessKey: 'example-secret-access-key-with-safe-length',
      sessionToken: 'temporary-session-token',
    })),
    fetch: fetcher,
    now: () => fixedNow,
    ...overrides,
  }
}

function queueFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher: S3ResultBlobFetch = vi.fn(async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const response = responses.shift()
    if (!response) throw new Error('unexpected fake request')
    return response
  })
  return { fetcher, calls }
}

describe('S3 immutable result blob store', () => {
  it('uses a scoped content-addressed key and signed create-only PUT', async () => {
    const fake = queueFetch(
      new Response(null, { status: 200 }),
      new Response(null, { status: 200, headers: verifiedHeaders() }),
    )
    const store = createS3ResultBlobStore(options(fake.fetcher))

    const result = await store.put(putInput())

    expect(result).toEqual({
      ok: true,
      applied: true,
      blob: {
        ...descriptor(),
        key: buildImmutableResultBlobKey(descriptor()),
        etag,
        cacheControl: 'private, max-age=31536000, immutable',
      },
    })
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.map((call) => call.init.method)).toEqual(['PUT', 'HEAD'])
    expect(fake.calls[0].url).not.toContain('tenant/acme')
    expect(fake.calls[0].url).not.toContain('workspace production')
    expect(fake.calls[0].url).not.toContain('run:2026')
    expect(fake.calls[0].url).toContain(`/sha256/${checksumHex}`)

    const headers = new Headers(fake.calls[0].init.headers)
    expect(headers.get('if-none-match')).toBe('*')
    expect(headers.get('x-amz-checksum-sha256')).toBe(checksumBase64)
    expect(headers.get('x-amz-meta-chatbi-sha256')).toBe(checksumHex)
    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEACCESSKEY\/20260723\/us-east-1\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    )
    expect(headers.get('authorization')).not.toContain('example-secret-access-key')
    expect(fake.calls[0].init.redirect).toBe('error')
  })

  it('rejects a byte length or SHA-256 mismatch before credentials and HTTP', async () => {
    const fetcher = vi.fn<S3ResultBlobFetch>()
    const configuration = options(fetcher)
    const store = createS3ResultBlobStore(configuration)

    await expect(store.put(putInput({ byteLength: body.byteLength + 1 })))
      .rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    await expect(store.put(putInput({ checksum: `sha256:${'0'.repeat(64)}` })))
      .rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    await expect(store.put(putInput({ body: 'not-bytes' as unknown as Uint8Array })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(configuration.resolveCredentials).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('treats a conditional-write collision with identical metadata as idempotent', async () => {
    const fake = queueFetch(
      new Response(null, { status: 412 }),
      new Response(null, { status: 200, headers: verifiedHeaders() }),
    )
    const store = createS3ResultBlobStore(options(fake.fetcher))

    await expect(store.put(putInput())).resolves.toMatchObject({
      ok: true,
      applied: false,
      blob: { checksum, byteLength: body.byteLength, etag },
    })
  })

  it('reports a safe content conflict when an existing object has different metadata', async () => {
    const fake = queueFetch(
      new Response(null, { status: 409 }),
      new Response(null, {
        status: 200,
        headers: verifiedHeaders({ 'x-amz-meta-chatbi-sha256': '0'.repeat(64) }),
      }),
    )
    const store = createS3ResultBlobStore(options(fake.fetcher))

    await expect(store.put(putInput())).resolves.toEqual({
      ok: false,
      reason: 'content_conflict',
    })
  })

  it('returns verified metadata from stat and undefined for missing objects', async () => {
    const fake = queueFetch(
      new Response(null, { status: 200, headers: verifiedHeaders() }),
      new Response(null, { status: 404 }),
    )
    const store = createS3ResultBlobStore(options(fake.fetcher))

    await expect(store.stat(descriptor())).resolves.toMatchObject({
      key: buildImmutableResultBlobKey(descriptor()),
      checksum,
      byteLength: body.byteLength,
      etag,
    })
    await expect(store.stat(descriptor())).resolves.toBeUndefined()
  })

  it('streams and verifies a GET body against trusted length and SHA-256', async () => {
    const fake = queueFetch(
      new Response(body, { status: 200, headers: verifiedHeaders() }),
    )
    const store = createS3ResultBlobStore(options(fake.fetcher))

    const result = await store.get(descriptor())

    expect(result?.body).toEqual(body)
    expect(result?.blob).toMatchObject({ checksum, byteLength: body.byteLength, etag })
    expect(new Headers(fake.calls[0].init.headers).get('x-amz-checksum-mode')).toBe('ENABLED')
  })

  it('rejects corrupt metadata, truncated bodies, and digest mismatches', async () => {
    const truncated = body.slice(0, -1)
    const corrupted = Uint8Array.from(body)
    corrupted[0] ^= 1
    const fake = queueFetch(
      new Response(body, {
        status: 200,
        headers: verifiedHeaders({ 'cache-control': 'public' }),
      }),
      new Response(truncated, { status: 200, headers: verifiedHeaders() }),
      new Response(corrupted, { status: 200, headers: verifiedHeaders() }),
    )
    const store = createS3ResultBlobStore(options(fake.fetcher))

    await expect(store.get(descriptor())).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    await expect(store.get(descriptor())).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
    await expect(store.get(descriptor())).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
  })

  it('enforces an abortable hard timeout even when HTTP ignores the signal', async () => {
    const neverFetch: S3ResultBlobFetch = vi.fn(async () =>
      await new Promise<Response>(() => undefined))
    const store = createS3ResultBlobStore(options(neverFetch, { defaultTimeoutMs: 10 }))

    await expect(store.stat(descriptor())).rejects.toMatchObject({ code: 'TIMEOUT' })

    const caller = new AbortController()
    const operation = store.stat({ ...descriptor(), signal: caller.signal, timeoutMs: 5_000 })
    caller.abort()
    await expect(operation).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('rejects unsafe endpoints, bucket names, raw credentials, and unbounded settings', () => {
    const fetcher = vi.fn<S3ResultBlobFetch>()
    const invalid = [
      { endpoint: 'http://objects.example.test' },
      { endpoint: 'https://user:secret@objects.example.test' },
      { endpoint: 'https://objects.example.test/base/' },
      { endpoint: 'https://objects.example.test/?token=secret' },
      { bucket: 'Invalid_Bucket' },
      { credentialRef: 'secret-access-key-value' },
      { credentialRef: 'postgres://user:secret@host/db' },
      { defaultTimeoutMs: 0 },
      { maxBlobBytes: 2 * 1024 * 1024 * 1024 },
    ]

    for (const override of invalid) {
      expect(() => createS3ResultBlobStore(options(fetcher, override)))
        .toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    }
  })

  it('never exposes credential resolver errors or remote response bodies', async () => {
    const secret = 'DO_NOT_EXPOSE_THIS_SECRET'
    const resolverStore = createS3ResultBlobStore(options(vi.fn(), {
      resolveCredentials: vi.fn(async () => {
        throw new Error(`vault failure: ${secret}`)
      }),
    }))
    const resolverError = await resolverStore.stat(descriptor()).catch((error: unknown) => error)
    expect(resolverError).toBeInstanceOf(S3ResultBlobError)
    expect(String(resolverError)).not.toContain(secret)
    expect(resolverError).toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })

    const fake = queueFetch(new Response(`upstream leaked ${secret}`, { status: 403 }))
    const store = createS3ResultBlobStore(options(fake.fetcher))
    const remoteError = await store.stat(descriptor()).catch((error: unknown) => error)
    expect(remoteError).toBeInstanceOf(S3ResultBlobError)
    expect(String(remoteError)).not.toContain(secret)
    expect(remoteError).toMatchObject({ code: 'REMOTE_REJECTED' })
  })
})
