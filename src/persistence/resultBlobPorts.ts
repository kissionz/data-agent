import type { MaybePromise } from './jobPorts'

export type ResultBlobKind = 'page' | 'manifest' | 'export'

export interface ResultBlobScope {
  tenantId: string
  workspaceId: string
  runId: string
  attempt: number
}

/**
 * A trusted content-addressed descriptor persisted beside the control-plane
 * manifest. Reads verify every field instead of trusting object-store headers.
 */
export interface ResultBlobDescriptor extends ResultBlobScope {
  kind: ResultBlobKind
  checksum: `sha256:${string}`
  byteLength: number
  contentType: string
}

export interface ResultBlobOperationBoundary {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface PutImmutableResultBlobInput extends ResultBlobDescriptor, ResultBlobOperationBoundary {
  body: Uint8Array
}

export interface GetImmutableResultBlobInput extends ResultBlobDescriptor, ResultBlobOperationBoundary {}

/** Public-safe metadata. Endpoint, bucket, credentials and response bodies are absent. */
export interface ImmutableResultBlob {
  key: string
  tenantId: string
  workspaceId: string
  runId: string
  attempt: number
  kind: ResultBlobKind
  checksum: `sha256:${string}`
  byteLength: number
  contentType: string
  etag: string
  cacheControl: 'private, max-age=31536000, immutable'
}

export type PutImmutableResultBlobResult =
  | { ok: true; applied: boolean; blob: ImmutableResultBlob }
  | { ok: false; reason: 'content_conflict'; blob?: ImmutableResultBlob }

export interface ReadImmutableResultBlob {
  blob: ImmutableResultBlob
  body: Uint8Array
}

/**
 * Immutable raw-result storage. The key is always derived from scope, kind and
 * SHA-256; callers cannot provide arbitrary object-store paths.
 */
export interface ImmutableResultBlobStore {
  put(input: PutImmutableResultBlobInput): MaybePromise<PutImmutableResultBlobResult>
  stat(input: GetImmutableResultBlobInput): MaybePromise<ImmutableResultBlob | undefined>
  get(input: GetImmutableResultBlobInput): MaybePromise<ReadImmutableResultBlob | undefined>
}

const checksumPattern = /^sha256:([0-9a-f]{64})$/
const contentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+\-"]+)*$/i

export function validateResultBlobDescriptor(input: ResultBlobDescriptor): void {
  validateScopePart(input.tenantId, 'tenantId')
  validateScopePart(input.workspaceId, 'workspaceId')
  validateScopePart(input.runId, 'runId')
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('attempt must be a positive safe integer')
  }
  if (!['page', 'manifest', 'export'].includes(input.kind)) {
    throw new Error('kind is invalid')
  }
  if (!checksumPattern.test(input.checksum)) {
    throw new Error('checksum must be a lowercase SHA-256 digest')
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new Error('byteLength must be a non-negative safe integer')
  }
  if (
    typeof input.contentType !== 'string'
    || input.contentType.length > 160
    || input.contentType !== input.contentType.toLowerCase()
    || !contentTypePattern.test(input.contentType)
    || /[\r\n]/.test(input.contentType)
  ) {
    throw new Error('contentType is invalid')
  }
}

export function resultBlobChecksumHex(checksum: string): string {
  const match = checksumPattern.exec(checksum)
  if (!match) throw new Error('checksum must be a lowercase SHA-256 digest')
  return match[1]
}

export function buildImmutableResultBlobKey(input: ResultBlobDescriptor): string {
  validateResultBlobDescriptor(input)
  return [
    'chatbi',
    'result-blobs',
    'v1',
    't',
    base64UrlUtf8(input.tenantId),
    'w',
    base64UrlUtf8(input.workspaceId),
    'r',
    base64UrlUtf8(input.runId),
    'a',
    String(input.attempt),
    'k',
    input.kind,
    'sha256',
    resultBlobChecksumHex(input.checksum),
  ].join('/')
}

function validateScopePart(value: string, label: string) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  if (new TextEncoder().encode(value).byteLength > 128) {
    throw new Error(`${label} exceeds 128 UTF-8 bytes`)
  }
}

function base64UrlUtf8(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = new TextEncoder().encode(value)
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    encoded += alphabet[(block >>> 18) & 63]
    encoded += alphabet[(block >>> 12) & 63]
    if (second !== undefined) encoded += alphabet[(block >>> 6) & 63]
    if (third !== undefined) encoded += alphabet[block & 63]
  }
  return encoded
}
