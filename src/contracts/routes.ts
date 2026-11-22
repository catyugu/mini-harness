import type { Context } from 'cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
  register(method: string, path: string, handler: RouteHandler): () => void;
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
