import { isViewMessage } from '@mini-harness/sessions/message';
import { waitFor } from '@mini-harness/platform/wait';
import type { ConversationView } from '../shared/api.ts';
import { isRunning } from '@mini-harness/sessions/run-state';
import { eventStream } from '@mini-harness/transport/http';
import { projectHistory, projectToolEvent, projectToolResult } from './display-events.ts';
import { scheduler } from 'node:timers/promises';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { SessionSearchResult } from '../shared/api.ts';
import type { Context } from 'mini-harness/cordis';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';
import { projectSession } from './navigation.ts';

const validSession = /^[a-f0-9-]{36}$/;
const validWorkspace = /^[a-f0-9]{32}$/;

/** All session and run endpoints are registered in the session capability scope. */
export function registerSessionRoutes(ctx: Context, read: (id: string) => ConversationView) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!validSession.test(id) || !ctx.harnessSessions.get(id))
      throw new HttpError('not_found', 'Conversation not found');
    return id;
  };
  const permission = (value: unknown): ConversationPermission => {
    if (value !== 'standard' && value !== 'readOnly' && value !== 'fullAccess')
      throw new HttpError('invalid_input', 'Choose Standard, Read-only or Full access permission');
    return value;
  };
  const workspace = (id: string) => {
    if (!validWorkspace.test(id)) throw new HttpError('not_found', 'Workspace not found');
    ctx.harnessWorkspaces.get(id);
    return id;
  };
  add('GET', '/api/sessions', ({ url }) => {
    const requested = new Set(url.searchParams.getAll('id'));
    if (requested.size > 100 || [...requested].some((id) => !validSession.test(id)))
      throw new HttpError('invalid_input', 'Invalid conversation selection');
    const records = requested.size
      ? [...requested].flatMap((id) => {
          const record = ctx.harnessSessions.get(id);
          return record ? [record] : [];
        })
      : ctx.harnessSessions.list();
    return records.map((record) => projectSession(ctx, record));
  });
  add('GET', '/api/sessions/diagnostics', () => ctx.harnessSessions.diagnostics());
  add('GET', '/api/sessions/search', async ({ url, signal }) => {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query.length > 120) throw new HttpError('invalid_input', 'Search query is too long');
    if (query.length < 2) return [];
    const literal = new RegExp(query.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&'), 'iu');
    function find(
      id: string,
      field: SessionSearchResult['field'],
      text: string,
    ): SessionSearchResult | undefined {
      const match = literal.exec(text);
      if (!match) return;
      const end = match.index + match[0].length;
      if (field === 'title') return { id, field, snippet: text, match: [match.index, end] };
      const left = Math.max(0, match.index - 36),
        right = Math.min(text.length, end + 36);
      const prefix = left ? '…' : '';
      return {
        id,
        field,
        snippet: prefix + text.slice(left, right) + (right < text.length ? '…' : ''),
        match: [match.index - left + prefix.length, end - left + prefix.length],
      };
    }
    const hits: SessionSearchResult[] = [];
    const candidates = ctx.harnessSessions.list().slice(-500).reverse();
    for (const [index, { id, title }] of candidates.entries()) {
      if (index % 10 === 0) {
        await scheduler.yield();
        signal.throwIfAborted();
      }
      let hit = find(id, 'title', title);
      if (!hit) {
        const messages =
          ctx.harnessSessions.inspectLog(id, (log) =>
            log.projection().timeline.filter(isViewMessage).slice(-500),
          ) ?? [];
        for (const message of messages.reverse()) {
          if (message.role === 'toolResult') continue;
          const content =
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join(' ');
          hit = find(id, 'message', content.slice(0, 32768));
          if (hit) break;
        }
      }
      if (hit) hits.push(hit);
      if (hits.length === 50) break;
    }
    return hits;
  });
  add('POST', '/api/sessions', async ({ body }) => {
    const input = await body();
    if (input?.workspaceId != null && typeof input.workspaceId !== 'string')
      throw new HttpError('invalid_input', 'Invalid workspace ID');
    return new HttpReply(
      201,
      projectSession(
        ctx,
        ctx.harnessSessions.create({
          workspaceId: input?.workspaceId,
          permission: input?.permission === undefined ? undefined : permission(input.permission),
        }),
      ),
    );
  });
  add('GET', '/api/workspaces/:id/sessions', ({ params }) =>
    ctx.harnessSessions.list(workspace(params.id)).map((record) => projectSession(ctx, record)),
  );
  add('POST', '/api/workspaces/:id/sessions', async ({ params, body }) => {
    const input = await body();
    return new HttpReply(
      201,
      projectSession(
        ctx,
        ctx.harnessSessions.create({
          workspaceId: workspace(params.id),
          permission: input?.permission === undefined ? undefined : permission(input.permission),
        }),
      ),
    );
  });
  add('GET', '/api/sessions/:id/attachments/:attachment', ({ params }) => {
    const bytes = ctx.harnessSessions.readAttachment(session(params.id), params.attachment);
    if (!bytes) throw new HttpError('not_found', 'Attachment not found');
    return { data: bytes.toString('base64') };
  });
  add('GET', '/api/sessions/:id/queue', ({ params }) => {
    const id = session(params.id);
    ctx.harnessSessions.assertAvailable(id);
    return ctx.harnessSessions.inspectLog(id, (log) => log.queue(), true) ?? [];
  });
  add('GET', '/api/sessions/:id/events', ({ params, url, response }) => {
    const id = session(params.id);
    const runId = url.searchParams.get('run');
    if (!runId) throw new HttpError('invalid_input', 'Run ID is required');
    const stream = eventStream(response);
    const detach = ctx.harnessRuns.watch(
      id,
      runId,
      Number(url.searchParams.get('after') ?? 0),
      (event) => {
        if (event.type === 'snapshot') {
          stream.send({
            ...event,
            timeline: projectHistory(ctx, id, event.timeline),
            tools: event.tools?.map((tool) => projectToolEvent(ctx, id, tool)),
          });
        } else if (event.type === 'user' && event.revised) {
          const { timeline, leafId, model, thinkingLevel, partial, tools, records, run } = read(id);
          stream.send({
            type: 'snapshot',
            timeline,
            leafId,
            model,
            thinkingLevel,
            partial,
            tools,
            records,
            run,
            runId: event.runId,
            runSessionId: id,
            sequence: run?.sequence ?? event.sequence,
          });
        } else if (event.type === 'tool-end') {
          stream.send({ ...event, message: projectToolResult(ctx, id, event.message) });
        } else stream.send(event.type === 'tool' ? projectToolEvent(ctx, id, event) : event);
        if ((event.type === 'run' || event.type === 'snapshot') && !isRunning(event.run)) response.end();
      },
      () => response.end(),
    );
    response.once('close', detach);
    stream.start();
  });
  add('POST', '/api/sessions/:id/revise', async ({ params, body }) => {
    const id = session(params.id);
    const input = await body(20 * 1024 * 1024);
    if (
      !input ||
      typeof input.sourceEntryId !== 'string' ||
      !Object.hasOwn(input, 'expectedLeafId') ||
      typeof input.message !== 'string'
    )
      throw new HttpError('invalid_input', 'Invalid revision request');
    return ctx.harnessRuns.reviseAndStart(id, input);
  });
  add('GET', '/api/sessions/:id', ({ params }) => read(session(params.id)));
  add('PATCH', '/api/sessions/:id', async ({ params, body }) => {
    const id = session(params.id),
      input = await body();
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 140)
      throw new HttpError('invalid_input', 'Title must contain 1–140 characters');
    return projectSession(ctx, ctx.harnessSessions.rename(id, input.title.trim()));
  });
  add('PATCH', '/api/sessions/:id/permissions', async ({ params, body }) => {
    const id = session(params.id),
      input = await body();
    const updated = ctx.harnessSessions.setPermission(id, permission(input?.permission));
    if (updated.permission === 'fullAccess') ctx.harnessApprovals.approveSession(id);
    return projectSession(ctx, updated);
  });
  add('POST', '/api/sessions/delete', async ({ body, signal }) => {
    const input = await body();
    return { deleted: await waitFor(ctx.harnessSessions.delete(input.ids), signal) };
  });
  add('POST', '/api/sessions/export', async ({ body, response }) => {
    const input = await body();
    if (!Array.isArray(input.ids) || input.ids.length > 200)
      return new HttpReply(400, { error: 'Invalid selection' });
    const records = ctx.harnessSessions.export(input.ids);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mini-harness-sessions.json"',
      'Cache-Control': 'no-store',
    });
    response.end(
      JSON.stringify({ version: 3, exportedAt: new Date().toISOString(), sessions: records }, null, 2),
    );
  });
}
