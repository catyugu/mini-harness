import { navigationSession } from './navigation-events.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MiniHarnessRuntime } from './agent.js';
import { json, requestBody } from './http.js';
import { isRunning } from './protocol.js';

function streamRun(runtime: MiniHarnessRuntime, res: ServerResponse, id: string, runId: string, after: number) {
  let detach = () => {};
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15000);
  heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); detach(); };
  res.once('close', cleanup);
  try {
    detach = runtime.runs.watch(id, runId, after, (event) => {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (res.destroyed || res.writableEnded) return;
      // Slow or disconnected observers can reconnect from their cursor.
      if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
      res.write(JSON.stringify(event) + '\n');
      if ((event.type === 'run' || event.type === 'snapshot') && !isRunning(event.run)) res.end();
    });
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      res.flushHeaders();
    }
  } catch (error) { cleanup(); throw error; }
};

export async function sessionRoutes(runtime: MiniHarnessRuntime, req: IncomingMessage, res: ServerResponse, url: URL,
  configuring: () => unknown) {
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
    if (match[2] === 'compact' && req.method === 'POST') {
      if (configuring()) throw new Error('Configuration is changing');
      await runtime.runs.compact(id);
      return json(res, 200, { ok: true });
    }
    if (match[2] === 'queue' && req.method === 'POST') {
      const input = await requestBody(req, 20 * 1024 * 1024);
      return json(res, 202, await runtime.runs.queueInput(id, input.message, input.mode, input.attachments));
    }
    if (match[2] === 'queue' && req.method === 'GET') {
      const session = await runtime.pi.open(id);
      return json(res, 200, { steer: session.getSteeringMessages(), followUp: session.getFollowUpMessages() });
    }
    if (!match[2] && req.method === 'GET') return json(res, 200, await runtime.getConversation(id));
    if (match[2] === 'cancel' && req.method === 'POST') return json(res, 200, { cancelled: runtime.runs.cancel(id) });
    if (match[2] === 'runs' && req.method === 'GET') return json(res, 200, { run: runtime.runs.info(id) ?? null });
    if (match[2] === 'runs' && req.method === 'POST') {
      const input = await requestBody(req, 20 * 1024 * 1024);
      if (configuring()) throw new Error('Configuration is changing');
      return json(res, 202, runtime.runs.startRun(id, input.message, input.model, input.attachments, input.thinkingLevel));
    }
    if (match[2] === 'events' && req.method === 'GET') {
      await runtime.pi.open(id);
      streamRun(runtime, res, id, url.searchParams.get('run'), Number(url.searchParams.get('after') ?? 0));
      return;
    }
    if (match[2] === 'messages' && req.method === 'POST') {
      const input = await requestBody(req, 20 * 1024 * 1024);
      if (configuring()) throw new Error('Configuration is changing');
      const run = runtime.runs.startRun(id, input.message, input.model, input.attachments, input.thinkingLevel);
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
