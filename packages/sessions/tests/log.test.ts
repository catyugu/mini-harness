import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NativeAssistantMessage } from '../../contracts/llm.js';
import { SessionLog } from '../log.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-log-'));
  const file = join(root, 'session.jsonl');
  const opened: SessionLog[] = [];
  const open = () => { const log = new SessionLog(file, 'conversation'); opened.push(log); return log; };
  t.after(() => { for (const log of opened) log.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, open };
}
const user = (content: string) => ({ type: 'message' as const, message: { role: 'user' as const, content, timestamp: 1 } });

test('native log retains model semantics and gives defensive read projections', (t) => {
  const { open, file } = fixture(t);
  const log = open();
  const message: NativeAssistantMessage = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'signed' },
    { type: 'text', text: 'answer', textSignature: 'text-signature' },
    { type: 'toolCall', id: 'tool-1', name: 'test', arguments: { value: 1 }, thoughtSignature: 'tool-signature' }
  ], timestamp: 2, provider: 'test', model: 'model', stopReason: 'toolUse',
  usage: { input: 2, output: 3, totalTokens: 5, cacheRead: 0, cacheWrite: 0 }, providerData: { api: 'test-api', responseId: 'continuation' } };
  log.append(user('question'));
  log.append({ type: 'message', message });
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
  const snapshot = log.projection();
  snapshot.contextMessages.length = 0;
  const entries = log.entries(); entries.length = 0;
  assert.equal(log.entries().length, 2);
  log.close();
  assert.deepEqual(open().projection().contextMessages.at(-1), message);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('operational entries keep the transcript leaf stable and revision uses compare-and-swap', (t) => {
  const { open } = fixture(t);
  const log = open();
  const first = log.append(user('original'));
  log.append({ type: 'run', run: { id: 'run', sessionId: 'conversation', state: 'running', startedAt: new Date().toISOString(), sequence: 1 } });
  log.append({ type: 'inbox-enqueued', item: { id: 'queued', mode: 'steer', text: 'later', images: [] } });
  assert.equal(log.projection().leafId, first.id);
  assert.equal(log.entries().length, 3);
  log.select(null, first.id);
  const second = log.append(user('revised'));
  assert.deepEqual(log.projection().messages.map(({ content }) => content), ['revised']);
  assert.throws(() => log.select(null, first.id), /Conversation changed/);
  assert.equal(log.projection().leafId, second.id);
  assert.equal(log.branch(first.id)[0].id, first.id);
  assert.deepEqual(log.projection(first.id).messages.map(({ content }) => content), ['original']);
  assert.deepEqual(log.projection(null).messages, []);
  assert.equal(log.projection().leafId, second.id);
});

test('a durable message acknowledges inbox delivery exactly once and restart retains pending input', (t) => {
  const { open } = fixture(t);
  let log = open();
  log.append({ type: 'inbox-enqueued', item: { id: 'delivered', mode: 'steer', text: 'first', images: [] } });
  log.append({ ...user('first'), inboxId: 'delivered' });
  assert.throws(() => log.append({ ...user('duplicate'), inboxId: 'delivered' }), /not pending/);
  log.append({ type: 'inbox-enqueued', item: { id: 'pending', mode: 'followUp', text: 'next', images: [] } });
  log.append({ type: 'run', run: { id: 'run', sessionId: 'conversation', state: 'running', startedAt: new Date().toISOString(), sequence: 4 } });
  log.close();
  log = open(); log.recover();
  assert.equal(log.projection().run.state, 'interrupted');
  assert.deepEqual(log.projection().inbox.map(({ id }) => id), ['pending']);
  const count = log.entries().length; log.recover();
  assert.equal(log.entries().length, count);
  log.append({ type: 'inbox-cancelled', ids: ['pending'], reason: 'User cancelled' });
  assert.deepEqual(log.projection().inbox, []);
});

test('recovery discards only a torn final record and preserves every acknowledged record', (t) => {
  const { open, file } = fixture(t);
  let log = open(); log.append(user('durable')); log.close();
  const original = readFileSync(file, 'utf8');
  appendFileSync(file, '{"version":1,"seq":2,"type":"mess');
  log = open();
  assert.equal(readFileSync(file, 'utf8'), original);
  log.append(user('after recovery'));
  log.close();
  assert.deepEqual(open().projection().messages.map(({ content }) => content), ['durable', 'after recovery']);
});

test('complete corrupt records fail closed without truncating history', (t) => {
  const { open, file } = fixture(t);
  const log = open(); log.append(user('durable')); log.close();
  appendFileSync(file, '{"invalid":true}\n');
  const bytes = readFileSync(file);
  assert.throws(() => open(), /Corrupt session log/);
  assert.deepEqual(readFileSync(file), bytes);
});

test('checksum changes fail closed even when the record remains valid JSON', (t) => {
  const { open, file } = fixture(t);
  const log = open(); log.append(user('original')); log.close();
  writeFileSync(file, readFileSync(file, 'utf8').replace('original', 'tampered'));
  assert.throws(() => open(), /checksum/);
});

test('log writers reject symlinks, hardlinks, and replaced paths', (t) => {
  const { open, file, root } = fixture(t);
  const log = open(); log.append(user('safe'));
  renameSync(file, join(root, 'old.jsonl'));
  writeFileSync(file, 'unrelated');
  assert.throws(() => log.append(user('late')), /replaced/);
  assert.throws(() => log.serialize(), /replaced/);
  rmSync(file); symlinkSync(join(root, 'old.jsonl'), file);
  assert.throws(() => open());
  rmSync(file); linkSync(join(root, 'old.jsonl'), file);
  assert.throws(() => open(), /outside managed storage/);
});

test('compaction and context edits change model context without deleting conversation history', (t) => {
  const { open } = fixture(t);
  const log = open();
  log.append(user('old context'));
  const keep = log.append(user('recent context'));
  log.append({ type: 'compaction', summary: 'Summary', keepFromId: keep.id, tokensBefore: 100 });
  log.append({ type: 'context-edit', targetId: keep.id, replacement: 'redacted recent context' });
  log.append(user('new question'));
  assert.deepEqual(log.projection().messages.map(({ content }) => content), ['old context', 'recent context', 'new question']);
  assert.deepEqual(log.projection().contextMessages.map(({ content }) => content), [
    'Summary of earlier conversation:\nSummary', 'redacted recent context', 'new question'
  ]);
  assert.equal(log.projection().contextEntryIds[1], keep.id);
  assert.equal(log.projection().contextEntryIds.length, log.projection().contextMessages.length);
});

test('attachments retain full model input while display keeps the submitted text and labels', (t) => {
  const { open } = fixture(t);
  const log = open();
  log.append({ ...user('read this\n\nAttached file: "secret.txt"\ncontents'),
    presentation: { userText: 'read this', attachments: [{ name: 'secret.txt', mimeType: 'text/plain' }] } });
  const state = log.projection();
  assert.equal(state.messages[0].content, 'read this');
  assert.equal(state.messages[0].attachments[0].name, 'secret.txt');
  assert.match(String(state.contextMessages[0].content), /contents/);
});
