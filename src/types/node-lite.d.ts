declare module 'node:http' {
  export interface IncomingMessage {
    method?: string
    url?: string
    headers: Record<string, string | string[] | undefined>
    on(event: 'data', listener: (chunk: Uint8Array) => void): void
    on(event: 'end', listener: () => void): void
    on(event: 'error', listener: (error: Error) => void): void
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): void
    end(data?: string): void
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): void
    close(callback?: () => void): void
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server
}

declare module 'node:url' {
  export class URL {
    constructor(input: string, base?: string)
    pathname: string
    searchParams: {
      entries(): IterableIterator<[string, string]>
    }
  }
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function renameSync(oldPath: string, newPath: string): void
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
}

declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
}
