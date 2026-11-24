import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ViewMessage } from './shared/message.js';
import type { SessionRecord } from './shared/identity.js';
import { assertOutsideMountTransaction } from '@mini-harness/plugin-api/mutation-api';
import { Service, type Context } from 'mini-harness/cordis';
import { pluginInstance, sessionVisible } from '@mini-harness/plugin-api/instance';

export interface RecordDisplay { title: string; content?: unknown }
export interface RecordOwner { pluginId: string; instanceId: string }

export interface SessionRecords {
  list(): { id: string; timestamp: string; data: unknown }[];
  append(data: unknown, display?: RecordDisplay): Promise<string>;
}

export interface RecordProjection<State> {
  initial(): State;
  reduce(state: State, record: ReturnType<SessionRecords['list']>[number]): State;
}

export interface SessionAccess {
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string; title?: string; workspaceId?: string }): SessionRecord;
  rename(id: string, title: string): SessionRecord;
  depth(id: string): number;
  workspacePath(id: string): string;
  history(id: string): { messages: ViewMessage[]; leafId: string | null; model?: ModelChoice };
}

export interface SessionDirectory {
  access(): SessionAccess;
  records(id: string): SessionRecords;
}

export function sessionDirectory(sessions: SessionAccess, open: (id: string, owner: RecordOwner) => SessionRecords): SessionDirectory {
  return Service.track({
    access() {
      const ctx: Context = Service.caller(this);
      const signal = ctx.fiber.signal;
      const { scopeKey } = pluginInstance(ctx);
      const check = (id: string) => {
        signal.throwIfAborted();
        if (!sessionVisible(ctx, id)) throw new Error('Conversation outside plugin scope');
      };
      return {
        get(id) {
          signal.throwIfAborted();
          return sessionVisible(ctx, id) ? sessions.get(id) : undefined;
        },
        list(workspaceId) {
          signal.throwIfAborted();
          return sessions.list(workspaceId).filter(({ id }) => sessionVisible(ctx, id));
        },
        create({ title, workspaceId, parentId } = {}) {
          signal.throwIfAborted();
          assertOutsideMountTransaction();
          if (scopeKey?.startsWith('session:') && !parentId)
            throw new Error('A session plugin must create a child conversation');
          if (parentId) check(parentId);
          if (scopeKey?.startsWith('workspace:')) {
            const owner = scopeKey.slice('workspace:'.length);
            if (workspaceId !== undefined && workspaceId !== owner)
              throw new Error('Workspace outside plugin scope');
            workspaceId = owner;
          }
          return sessions.create({ title, workspaceId, parentId });
        },
        rename(id, title) {
          assertOutsideMountTransaction();
          check(id);
          return sessions.rename(id, title);
        },
        depth(id) { check(id); return sessions.depth(id); },
        workspacePath(id) { check(id); return sessions.workspacePath(id); },
        history(id) { check(id); return sessions.history(id); }
      };
    },
    records(id: string) {
      const ctx = Service.caller(this);
      const signal = ctx.fiber.signal;
      const { pluginId, instanceId } = pluginInstance(ctx);
      const records = () => {
        signal.throwIfAborted();
        if (!sessionVisible(ctx, id)) throw new Error('Conversation outside plugin scope');
        return open(id, { pluginId, instanceId });
      };
      return {
        list: () => records().list(),
        append(data: unknown, display?: RecordDisplay) {
          assertOutsideMountTransaction();
          return ctx.fiber.run(() => records().append(data, display), signal);
        }
      };
    }
  });
}

declare module 'mini-harness/cordis' {
  interface Context { harnessSessions: SessionDirectory }
}
