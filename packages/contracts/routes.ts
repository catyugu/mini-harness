import type {} from 'cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';

const errorStatus = {
  invalid_input: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  conflict: 409, payload_too_large: 413, unavailable: 503
} as const;

/** Use for failures with a short message that is safe to send to the requesting client. */
export class HttpError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errorStatus, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = errorStatus[code];
  }
}

/** HTTP-specific transport contracts. Capability handlers never import the server. */
export class HttpReply {
  constructor(readonly status: number, readonly body: unknown,
    readonly headers: Record<string, string> = {}) {}
}

export interface RouteRequest {
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly signal: AbortSignal;
  body(max?: number): Promise<any>;
}
export type RouteHandler = (request: RouteRequest) => unknown | Promise<unknown>;

export interface RoutePort {
  register(method: string, path: string, handler: RouteHandler): () => Promise<void>;
  dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> | undefined;
}
export interface MutationPort {
  readonly changing: boolean;
  run<T>(operation: () => Promise<T> | T): Promise<T>;
}

declare module 'cordis' {
  interface Context {
    harnessMutations: MutationPort;
    harnessTransportSignal?: AbortSignal;
  }
}

/** A trusted gateway authenticates the viewer before forwarding a request. */
export interface GatewayRequest {
  origin: string;
  /** Closing a device session aborts every forwarded response for it. */
  signal: AbortSignal;
}

export type UpgradeHandler = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer,
  signal: AbortSignal) => void | Promise<void>;

export interface NetworkPort {
  forward(request: IncomingMessage, response: ServerResponse, access: GatewayRequest): Promise<void>;
}

declare module 'cordis' {
  interface Context { harnessNetwork: NetworkPort }
}
