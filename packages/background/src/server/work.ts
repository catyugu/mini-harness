import { randomUUID } from 'node:crypto';
import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/runs/api';
import type {} from '@mini-harness/sessions/records';
import { DomainError } from '@mini-harness/platform/errors';
import { waitFor } from '@mini-harness/platform/wait';
import { terminal, type TaskHandle } from '@mini-harness/tasks/api';
import { executePreparedTool, prepareTool } from '@mini-harness/tools/invocation';
import type { ToolContext, ToolResult, ToolUpdate } from '@mini-harness/tools/api';
import type { Work, WorkOutput } from '../shared/work.ts';
import { WorkOutputRing, readWorkOutput } from './output.ts';

const owner = { pluginId: 'background', instanceId: 'background' };
const emptyOutput: WorkOutput = { cursor: 0, truncated: false, chunks: [] };

interface WorkRecord {
  work: Work;
  output?: WorkOutput;
}

interface ActiveWork {
  sessionId: string;
  input: Pick<Work, 'id' | 'tool' | 'name' | 'arguments'>;
  handle: TaskHandle<ToolResult>;
  output: WorkOutputRing;
  settlement: Promise<Work>;
  progress?: ToolUpdate;
}

function project(input: ActiveWork['input'], handle: TaskHandle, outputCursor: number): Work {
  const { id: _, owner: _owner, lane: _lane, ...state } = handle.snapshot();
  return { ...input, ...state, outputCursor };
}

function liveSnapshot({ input, handle, output, progress }: ActiveWork) {
  return { ...project(input, handle, output.cursor), progress };
}

export class Background {
  private readonly active = new Map<string, ActiveWork>();

  constructor(
    private readonly ctx: Context,
    private readonly change: (id: string) => void,
  ) {}

  private history(id: string, query?: { limit: number } | { key: string }) {
    return this.ctx.harnessSessions.pluginRecords<WorkRecord>(id, owner, query).map(({ data }) => data);
  }

  private notice(sessionId: string, id: string, name: string, message: string, key: string) {
    if (this.ctx.fiber.signal.aborted || this.ctx.harnessTasks.sealed) return;
    try {
      this.ctx.harnessRuns.send(sessionId, {
        message: name + ': ' + message,
        messageId: id + ':' + key,
        mode: 'queue',
        origin: {
          source: 'task',
          taskId: id,
          label: key === 'settled' ? 'Background task finished' : 'Background task report',
        },
      });
    } catch (error) {
      if (!(error instanceof DomainError && ['not_found', 'conflict', 'unavailable'].includes(error.code)))
        this.ctx.logger.error('Could not deliver background notification ' + id, error);
    }
  }

  private notify(id: string, work: Work) {
    const description = JSON.stringify(work.result ?? work.error ?? null).slice(0, 4200);
    this.notice(id, work.id, work.name, work.state + ' ' + description, 'settled');
  }

  start(sessionId: string, name: string, args: Record<string, unknown>, callId: string) {
    const { harnessTasks: tasks, harnessSessions: sessions } = this.ctx;
    sessions.assertAvailable(sessionId);
    const provider = this.ctx.harnessProfileScopes.context(`session:${sessionId}`);
    const tool = provider.harnessTools
      .list({ resourceId: sessionId, scope: sessions.scope(sessionId) })
      .find((candidate) => candidate.name === name);
    if (!tool?.background) throw new Error('Tool does not support background execution: ' + name);
    const policy = () => provider.get('harnessToolPolicy')?.(sessionId, tool) !== false;
    if (!policy()) throw new Error('Tool denied by conversation policy: ' + name);
    const prepared = prepareTool(tool, args);
    const log = sessions.log(sessionId);
    const input = {
      id: randomUUID(),
      tool: name,
      name: tool.label ?? name,
      arguments: structuredClone(args),
    };
    const append = (data: WorkRecord) =>
      log.append({ type: 'plugin-record', owner, scope: 'session', key: input.id, data });
    const output = new WorkOutputRing();
    let reports = 0;
    let entry: ActiveWork;
    const handle = tasks.start(
      {
        owner: 'background:' + sessionId,
        provider: tool.binding.provider,
        signal: AbortSignal.any([tool.binding.signal, this.ctx.fiber.signal]),
        onEvent: ({ task }) => {
          if (!terminal(task.state) && this.active.has(input.id)) this.change(sessionId);
        },
      },
      (task) => {
        sessions.assertAvailable(sessionId);
        if (!policy()) throw new Error('Tool denied by conversation policy: ' + name);
        return executePreparedTool(prepared, callId, {
          signal: task.signal,
          onUpdate: (progress) => {
            entry.progress = progress;
            this.change(sessionId);
          },
          write: (text, channel = 'log') => {
            output.write(text, channel);
            this.change(sessionId);
          },
          report: (message) => this.notice(sessionId, input.id, name, message, 'report:' + ++reports),
          waitFor: async (id, signal) => {
            await task.waitFor(id, signal);
          },
        });
      },
    );
    const settle = (result?: ToolResult) => {
      const work = project(input, handle, output.cursor);
      if (result) {
        const keys = [
          ...(result.detailKeys ?? []),
          ...backgroundDetailKeys(tool.metadata?.backgroundDetails),
        ];
        work.result = {
          content: typeof result.summary === 'string' ? [result.summary.slice(0, 4000)] : textContent(result),
          toolState: result.state,
          details: Object.fromEntries(
            Object.entries(result.details ?? {}).filter(([key]) => keys.includes(key)),
          ),
        };
      }
      append({ work, output: output.cursor ? output.read() : undefined });
      this.notify(sessionId, work);
      return work;
    };
    try {
      append({ work: project(input, handle, output.cursor) });
    } catch (error) {
      handle.cancel(error);
      throw error;
    }
    const settlement = handle.result
      .then(settle, () => settle())
      .finally(() => {
        this.active.delete(input.id);
        this.change(sessionId);
      });
    entry = { sessionId, input, handle, output, settlement };
    this.active.set(input.id, entry);
    void settlement.catch((error) =>
      this.ctx.logger.error('Could not save background work ' + input.id, error),
    );
    this.change(sessionId);
    return { workId: input.id, state: 'accepted' };
  }

  list(sessionId: string) {
    this.ctx.harnessSessions.assertAvailable(sessionId);
    const live = [...this.active.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map(liveSnapshot)
      .filter(({ state }) => !terminal(state));
    const active = new Set(live.map(({ id }) => id));
    const history = this.history(sessionId, { limit: 50 + live.length })
      .map(({ work }) => work)
      .filter(({ id }) => !active.has(id));
    return [...live.reverse(), ...history.slice(-50).reverse()];
  }

  private find(sessionId: string, id: string) {
    this.ctx.harnessSessions.assertAvailable(sessionId);
    const candidate = this.active.get(id);
    const live = candidate?.sessionId === sessionId ? candidate : undefined;
    const snapshot = live && liveSnapshot(live);
    if (snapshot && !terminal(snapshot.state)) return { live, work: snapshot };
    const [history] = this.history(sessionId, { key: id });
    if (!history) throw new DomainError('not_found', 'Background work not found');
    return { ...history, live };
  }

  status(sessionId: string, id: string) {
    return this.find(sessionId, id).work;
  }

  output(sessionId: string, id: string, cursor?: number) {
    const found = this.find(sessionId, id);
    return found.live ? found.live.output.read(cursor) : readWorkOutput(found.output ?? emptyOutput, cursor);
  }

  cancel(sessionId: string, id: string) {
    return this.find(sessionId, id).live?.handle.cancel() ?? false;
  }

  async wait(sessionId: string, id: string, context: ToolContext) {
    const { live, work } = this.find(sessionId, id);
    if (!live) {
      if (!terminal(work.state)) throw new Error('Background work settlement could not be saved');
      return work;
    }
    if (context.waitFor && !terminal(live.handle.snapshot().state)) await context.waitFor(live.handle.id);
    return waitFor(live.settlement, context.signal);
  }

  async drain(ids?: string[]) {
    const active = [...this.active.values()].filter(({ sessionId }) => !ids || ids.includes(sessionId));
    for (const { handle } of active) handle.cancel();
    await Promise.allSettled(active.map(({ settlement }) => settlement));
  }

  busy(id: string) {
    return [...this.active.values()].some(({ sessionId }) => sessionId === id);
  }

  recover() {
    const sessions = this.ctx.harnessSessions;
    for (const { id } of sessions.list()) {
      for (let { work } of this.history(id)) {
        if (this.active.has(work.id)) continue;
        if (!terminal(work.state)) {
          work = {
            ...work,
            state: 'interrupted',
            finishedAt: new Date().toISOString(),
            error: 'Background work interrupted before settlement was recorded',
          };
          sessions
            .log(id)
            .append({ type: 'plugin-record', owner, scope: 'session', key: work.id, data: { work } });
        }
        if (!sessions.hasInbox(id, work.id + ':settled')) this.notify(id, work);
      }
    }
  }
}

function textContent({ content }: ToolResult) {
  return content.flatMap((part) => (part.type === 'text' ? [part.text.slice(0, 4000)] : []));
}

function backgroundDetailKeys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [];
}
