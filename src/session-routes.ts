import type { IncomingMessage, ServerResponse } from 'node:http';
import { navigationSession, type NavigationHost } from './navigation-events.js';
import { eventStream, json, requestBody } from './http.js';
import { isRunning } from './protocol.js';
import type { PiSessions } from './pi-sessions.js';
import type { Runs } from './runs.js';
import type { SessionRegistry } from './registry.js';

type SessionRouteHost = NavigationHost & {
  pi: Pick<PiSessions, 'open' | 'queue' | 'queueInput'>;
  runs: Pick<Runs, 'watch' | 'compact' | 'cancel' | 'info' | 'startRun'>;
  getConversation(id: string): Promise<unknown>;
  delete(ids: string[]): Promise<string[]>;
  export(ids: string[]): ReturnType<SessionRegistry['export']>;
};

function streamRun(runtime: SessionRouteHost, res: ServerResponse, id: string, runId: string, after: number) {
  const stream = eventStream(res);
  const detach = runtime.runs.watch(id, runId, after, (event) => {
    stream.send(event);
    if ((event.type === 'run' || event.type === 'snapshot') && !isRunning(event.run)) res.end();
  });
  res.once('close', detach);
  stream.start();
}

export async function sessionRoutes(runtime: SessionRouteHost, req: IncomingMessage, res: ServerResponse, url: URL,
  configuring: () => boolean) {
  const { pathname } = url;
  if (pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, runtime.registry.list().map((item) => navigationSession(runtime, item.id)));
  if (pathname === '/api/sessions' && req.method === 'POST') {
    const input = await requestBody(req);
    if (input?.workspaceId !== undefined && typeof input.workspaceId !== 'string') throw new Error('Invalid workspace ID');
    return json(res, 201, runtime.registry.create({ workspaceId: input?.workspaceId }));
  }
  const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(messages|cancel|runs|events|queue|compact))?$/.exec(pathname);
  if (match) {
    const id = match[1];
    if (!runtime.registry.get(id)) return json(res, 404, { error: 'Conversation not found' });
    if (!match[2] && req.method === 'PATCH') {
      const input = await requestBody(req);
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 140) throw new Error('Title must contain 1–140 characters');
      return json(res, 200, runtime.registry.update(id, { title: input.title.trim() }));
    }
    if (req.method === 'POST' && ['compact', 'runs', 'messages'].includes(match[2]) && configuring())
      throw new Error('Configuration is changing');
    if (match[2] === 'compact' && req.method === 'POST') {
      await runtime.runs.compact(id);
      return json(res, 200, { ok: true });
    }
    if (match[2] === 'queue' && req.method === 'POST') {
      const input = await requestBody(req, 20 * 1024 * 1024);
      return json(res, 202, await runtime.pi.queueInput(id, input.message, input.mode, input.attachments));
    }
    if (match[2] === 'queue' && req.method === 'GET')
      return json(res, 200, runtime.pi.queue(await runtime.pi.open(id)));
    if (!match[2] && req.method === 'GET') return json(res, 200, await runtime.getConversation(id));
    if (match[2] === 'cancel' && req.method === 'POST') return json(res, 200, { cancelled: runtime.runs.cancel(id) });
    if (match[2] === 'runs' && req.method === 'GET') return json(res, 200, { run: runtime.runs.info(id) ?? null });
    if (match[2] === 'runs' && req.method === 'POST') {
      const input = await requestBody(req, 20 * 1024 * 1024);
      return json(res, 202, runtime.runs.startRun(id, input.message, input));
    }
    if (match[2] === 'events' && req.method === 'GET') {
      await runtime.pi.open(id);
      streamRun(runtime, res, id, url.searchParams.get('run'), Number(url.searchParams.get('after') ?? 0));
      return;
    }
    if (match[2] === 'messages' && req.method === 'POST') {
      const input = await requestBody(req, 20 * 1024 * 1024);
      const run = runtime.runs.startRun(id, input.message, input);
      streamRun(runtime, res, id, run.id, 0);
      return;
    }
  }
  if (pathname === '/api/sessions/delete' && req.method === 'POST') {
    const input = await requestBody(req);
    return json(res, 200, { deleted: await runtime.delete(input.ids) });
  }
  if (pathname === '/api/sessions/export' && req.method === 'POST') {
    const input = await requestBody(req);
    if (!Array.isArray(input.ids) || input.ids.length > 200) return json(res, 400, { error: 'Invalid selection' });
    const records = runtime.export(input.ids);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mini-harness-sessions.json"', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), sessions: records }, null, 2));
  }
  return json(res, 404, { error: 'Not found' });
}
