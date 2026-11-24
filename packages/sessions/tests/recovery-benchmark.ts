import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEntry, SessionEvent } from '../log-api.js';
import { encodeLog, SessionLog } from '../log.js';

const root = mkdtempSync(join(tmpdir(), 'mini-harness-recovery-bench-'));
const file = join(root, 'session.jsonl');
const timestamp = new Date().toISOString();
try {
  for (const turns of [500, 2000, 8000]) {
    const entries: SessionEntry[] = [];
    const requests: { id: string; last: string }[] = [];
    const leaves: string[] = [];
    let leaf: string | null = null;
    function append(event: SessionEvent, advances = true) {
      const seq = entries.length + 1;
      const id = seq.toString(16).padStart(8, '0');
      entries.push({ ...event, id, seq, parentId: leaf, timestamp, version: 1 });
      if (advances) leaf = id;
      return id;
    }
    for (let turn = 0; turn < turns; turn++) {
      if (turn === turns / 2) append({ type: 'compaction', summary: 'Earlier work', keepFromId: null });
      if (turn === turns * 3 / 4) { leaf = leaves[Math.floor(turns / 3)]; append({ type: 'branch' }); }
      const text = 'Turn ' + turn;
      append({ type: 'message', message: { role: 'user', content: text, timestamp: turn } });
      requests.push({ id: append({ type: 'model-request', request: { model: { id: 'benchmark', provider: 'fixture' },
        systemPrompt: 'Benchmark' } }, false), last: text });
      append({ type: 'message', message: { role: 'assistant', provider: 'fixture', model: 'benchmark', timestamp: turn,
        content: [{ type: 'toolCall', id: 'call-' + turn, name: 'read', arguments: {} }], stopReason: 'toolUse' } });
      const executionId = append({ type: 'tool-execution', result: { role: 'toolResult', toolCallId: 'call-' + turn,
        toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: turn } }, false);
      leaves.push(append({ type: 'tool-accepted', executionId }));
    }
    writeFileSync(file, encodeLog({ type: 'session', version: 1, id: 'benchmark', createdAt: timestamp }, entries));
    const started = performance.now();
    const log = new SessionLog(file, 'benchmark');
    const elapsed = performance.now() - started;
    try {
      for (const request of requests.filter((_request, index) => index % 100 === 0)) {
        const snapshot = log.requestSnapshot(request.id);
        assert.equal(snapshot.messages.at(-1)?.content, request.last);
      }
    } finally { log.close(); }
    console.log(turns + ' turns, ' + entries.length + ' records, ' + elapsed.toFixed(1) + ' ms recovery');
  }
} finally { rmSync(root, { recursive: true, force: true }); }
