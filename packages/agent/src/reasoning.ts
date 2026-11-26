import { randomUUID } from 'node:crypto';
import type { AgentRecordObserver, AgentRecordSink } from './events.ts';

const owner = { pluginId: 'core:agent', instanceId: 'core:agent' };
const kind = 'reasoning';
const title = 'Reasoning';

/** Associate live reasoning with its single durable assistant message. */
export function reasoningRecords(sink: AgentRecordSink): AgentRecordObserver {
  let id: string | undefined;
  return (event) => {
    if (event.type === 'thinking') {
      if (!id) {
        id = randomUUID();
        sink.set({ type: 'record', id, plugin: owner.pluginId, instanceId: owner.instanceId, kind, title });
      }
      sink.append(id, 'text', event.text);
      return;
    }
    if (event.type === 'assistant-start') {
      if (id) sink.remove(id);
      id = undefined;
      return;
    }
    if (event.type !== 'assistant') return;
    const recordId = id;
    id = undefined;
    if (event.message.content.some((part) => part.type === 'thinking' && part.thinking && !part.redacted))
      return { owner, kind, title, id: recordId ?? randomUUID(), source: ['message', 'content'] };
    if (recordId) sink.remove(recordId);
  };
}
