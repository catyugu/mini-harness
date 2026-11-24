import type { SessionRecord } from './conversation.js';
import { extension } from './contributions.js';

export interface SessionRecords {
  list(): { id: string; timestamp: string; data: unknown }[];
  append(data: unknown): Promise<string>;
}

export interface RecordProjection<State> {
  initial(): State;
  reduce(state: State, record: ReturnType<SessionRecords['list']>[number]): State;
}

export const recordsForPlugin = Symbol.for('mini-harness.sessionRecords');

interface SessionDirectory {
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  [recordsForPlugin](id: string, pluginId: string): SessionRecords;
}

declare module 'cordis' {
  interface Context { harnessSessions: SessionDirectory }
}

export const sessionExtensions = {
  records: extension((source) => {
    const sessions = source.service('harnessSessions');
    const records = (id: string) => {
      if (!source.visible(id)) throw new Error('Conversation outside plugin scope');
      return sessions[recordsForPlugin](id, source.pluginId);
    };
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
