import { randomUUID } from 'node:crypto';
import type { AgentEvent } from './api.ts';
import type { RecordPublisher } from '@mini-harness/sessions/display-record';

const owner = { pluginId: 'core:agent', instanceId: 'core:agent' };
const kind = 'reasoning';
const title = 'Reasoning';

/** Associate live reasoning with its single durable assistant message. */
export function reasoningRecords() {
  const live = new WeakMap<RecordPublisher, string>();
  return (event: AgentEvent, sink: RecordPublisher) => {
    let id = live.get(sink);
    if (event.type === 'thinking') {
      if (!id) {
        id = randomUUID();
        live.set(sink, id);
        sink.set({ type: 'record', id, plugin: owner.pluginId, instanceId: owner.instanceId, kind, title });
      }
      sink.append(id, 'text', event.text);
      return;
    }
    if (event.type === 'assistant-start') {
      if (id) sink.remove(id);
      live.delete(sink);
      return;
    }
    if (event.type !== 'assistant') return;
    live.delete(sink);
    if (event.message.content.some((part) => part.type === 'thinking' && part.thinking && !part.redacted))
      return [{ owner, kind, title, id: id ?? randomUUID(), source: ['message', 'content'] }];
    if (id) sink.remove(id);
  };
}
