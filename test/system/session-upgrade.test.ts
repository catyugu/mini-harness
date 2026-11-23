import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SessionRegistry } from '../../packages/sessions/registry.js';
import { WorkspaceCatalog } from '../../packages/workspaces/catalog.js';
import { getPaths, writeJson } from '../../packages/platform/config.js';

function fixture(t: test.TestContext, version: 2 | 0 = 2) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mini-harness-import-')));
  const paths = getPaths(root, { MINI_HARNESS_HOME: join(root, 'home') });
  const registry = new SessionRegistry(paths, new WorkspaceCatalog(paths));
  const parent = registry.create({ title: 'Existing conversation' });
  const child = registry.create({ parentId: parent.id, title: 'Child' });
  const target = registry.nativeFile(parent);
  const source = join(dirname(target), 'old-transcript.jsonl');
  const timestamp = '2026-11-01T00:00:00.000Z';
  const records = [
    { type: 'session', version: 3, id: parent.id, timestamp, cwd: root },
    { type: 'model_change', id: '11111111', parentId: null, timestamp, provider: 'provider', modelId: 'model' },
    { type: 'thinking_level_change', id: '22222222', parentId: '11111111', timestamp, thinkingLevel: 'high' },
    { type: 'custom', customType: 'mini-harness:input', id: '33333333', parentId: '22222222', timestamp,
      data: { userTextLength: 8, attachments: [{ name: 'notes.txt', mimeType: 'text/plain' }] } },
    { type: 'message', id: '44444444', parentId: '33333333', timestamp,
      message: { role: 'user', content: 'question\n\nAttached file: "notes.txt"\nfile contents', timestamp: 1 } },
    { type: 'message', id: '55555555', parentId: '44444444', timestamp,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason', thinkingSignature: 'signature' },
        { type: 'text', text: 'Old answer' }], provider: 'provider', model: 'model', api: 'provider-api', responseId: 'response',
      stopReason: 'stop', timestamp: 2 } },
    { type: 'message', id: '66666666', parentId: '22222222', timestamp,
      message: { role: 'user', content: 'Revised question', timestamp: 3 } },
    { type: 'custom', id: '77777777', parentId: '66666666', timestamp, customType: 'mini-harness:example', data: { saved: true } }
  ];
  writeFileSync(source, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const previous = (record: typeof parent, ref: string | null) => version === 2 ? { ...record, piSessionRef: ref } :
    { ...record, titleSource: undefined, file: ref, run: record.id === parent.id ? run : undefined };
  const run = { id: 'old-run', sessionId: parent.id, state: 'running', startedAt: timestamp, sequence: 9 };
  writeJson(paths.registry, { ...(version === 2 ? { version } : {}), sessions: [previous(parent, source), previous(child, null)] });
  if (version === 2) writeJson(join(paths.home, 'runs.json'), { [parent.id]: run });
  registry.dispose();
  const opened: SessionRegistry[] = [];
  const restore = () => {
    const restored = new SessionRegistry(paths, new WorkspaceCatalog(paths));
    opened.push(restored); return restored;
  };
  t.after(() => { for (const item of opened) item.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, paths, parent, child, source, target, restore };
}

test('one-time native import preserves all branches and signatures, recovers runs, and removes old sources', (t) => {
  const { paths, parent, child, source, target, restore } = fixture(t);
  const restored = restore();
  assert.deepEqual(restored.descendants([parent.id]), [parent.id, child.id]);
  const log = restored.log(parent.id);
  const state = log.projection();
  assert.deepEqual(state.messages.map(({ content }) => content), ['Revised question']);
  assert.equal(state.thinkingLevel, 'high');
  assert.deepEqual(state.model, { provider: 'provider', id: 'model' });
  assert.equal(state.run.state, 'interrupted');
  assert.equal(log.branch('55555555').length, 5);
  const oldAssistant = log.entries().find((entry) => entry.id === '55555555');
  assert.ok(oldAssistant.type === 'message' && oldAssistant.message.role === 'assistant');
  assert.deepEqual(oldAssistant.message.providerData, { api: 'provider-api', responseId: 'response' });
  assert.equal(oldAssistant.message.content[0].type, 'thinking');
  assert.equal((oldAssistant.message.content[0] as any).thinkingSignature, 'signature');
  const input = log.entries().find((entry) => entry.id === '44444444');
  assert.ok(input.type === 'message');
  assert.deepEqual(input.presentation, { userText: 'question', attachments: [{ name: 'notes.txt', mimeType: 'text/plain' }] });
  const custom = log.entries().find((entry) => entry.id === '77777777');
  assert.ok(custom.type === 'custom'); assert.equal(custom.namespace, 'example');
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(join(paths.home, 'runs.json')), false);
  const index = JSON.parse(readFileSync(paths.registry, 'utf8'));
  assert.equal(index.version, 3);
  assert.deepEqual(Object.keys(index.sessions[0]).sort(), ['createdAt', 'id', 'parentId', 'title', 'titleSource', 'workspaceId']);
  const bytes = readFileSync(target, 'utf8');
  restored.dispose();
  assert.equal(restore().log(parent.id).entries().length, log.entries().length);
  assert.equal(readFileSync(target, 'utf8'), bytes);
});

test('unversioned indexes migrate directly to native logs without an intermediate runtime', (t) => {
  const { parent, restore, source } = fixture(t, 0);
  const restored = restore();
  assert.equal(restored.log(parent.id).projection().run.state, 'interrupted');
  assert.equal(restored.get(parent.id).titleSource, 'manual');
  assert.equal(existsSync(source), false);
});

test('a fault before index cutover leaves sources and resumes without duplicating imported records', (t) => {
  const { paths, source, target, parent, restore } = fixture(t);
  const originalRename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', ((from: string, to: string) => {
    if (to === paths.registry) throw new Error('injected index write failure');
    return originalRename(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
  try { assert.throws(() => restore(), /injected index/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(target), true);
  assert.equal(JSON.parse(readFileSync(paths.registry, 'utf8')).version, 2);
  const restored = restore();
  const entries = restored.log(parent.id).entries();
  assert.equal(entries.filter((entry) => entry.type === 'message').length, 3);
  assert.equal(entries.filter((entry) => entry.type === 'run').length, 2);
  assert.equal(existsSync(source), false);
});

test('a fault after index cutover finishes the durable source cleanup journal on restart', (t) => {
  const { paths, source, parent, restore } = fixture(t);
  const originalUnlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', ((file: string) => {
    if (file === source) throw new Error('injected source cleanup failure');
    return originalUnlink(file);
  }) as typeof fs.unlinkSync);
  syncBuiltinESMExports();
  try { assert.throws(() => restore(), /injected source/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const committed = JSON.parse(readFileSync(paths.registry, 'utf8'));
  assert.equal(committed.version, 3);
  assert.equal(committed.pendingCleanup.length, 1);
  assert.equal(existsSync(source), true);
  const restored = restore();
  assert.equal(restored.log(parent.id).projection().run.state, 'interrupted');
  assert.equal(existsSync(source), false);
  assert.equal(JSON.parse(readFileSync(paths.registry, 'utf8')).pendingCleanup, undefined);
});

test('corrupt complete source records abort migration before replacing the catalog or deleting history', (t) => {
  const { paths, source, restore } = fixture(t);
  const before = readFileSync(paths.registry, 'utf8');
  writeFileSync(source, readFileSync(source, 'utf8') + '{bad complete record}\n');
  assert.throws(() => restore(), /corrupt session transcript/);
  assert.equal(readFileSync(paths.registry, 'utf8'), before);
  assert.equal(existsSync(source), true);
});

test('format 1 transcript import preserves an indexed compaction boundary', (t) => {
  const { parent, source, restore } = fixture(t);
  const timestamp = '2026-11-01T00:00:00.000Z';
  const entries = [
    { type: 'session', version: 1, id: parent.id, timestamp },
    { type: 'message', timestamp, message: { role: 'user', content: 'summarized', timestamp: 1 } },
    { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'old response' }], timestamp: 2 } },
    { type: 'message', timestamp, message: { role: 'user', content: 'keep this turn', timestamp: 3 } },
    { type: 'compaction', timestamp, summary: 'Earlier work', firstKeptEntryIndex: 3, tokensBefore: 100 }
  ];
  writeFileSync(source, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const projection = restore().log(parent.id).projection();
  assert.equal(projection.messages.length, 3);
  assert.deepEqual(projection.contextMessages.map(({ content }) => content), [
    'Summary of earlier conversation:\nEarlier work', 'keep this turn'
  ]);
});
