import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteRequest {
  url: URL;
  workspace?: { id: string; path: string };
  signal: AbortSignal;
  body(max?: number): Promise<unknown>;
}
export type RouteHandler = (request: RouteRequest) => unknown | Promise<unknown>;

export interface RoutePort {
  register(method: string, path: string, handler: RouteHandler): () => void;
  dispatch(req: IncomingMessage, res: ServerResponse, url: URL,
    scope?: { path: string; workspace: RouteRequest['workspace'] }): Promise<void> | undefined;
}
