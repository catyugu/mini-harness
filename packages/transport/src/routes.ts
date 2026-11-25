import type { IncomingMessage, ServerResponse } from 'node:http';

import { DomainError, type ErrorCode } from '@mini-harness/platform/errors';

export const errorStatus = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unavailable: 503,
} satisfies Record<ErrorCode, number>;

/** An HTTP failure raised by a route handler. */
export class HttpError extends DomainError {
  readonly status = errorStatus[this.code];
}

/** HTTP-specific transport contracts. Capability handlers never import the server. */
export class HttpReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
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
declare module 'mini-harness/cordis' {
  interface Context {
    harnessRoutes: RoutePort;
  }
}

/** A trusted gateway authenticates the viewer and authorizes the requested route before forwarding. */
export interface GatewayRequest {
  origin: string;
  /** Closing a device session aborts every forwarded response for it. */
  signal: AbortSignal;
}

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
  signal: AbortSignal,
) => void | Promise<void>;

export interface NetworkPort {
  forward(request: IncomingMessage, response: ServerResponse, access: GatewayRequest): Promise<void>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessNetwork: NetworkPort;
  }
}

export interface UpgradePort {
  register(path: string, handler: UpgradeHandler): () => Promise<void>;
  dispatch(
    path: string,
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): boolean;
  close(): void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessUpgrades: UpgradePort;
  }
}
