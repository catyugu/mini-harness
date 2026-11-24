import type { SessionRecord } from './shared/identity.js';
import type { SessionProjection } from './log-api.js';
import type { SessionStore } from './store.js';
import type { ContributionSource } from '@mini-harness/kernel/contributions';
import { extension } from '@mini-harness/kernel/contributions';

export interface SessionRecords {
  list(): { id: string; timestamp: string; data: unknown }[];
  append(data: unknown): Promise<string>;
}

export interface RecordProjection<State> {
  initial(): State;
  reduce(state: State, record: ReturnType<SessionRecords['list']>[number]): State;
}

export interface SessionAccess {
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input: { parentId?: string; workspaceId?: string; title?: string }): SessionRecord;
  rename(id: string, title: string): SessionRecord;
  depth(id: string): number;
  workspacePath(id: string): string;
  history(id: string): Pick<SessionProjection, 'messages' | 'leafId' | 'model' | 'thinkingLevel'> | undefined;
  assertAvailable(id: string): void;
}

export const bindSessionAccess = Symbol.for('mini-harness.sessionAccess');

interface SessionDirectory {
  [bindSessionAccess](source: ContributionSource): SessionAccess & { records(id: string): SessionRecords };
}

declare module 'cordis' {
  interface Context { harnessSessions: SessionDirectory }
}

export function sessionAccess(registry: SessionStore, source: ContributionSource,
  records: (id: string, plugin: string) => SessionRecords): ReturnType<SessionDirectory[typeof bindSessionAccess]> {
  const check = (id: string) => {
    source.signal.throwIfAborted();
    if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
  };
  return {
    get(id) { check(id); return registry.get(id); },
    list(workspaceId) {
      source.signal.throwIfAborted();
      return registry.list(workspaceId).filter(({ id }) => source.visible(id));
    },
    create({ parentId, workspaceId, title }) {
      source.signal.throwIfAborted();
      if (parentId) check(parentId);
      else if (source.scopeKey?.startsWith('session:')) throw new Error('Scoped plugins must create children of a visible conversation');
      if (source.scopeKey?.startsWith('workspace:') && !parentId) {
        const ownWorkspace = source.scopeKey.slice('workspace:'.length);
        if (workspaceId !== undefined && workspaceId !== ownWorkspace) throw new Error('Workspace outside plugin scope');
        workspaceId = ownWorkspace;
      }
      return registry.create({ parentId, workspaceId, title });
    },
    rename(id, title) { check(id); return registry.rename(id, title); },
    depth(id) { check(id); return registry.depth(id); },
    workspacePath(id) { check(id); return registry.workspacePath(id); },
    history(id) {
      check(id);
      return registry.inspectLog(id, (log) => {
        const { messages, leafId, model, thinkingLevel } = log.projection();
        return structuredClone({ messages, leafId, model, thinkingLevel });
      }, true);
    },
    assertAvailable(id) { check(id); registry.assertAvailable(id); },
    records(id) { check(id); return records(id, source.pluginId); }
  };
}

export const sessionExtensions = {
  access: extension((source): SessionAccess => source.service('harnessSessions')[bindSessionAccess](source)),
  records: extension((source) => {
    const { records } = source.service('harnessSessions')[bindSessionAccess](source);
    return {
      list: (id: string) => source.run('read session records', () => records(id).list()),
      append: (id: string, data: unknown) => source.run('append session record', () => records(id).append(data)),
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
