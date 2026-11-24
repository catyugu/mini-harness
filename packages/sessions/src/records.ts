import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ViewMessage } from './shared/message.js';
import type { SessionRecord } from './shared/identity.js';
import { assertOutsideMountTransaction } from '@mini-harness/kernel/mutation-api';
import { extension } from '@mini-harness/kernel/contributions';

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

export const recordsForPlugin = Symbol.for('mini-harness.sessionRecords');

export interface SessionAccess {
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string; title?: string; workspaceId?: string }): SessionRecord;
  rename(id: string, title: string): SessionRecord;
  depth(id: string): number;
  workspacePath(id: string): string;
  history(id: string): { messages: ViewMessage[]; leafId: string | null; model?: ModelChoice };
}

export const sessionAccess = Symbol.for('mini-harness.sessionAccess');

interface SessionDirectory {
  [sessionAccess]: SessionAccess;
  [recordsForPlugin](id: string, owner: RecordOwner): SessionRecords;
}

export const sessionExtensions = {
  access: extension((source): SessionAccess => {
    const sessions = source.service('harnessSessions')[sessionAccess];
    const check = (id: string) => {
      source.signal.throwIfAborted();
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
    };
    return {
      get(id) {
        source.signal.throwIfAborted();
        return source.visible(id) ? sessions.get(id) : undefined;
      },
      list(workspaceId) {
        source.signal.throwIfAborted();
        return sessions.list(workspaceId).filter(({ id }) => source.visible(id));
      },
      create({ title, workspaceId, parentId } = {}) {
        source.signal.throwIfAborted();
        assertOutsideMountTransaction();
        if (source.scopeKey?.startsWith('session:') && !parentId)
          throw new Error('A session plugin must create a child conversation');
        if (parentId) check(parentId);
        if (source.scopeKey?.startsWith('workspace:')) {
          const owner = source.scopeKey.slice('workspace:'.length);
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
  }),
  records: extension((source) => {
    const sessions = source.service('harnessSessions');
    const records = (id: string) => {
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
      return sessions[recordsForPlugin](id, { pluginId: source.pluginId, instanceId: source.instanceId });
    };
    return {
      list: (id: string) => source.run('read session records', () => records(id).list()),
      append: (id: string, data: unknown, display?: RecordDisplay) => {
        assertOutsideMountTransaction();
        return source.run('append session record', () => records(id).append(data, display));
      },
      projection<State>(projection: RecordProjection<State>) {
        if (typeof projection.initial !== 'function' || typeof projection.reduce !== 'function')
          throw new Error('Invalid session record projection');
        source.signal.throwIfAborted();
        let active = true;
        const dispose = source.context.effect(() => () => { active = false; });
        return {
          read: (id: string) => source.run('read session record projection', () => {
            if (!active) throw new Error('Session record projection is disposed');
            return records(id).list().reduce(projection.reduce, projection.initial());
          }),
          dispose
        };
      }
    };
  })
};

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessSessions: SessionDirectory }
}
