import { isViewMessage } from '@mini-harness/sessions/message';
import { expectPresent } from '../../../test/support/required.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NativeAssistantMessage } from '@mini-harness/llm/api';
import { SessionLog } from '../src/log.ts';
import { encodeLog } from '../src/record-log.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-log-'));
  const file = join(root, 'session.jsonl');
  const opened: SessionLog[] = [];
  const open = () => {
    const log = new SessionLog(file, 'conversation');
    opened.push(log);
    return log;
  };
  t.after(() => {
    for (const log of opened) log.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, open };
}
const user = (content: string) => ({
  type: 'message' as const,
  message: { role: 'user' as const, content, timestamp: 1 },
});

test('historical context records migrate once without changing source identity', (t) => {
  const { open, file } = fixture(t);
  const log = open();
  const first = log.append(user('original'));
  const second = log.append(user('recent'));
  const timestamp = new Date().toISOString();
  const editId = 'a'.repeat(32);
  const compactId = 'b'.repeat(32);
  const historical = encodeLog(JSON.parse(log.serialize().split('\n')[0]), [
    first, second,
    { type: 'context-edit', targetId: first.id, replacement: 'shortened', id: editId, seq: 3, parentId: second.id, timestamp, version: 1 },
    { type: 'compaction', summary: 'checkpoint', keepFromId: second.id, id: compactId, seq: 4, parentId: editId, timestamp, version: 1 },
  ] as Parameters<typeof encodeLog>[1]);
  log.close();
  writeFileSync(file, historical);
  const reader = new SessionLog(file, 'conversation', undefined, undefined, true);
  const projection = reader.context();
  reader.close();
  assert.equal(readFileSync(file, 'utf8'), historical);
  const writer = open();
  assert.deepEqual(writer.context(), projection);
  assert.equal(writer.originalMessage(first.id)?.content, 'original');
  assert.equal(writer.entry(compactId)?.type, 'context-replace');
  const migrated = readFileSync(file, 'utf8');
  assert.equal(migrated, writer.serialize());
  assert.notEqual(migrated, historical);
  writer.close();
  assert.deepEqual(open().context(), projection);
  assert.equal(readFileSync(file, 'utf8'), migrated);
});

test('native log retains model semantics and gives defensive read projections', (t) => {
  const { open, file } = fixture(t);
  const log = open();
  const message: NativeAssistantMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'signed' },
      { type: 'text', text: 'answer', textSignature: 'text-signature' },
      {
        type: 'toolCall',
        id: 'tool-1',
        name: 'test',
        arguments: { value: 1 },
        thoughtSignature: 'tool-signature',
      },
    ],
    timestamp: 2,
    provider: 'test',
    model: 'model',
    stopReason: 'toolUse',
    usage: { input: 2, output: 3, totalTokens: 5, cacheRead: 0, cacheWrite: 0 },
    providerData: { api: 'test-api', responseId: 'continuation' },
  };
  log.append(user('question'));
  log.append({ type: 'message', message });
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
  const snapshot = log.projection();
  snapshot.contextMessages.length = 0;
  const entries = log.entries();
  entries.length = 0;
  assert.equal(log.entries().length, 2);
  log.close();
  assert.deepEqual(open().projection().contextMessages.at(-1), message);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('operational entries keep the transcript leaf stable and revision uses compare-and-swap', (t) => {
  const { open } = fixture(t);
  const log = open();
  const first = log.append(user('original'));
  log.append({
    type: 'run',
    run: {
      id: 'run',
      sessionId: 'conversation',
      state: 'running',
      startedAt: new Date().toISOString(),
      sequence: 1,
    },
  });
  log.append({ type: 'inbox-enqueued', item: { id: 'queued', mode: 'steer', text: 'later', images: [] } });
  assert.equal(log.projection().leafId, first.id);
  assert.equal(log.entries().length, 3);
  const second = log.revise(user('revised'), null, first.id);
  assert.deepEqual(
    log
      .projection()
      .timeline.filter(isViewMessage)
      .map(({ content }) => content),
    ['revised'],
  );
  assert.throws(() => log.revise(user('stale revision'), null, first.id), /Conversation changed/);
  assert.equal(log.projection().leafId, second.id);
  assert.equal(log.branch(first.id)[0].id, first.id);
  assert.deepEqual(
    log
      .projection(first.id)
      .timeline.filter(isViewMessage)
      .map(({ content }) => content),
    ['original'],
  );
  assert.deepEqual(log.projection(null).timeline.filter(isViewMessage), []);
  assert.equal(log.projection().leafId, second.id);
});

test('a durable message acknowledges inbox delivery exactly once and restart retains pending input', (t) => {
  const { open } = fixture(t);
  let log = open();
  log.append({ type: 'inbox-enqueued', item: { id: 'delivered', mode: 'steer', text: 'first', images: [] } });
  log.append({ ...user('first'), inboxId: 'delivered' });
  assert.throws(() => log.append({ ...user('duplicate'), inboxId: 'delivered' }), /not pending/);
  log.append({ type: 'inbox-enqueued', item: { id: 'pending', mode: 'queue', text: 'next', images: [] } });
  log.append({
    type: 'run',
    run: {
      id: 'run',
      sessionId: 'conversation',
      state: 'running',
      startedAt: new Date().toISOString(),
      sequence: 4,
    },
  });
  log.close();
  log = open();
  log.recover();
  assert.equal(log.projection().run?.state, 'interrupted');
  assert.deepEqual(
    log.inbox().map(({ id }) => id),
    ['pending'],
  );
  const count = log.entries().length;
  log.recover();
  assert.equal(log.entries().length, count);
  log.append({ type: 'inbox-cancelled', ids: ['pending'], reason: 'User cancelled' });
  assert.deepEqual(log.inbox(), []);
});

test('recovery discards only a torn final record and preserves every acknowledged record', (t) => {
  const { open, file } = fixture(t);
  let log = open();
  log.append(user('durable'));
  log.close();
  const original = readFileSync(file, 'utf8');
  appendFileSync(file, '{"version":1,"seq":2,"type":"mess');
  log = open();
  assert.equal(readFileSync(file, 'utf8'), original);
  log.append(user('after recovery'));
  log.close();
  assert.deepEqual(
    open()
      .projection()
      .timeline.filter(isViewMessage)
      .map(({ content }) => content),
    ['durable', 'after recovery'],
  );
});

test('complete corrupt records fail closed without truncating history', (t) => {
  const { open, file } = fixture(t);
  const log = open();
  log.append(user('durable'));
  log.close();
  appendFileSync(file, '{"invalid":true}\n');
  const bytes = readFileSync(file);
  assert.throws(() => open(), /Corrupt session log/);
  assert.deepEqual(readFileSync(file), bytes);
});

test('checksum changes fail closed even when the record remains valid JSON', (t) => {
  const { open, file } = fixture(t);
  const log = open();
  log.append(user('original'));
  log.close();
  writeFileSync(file, readFileSync(file, 'utf8').replace('original', 'tampered'));
  assert.throws(() => open(), /checksum/);
});

test('a writer refuses an externally changed file size without overwriting any bytes', (t) => {
  const { open, file } = fixture(t);
  const log = open();
  log.append(user('acknowledged'));
  appendFileSync(file, 'external write\n');
  const bytes = readFileSync(file);
  assert.throws(() => log.serialize(), /size changed/);
  assert.throws(() => log.append(user('must not overwrite')), /size changed/);
  assert.throws(() => log.serialize(), /closed/);
  assert.deepEqual(readFileSync(file), bytes);
});

test('log writers reject symlinks, hardlinks, and replaced paths', (t) => {
  const { open, file, root } = fixture(t);
  const log = open();
  log.append(user('safe'));
  renameSync(file, join(root, 'old.jsonl'));
  writeFileSync(file, 'unrelated');
  assert.throws(() => log.append(user('late')), /replaced/);
  assert.throws(() => log.serialize(), /closed/);
  rmSync(file);
  symlinkSync(join(root, 'old.jsonl'), file);
  assert.throws(() => open());
  rmSync(file);
  linkSync(join(root, 'old.jsonl'), file);
  assert.throws(() => open(), /outside managed storage/);
});

test('compaction and context edits change model context without deleting conversation history', (t) => {
  const { open } = fixture(t);
  const log = open();
  log.append(user('old context'));
  const keep = log.append(user('recent context'));
  log.append({
    type: 'context-replace',
    replacements: [
      { start: 1, deleteCount: 1, insert: [user('redacted recent context').message], preserveSource: true },
      { start: 0, deleteCount: 1, insert: [user('Summary of earlier conversation:\nSummary').message] },
    ],
  });
  assert.equal(log.originalMessage(keep.id)?.content, 'recent context');
  log.append(user('new question'));
  assert.deepEqual(
    log
      .projection()
      .timeline.filter(isViewMessage)
      .map(({ content }) => content),
    ['old context', 'recent context', 'new question'],
  );
  assert.deepEqual(
    log.projection().contextMessages.map(({ content }) => content),
    ['Summary of earlier conversation:\nSummary', 'redacted recent context', 'new question'],
  );
  assert.equal(log.projection().contextEntryIds[1], keep.id);
  assert.notEqual(log.context().contextRevisions[1], keep.id);
  assert.equal(log.projection().contextEntryIds.length, log.projection().contextMessages.length);
  const compacted = log.context();
  log.revise(user('new branch'), keep.id, compacted.leafId);
  assert.deepEqual(
    log.context().contextMessages.map(({ content }) => content),
    ['old context', 'recent context', 'new branch'],
  );
  assert.deepEqual(log.context(compacted.leafId), compacted);
});

test('attachments retain full model input while display keeps the submitted text and labels', (t) => {
  const { open } = fixture(t);
  const log = open();
  log.append({
    ...user('read this\n\nAttached file: "secret.txt"\ncontents'),
    presentation: { userText: 'read this', attachments: [{ name: 'secret.txt', mimeType: 'text/plain' }] },
  });
  const state = log.projection();
  assert.equal(state.timeline.filter(isViewMessage)[0].content, 'read this');
  assert.equal(
    expectPresent(state.timeline.filter(isViewMessage)[0]?.attachments?.[0], 'session attachment').name,
    'secret.txt',
  );
  assert.match(String(state.contextMessages[0].content), /contents/);
});

test('tool execution stays auditable while accepted content is stored as a compact reversible delta', (t) => {
  const { open, file } = fixture(t);
  let log = open();
  const content = 'x'.repeat(7200);
  const raw = log.append({
    type: 'tool-execution',
    result: {
      role: 'toolResult',
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: content }],
      isError: false,
      timestamp: 1,
    },
  });
  const accepted = log.acceptToolResult(raw.id, [{ type: 'text', text: content + ' redacted' }]);
  assert.ok(readFileSync(file, 'utf8').length < 9000, 'Original content should not be duplicated');
  assert.equal(log.projection().leafId, accepted.id);
  const before = log.projection().contextMessages[0];
  assert.equal(before.role, 'toolResult');
  log.close();
  log = open();
  assert.deepEqual(log.projection().contextMessages[0], before);
  assert.equal(log.entries().filter((entry) => entry.type === 'tool-execution').length, 1);
  assert.throws(() => log.acceptToolResult('a'.repeat(32), []), /missing execution/);
});

test('historical plugin records normalize to one owner without changing identity or the selected branch', (t) => {
  const { open, file } = fixture(t);
  const log = open(),
    first = log.append(user('before'));
  log.close();
  const instanceId = 'session:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/notes';
  function historical(seq: number, parentId: string, namespace: string, data: unknown) {
    const entry = {
      type: 'custom',
      namespace,
      data,
      version: 1,
      seq,
      id: seq.toString().repeat(32),
      parentId,
      timestamp: first.timestamp,
    };
    const checksum = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    appendFileSync(file, JSON.stringify({ ...entry, checksum }) + '\n');
    return entry;
  }
  const application = historical(2, first.id, 'notes', { count: 1 });
  const scoped = historical(3, application.id, 'display:' + instanceId, {
    data: { count: 2 },
    display: { title: 'Progress', content: 'Done' },
  });
  const unmapped = historical(4, scoped.id, 'unknown.format', ['raw']);
  const restored = open();
  const last = restored.append(user('after'));
  const diagnostic = restored.entries().find(({ id }) => id === unmapped.id);
  assert.deepEqual(diagnostic, {
    type: 'diagnostic',
    code: 'historical-record',
    version: 1,
    seq: 4,
    id: unmapped.id,
    parentId: scoped.id,
    timestamp: first.timestamp,
    data: { label: 'unknown.format', payload: ['raw'] },
  });
  assert.match(readFileSync(file, 'utf8').trimEnd().split('\n').at(-1) ?? '', /"type":"message"/);
  const records = restored.branch().filter((entry) => entry.type === 'plugin-record');
  assert.deepEqual(
    records.map(({ id, parentId, owner, data }) => ({ id, parentId, owner, data })),
    [
      {
        id: application.id,
        parentId: first.id,
        owner: { pluginId: 'notes', instanceId: 'notes' },
        data: { count: 1 },
      },
      {
        id: scoped.id,
        parentId: application.id,
        owner: { pluginId: 'notes', instanceId },
        data: { count: 2 },
      },
    ],
  );
  assert.deepEqual(
    restored.projection().timeline.filter((entry) => entry.type === 'record'),
    [
      {
        id: scoped.id,
        plugin: 'notes',
        instanceId,
        type: 'record',
        title: 'Progress',
        content: 'Done',
      },
    ],
  );
  assert.equal(restored.projection().leafId, last.id);
  assert.deepEqual(
    restored.projection().contextMessages.map(({ content }) => content),
    ['before', 'after'],
  );
});

test('recorded requests reuse their tool schema and restore transformed input after reopening', (t) => {
  const { open } = fixture(t);
  let log = open();
  log.append(user('original'));
  const request = {
    model: { provider: 'test', id: 'model' },
    systemPrompt: 'system',
    messages: [user('transformed').message],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
  };
  const first = log.recordRequest(request);
  const second = log.recordRequest(request);
  log.close();
  log = open();
  const third = log.recordRequest(request);
  assert.equal(log.entries().filter(({ type }) => type === 'tool-schema').length, 1);
  for (const { id } of [first, second, third]) assert.deepEqual(log.requestSnapshot(id), request);
  assert.equal(log.projection().contextMessages[0].content, 'original');
});
