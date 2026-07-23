import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import type {
  GetImmutableResultBlobInput,
  ImmutableResultBlob,
  ImmutableResultBlobStore,
  PutImmutableResultBlobInput,
  PutImmutableResultBlobResult,
  ResultBlobDescriptor,
  ResultBlobOperationBoundary,
} from '../../../../src/persistence/resultBlobPorts'
import {
  buildImmutableResultBlobKey,
  resultBlobChecksumHex,
  validateResultBlobDescriptor,
} from '../../../../src/persistence/resultBlobPorts'

const immutableCacheControl = 'private, max-age=31536000, immutable' as const
const defaultTimeoutMs = 15_000
const maximumTimeoutMs = 120_000
const defaultMaximumBlobBytes = 64 * 1024 * 1024
const maximumBlobBytesLimit = 1024 * 1024 * 1024

export type S3ResultBlobErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'REMOTE_UNAVAILABLE'
  | 'REMOTE_REJECTED'
  | 'REMOTE_PROTOCOL_ERROR'
  | 'INTEGRITY_MISMATCH'

/** Public-safe error. It never includes object-store URLs, credentials, or response bodies. */
export class S3ResultBlobError extends Error {
  readonly code: S3ResultBlobErrorCode

  constructor(code: S3ResultBlobErrorCode) {
    super(errorMessage(code))
    this.name = 'S3ResultBlobError'
    this.code = code
  }
}

export interface S3ResultBlobCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type S3ResultBlobCredentialResolver = (
  credentialRef: string,
) => S3ResultBlobCredentials | Promise<S3ResultBlobCredentials>

export type S3ResultBlobFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface S3ResultBlobStoreOptions {
  endpoint: string
  region: string
  bucket: string
  credentialRef: string
  resolveCredentials: S3ResultBlobCredentialResolver
  fetch?: S3ResultBlobFetch
  now?: () => Date
  defaultTimeoutMs?: number
  maxBlobBytes?: number
}

interface ValidatedOptions {
  endpoint: URL
  region: string
  bucket: string
  credentialRef: string
  resolveCredentials: S3ResultBlobCredentialResolver
  fetch: S3ResultBlobFetch
  now: () => Date
  defaultTimeoutMs: number
  maxBlobBytes: number
}

interface SignedRequestInput {
  method: 'PUT' | 'HEAD' | 'GET'
  key: string
  body?: Uint8Array
  descriptor: ResultBlobDescriptor
  signal: AbortSignal
  credentials: S3ResultBlobCredentials
}

/** Node-only S3-compatible immutable result blob adapter. */
export function createS3ResultBlobStore(
  input: S3ResultBlobStoreOptions,
): ImmutableResultBlobStore {
  const options = validateOptions(input)

  return {
    async put(value) {
      let descriptor: ResultBlobDescriptor
      let body: Uint8Array
      try {
        descriptor = validateDescriptor(value, options.maxBlobBytes)
        if (!(value.body instanceof Uint8Array) || value.body.byteLength > options.maxBlobBytes) {
          throw new Error('invalid body')
        }
        body = Uint8Array.from(value.body)
      } catch {
        throw new S3ResultBlobError('INVALID_INPUT')
      }
      verifyBody(descriptor, body)
      const key = buildImmutableResultBlobKey(descriptor)

      return await runBounded(value, options.defaultTimeoutMs, async (signal) => {
        const credentials = await resolveCredentials(options)
        const response = await sendSignedRequest(options, {
          method: 'PUT',
          key,
          body,
          descriptor,
          signal,
          credentials,
        })

        if (response.status >= 200 && response.status < 300) {
          discardResponse(response)
          const blob = await verifiedHead(options, descriptor, key, signal, credentials)
          if (!blob) throw new S3ResultBlobError('REMOTE_PROTOCOL_ERROR')
          return { ok: true, applied: true, blob } satisfies PutImmutableResultBlobResult
        }

        if (response.status === 409 || response.status === 412) {
          discardResponse(response)
          const blob = await verifiedHead(options, descriptor, key, signal, credentials, true)
          if (blob) return { ok: true, applied: false, blob } satisfies PutImmutableResultBlobResult
          return { ok: false, reason: 'content_conflict' } satisfies PutImmutableResultBlobResult
        }

        discardResponse(response)
        throw remoteStatusError(response.status)
      })
    },

    async stat(value) {
      const descriptor = safeDescriptor(value, options.maxBlobBytes)
      const key = buildImmutableResultBlobKey(descriptor)
      return await runBounded(value, options.defaultTimeoutMs, async (signal) => {
        const credentials = await resolveCredentials(options)
        return await verifiedHead(options, descriptor, key, signal, credentials)
      })
    },

    async get(value) {
      const descriptor = safeDescriptor(value, options.maxBlobBytes)
      const key = buildImmutableResultBlobKey(descriptor)
      return await runBounded(value, options.defaultTimeoutMs, async (signal) => {
        const credentials = await resolveCredentials(options)
        const response = await sendSignedRequest(options, {
          method: 'GET',
          key,
          descriptor,
          signal,
          credentials,
        })
        if (response.status === 404) {
          discardResponse(response)
          return undefined
        }
        if (response.status !== 200) {
          discardResponse(response)
          throw remoteStatusError(response.status)
        }

        const blob = parseVerifiedMetadata(response.headers, descriptor, key)
        const body = await readVerifiedBody(response, descriptor, options.maxBlobBytes, signal)
        return { blob, body }
      })
    },
  }
}

function validateOptions(input: S3ResultBlobStoreOptions): ValidatedOptions {
  try {
    const endpoint = new URL(input.endpoint)
    if (
      endpoint.protocol !== 'https:'
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || endpoint.pathname !== '/'
      || !endpoint.hostname
    ) {
      throw new Error('invalid endpoint')
    }
    if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/.test(input.bucket)
      || input.bucket.includes('..')
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(input.bucket)) {
      throw new Error('invalid bucket')
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.region)) throw new Error('invalid region')
    if (
      !/^env:CHATBI_[A-Z0-9_]+$/.test(input.credentialRef)
      && !/^vault:\/\/[A-Za-z0-9][A-Za-z0-9/_\-.]{0,254}$/.test(input.credentialRef)
    ) {
      throw new Error('invalid credential reference')
    }
    if (typeof input.resolveCredentials !== 'function') throw new Error('missing resolver')
    const timeoutMs = input.defaultTimeoutMs ?? defaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) {
      throw new Error('invalid timeout')
    }
    const maxBlobBytes = input.maxBlobBytes ?? defaultMaximumBlobBytes
    if (
      !Number.isSafeInteger(maxBlobBytes)
      || maxBlobBytes < 1
      || maxBlobBytes > maximumBlobBytesLimit
    ) {
      throw new Error('invalid blob limit')
    }
    const fetcher = input.fetch ?? globalThis.fetch
    if (typeof fetcher !== 'function') throw new Error('missing fetch')
    return {
      endpoint,
      region: input.region,
      bucket: input.bucket,
      credentialRef: input.credentialRef,
      resolveCredentials: input.resolveCredentials,
      fetch: fetcher,
      now: input.now ?? (() => new Date()),
      defaultTimeoutMs: timeoutMs,
      maxBlobBytes,
    }
  } catch {
    throw new S3ResultBlobError('INVALID_CONFIGURATION')
  }
}

function validateDescriptor(
  input: ResultBlobDescriptor,
  maxBlobBytes: number,
): ResultBlobDescriptor {
  validateResultBlobDescriptor(input)
  if (input.byteLength > maxBlobBytes) throw new Error('blob exceeds configured limit')
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    attempt: input.attempt,
    kind: input.kind,
    checksum: input.checksum,
    byteLength: input.byteLength,
    contentType: input.contentType,
  }
}

function safeDescriptor(
  input: GetImmutableResultBlobInput,
  maxBlobBytes: number,
): ResultBlobDescriptor {
  try {
    return validateDescriptor(input, maxBlobBytes)
  } catch {
    throw new S3ResultBlobError('INVALID_INPUT')
  }
}

function verifyBody(descriptor: ResultBlobDescriptor, body: Uint8Array) {
  if (body.byteLength !== descriptor.byteLength) {
    throw new S3ResultBlobError('INTEGRITY_MISMATCH')
  }
  const actual = createHash('sha256').update(body).digest()
  const expected = Buffer.from(resultBlobChecksumHex(descriptor.checksum), 'hex')
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new S3ResultBlobError('INTEGRITY_MISMATCH')
  }
}

async function resolveCredentials(options: ValidatedOptions): Promise<S3ResultBlobCredentials> {
  let resolved: S3ResultBlobCredentials
  try {
    resolved = await options.resolveCredentials(options.credentialRef)
  } catch {
    throw new S3ResultBlobError('CREDENTIAL_UNAVAILABLE')
  }
  if (
    !safeCredentialPart(resolved?.accessKeyId, 16, 256)
    || !safeCredentialPart(resolved?.secretAccessKey, 16, 4096)
    || (resolved.sessionToken !== undefined && !safeCredentialPart(resolved.sessionToken, 1, 16_384))
  ) {
    throw new S3ResultBlobError('CREDENTIAL_UNAVAILABLE')
  }
  return {
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    ...(resolved.sessionToken ? { sessionToken: resolved.sessionToken } : {}),
  }
}

function safeCredentialPart(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
}

async function verifiedHead(
  options: ValidatedOptions,
  descriptor: ResultBlobDescriptor,
  key: string,
  signal: AbortSignal,
  credentials: S3ResultBlobCredentials,
  tolerateIntegrityMismatch = false,
): Promise<ImmutableResultBlob | undefined> {
  const response = await sendSignedRequest(options, {
    method: 'HEAD',
    key,
    descriptor,
    signal,
    credentials,
  })
  if (response.status === 404) {
    discardResponse(response)
    return undefined
  }
  if (response.status !== 200) {
    discardResponse(response)
    throw remoteStatusError(response.status)
  }
  try {
    return parseVerifiedMetadata(response.headers, descriptor, key)
  } catch (error) {
    if (tolerateIntegrityMismatch && error instanceof S3ResultBlobError
      && error.code === 'INTEGRITY_MISMATCH') {
      return undefined
    }
    throw error
  } finally {
    discardResponse(response)
  }
}

function parseVerifiedMetadata(
  headers: Headers,
  descriptor: ResultBlobDescriptor,
  key: string,
): ImmutableResultBlob {
  const expectedHex = resultBlobChecksumHex(descriptor.checksum)
  const expectedBase64 = Buffer.from(expectedHex, 'hex').toString('base64')
  const etag = headers.get('etag')
  const contentLength = exactNonNegativeInteger(headers.get('content-length'))
  const metadataLength = exactNonNegativeInteger(headers.get('x-amz-meta-chatbi-byte-length'))
  if (
    contentLength !== descriptor.byteLength
    || metadataLength !== descriptor.byteLength
    || headers.get('content-type') !== descriptor.contentType
    || headers.get('cache-control') !== immutableCacheControl
    || headers.get('x-amz-meta-chatbi-sha256') !== expectedHex
    || headers.get('x-amz-meta-chatbi-content-type') !== descriptor.contentType
    || headers.get('x-amz-checksum-sha256') !== expectedBase64
    || !etag
    || !/^"[A-Za-z0-9._:+/=-]{1,160}"$/.test(etag)
  ) {
    throw new S3ResultBlobError('INTEGRITY_MISMATCH')
  }
  return {
    key,
    ...descriptor,
    etag,
    cacheControl: immutableCacheControl,
  }
}

async function readVerifiedBody(
  response: Response,
  descriptor: ResultBlobDescriptor,
  maxBlobBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    if (descriptor.byteLength === 0) return new Uint8Array()
    throw new S3ResultBlobError('INTEGRITY_MISMATCH')
  }
  const reader = response.body.getReader()
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancelRead, { once: true })
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const read = await reader.read()
      if (read.done) break
      byteLength += read.value.byteLength
      if (byteLength > descriptor.byteLength || byteLength > maxBlobBytes) {
        throw new S3ResultBlobError('INTEGRITY_MISMATCH')
      }
      chunks.push(read.value)
    }
  } finally {
    signal.removeEventListener('abort', cancelRead)
    reader.releaseLock()
  }
  if (byteLength !== descriptor.byteLength) throw new S3ResultBlobError('INTEGRITY_MISMATCH')
  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  verifyBody(descriptor, body)
  return body
}

async function sendSignedRequest(
  options: ValidatedOptions,
  input: SignedRequestInput,
): Promise<Response> {
  const date = options.now()
  if (!Number.isFinite(date.getTime())) throw new S3ResultBlobError('INVALID_CONFIGURATION')
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = amzDate.slice(0, 8)
  const payloadHash = input.body
    ? createHash('sha256').update(input.body).digest('hex')
    : createHash('sha256').update('').digest('hex')
  const url = objectUrl(options, input.key)
  const headers = new Headers()
  headers.set('host', url.host)
  headers.set('x-amz-content-sha256', payloadHash)
  headers.set('x-amz-date', amzDate)
  if (input.credentials.sessionToken) {
    headers.set('x-amz-security-token', input.credentials.sessionToken)
  }
  if (input.method === 'PUT') {
    const checksumHex = resultBlobChecksumHex(input.descriptor.checksum)
    headers.set('cache-control', immutableCacheControl)
    headers.set('content-length', String(input.descriptor.byteLength))
    headers.set('content-type', input.descriptor.contentType)
    headers.set('if-none-match', '*')
    headers.set('x-amz-checksum-sha256', Buffer.from(checksumHex, 'hex').toString('base64'))
    headers.set('x-amz-meta-chatbi-byte-length', String(input.descriptor.byteLength))
    headers.set('x-amz-meta-chatbi-content-type', input.descriptor.contentType)
    headers.set('x-amz-meta-chatbi-sha256', checksumHex)
  } else {
    headers.set('x-amz-checksum-mode', 'ENABLED')
  }

  const signedHeaderNames = [...headers.keys()].sort()
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${normalizeHeaderValue(headers.get(name) ?? '')}\n`)
    .join('')
  const canonicalRequest = [
    input.method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${shortDate}/${options.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${input.credentials.secretAccessKey}`, shortDate),
        options.region,
      ),
      's3',
    ),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`,
  )

  try {
    return await options.fetch(url, {
      method: input.method,
      headers,
      ...(input.body ? { body: Buffer.from(input.body) } : {}),
      redirect: 'error',
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal.aborted) throw error
    throw new S3ResultBlobError('REMOTE_UNAVAILABLE')
  }
}

function objectUrl(options: ValidatedOptions, key: string) {
  const url = new URL(options.endpoint)
  url.pathname = `/${encodeURIComponent(options.bucket)}/${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`
  return url
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function normalizeHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

async function runBounded<T>(
  boundary: ResultBlobOperationBoundary,
  fallbackTimeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = boundary.timeoutMs ?? fallbackTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) {
    throw new S3ResultBlobError('INVALID_INPUT')
  }
  if (boundary.signal?.aborted) throw new S3ResultBlobError('ABORTED')

  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort()
  boundary.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new S3ResultBlobError(timedOut ? 'TIMEOUT' : 'ABORTED'))
        }, { once: true })
      }),
    ])
  } catch (error) {
    if (controller.signal.aborted) {
      throw new S3ResultBlobError(timedOut ? 'TIMEOUT' : 'ABORTED')
    }
    if (error instanceof S3ResultBlobError) throw error
    throw new S3ResultBlobError('REMOTE_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
    boundary.signal?.removeEventListener('abort', onCallerAbort)
  }
}

function exactNonNegativeInteger(value: string | null): number | undefined {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function discardResponse(response: Response) {
  void response.body?.cancel().catch(() => undefined)
}

function remoteStatusError(status: number) {
  return new S3ResultBlobError(status === 429 || status >= 500
    ? 'REMOTE_UNAVAILABLE'
    : 'REMOTE_REJECTED')
}

function errorMessage(code: S3ResultBlobErrorCode) {
  switch (code) {
    case 'INVALID_CONFIGURATION': return 'Result blob storage configuration is invalid.'
    case 'INVALID_INPUT': return 'Result blob request is invalid.'
    case 'CREDENTIAL_UNAVAILABLE': return 'Result blob storage credentials are unavailable.'
    case 'ABORTED': return 'Result blob operation was aborted.'
    case 'TIMEOUT': return 'Result blob operation timed out.'
    case 'REMOTE_UNAVAILABLE': return 'Result blob storage is unavailable.'
    case 'REMOTE_REJECTED': return 'Result blob storage rejected the operation.'
    case 'REMOTE_PROTOCOL_ERROR': return 'Result blob storage returned an invalid response.'
    case 'INTEGRITY_MISMATCH': return 'Result blob integrity verification failed.'
  }
}
