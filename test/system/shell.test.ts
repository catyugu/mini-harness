import { runTool } from '@mini-harness/tools/execution';
import { sendRun } from '../support/runs.ts';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, waitUntil } from '../support/api-fixture.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StreamEvent } from '@mini-harness/runs/stream';
import { realpath } from 'node:fs/promises';

test('enabled Shell runs consecutive commands without approval and respects read-only ancestry', async (t) => {
  const { app, mock, request, finish } = await fixture(t, ({ messages }) =>
    messages.filter(({ role }) => role === 'user').at(-1)?.content === 'Run twice' &&
    messages.filter(({ role }) => role === 'tool').length < 2
      ? { tool: 'shell', args: { command: 'echo permitted' } }
      : 'Done',
  );
  await app.runtime.configuration.update({ entries: { shell: { disabled: false } } });
  const ctx = app.runtime.plugins.ctx;
  const { body: session } = await request('/sessions', 'POST', {});
  await request('/sessions/' + session.id + '/runs', 'POST', { message: 'Run twice' });
  assert.equal((await finish(session.id)).body.run.state, 'completed');
  assert.deepEqual((await request('/approvals')).body, []);
  const history = (await request('/sessions/' + session.id)).body.timeline;
  const results = history.filter((message: { role: string }) => message.role === 'toolResult');
  assert.equal(results.length, 2);
  assert.ok(
    results.every(
      (result: { details: { exitCode: number }; toolState: string }) =>
        result.details.exitCode === 0 && result.toolState === 'finished',
    ),
  );
  assert.equal(
    (await request('/sessions/' + session.id + '/permissions', 'PATCH', { permission: 'readOnly' })).status,
    200,
  );
  const child = ctx.harnessSessions.create({ parentId: session.id, permission: 'fullAccess' });
  const advertised = async (id: string) => {
    await sendRun(ctx.harnessRuns, id, 'Inspect available tools');
    return JSON.stringify(mock.requests.at(-1)?.tools ?? []);
  };
  for (const id of [session.id, child.id]) {
    const tools = await advertised(id);
    assert.match(tools, /"name":"read"/);
    assert.doesNotMatch(tools, /"name":"(?:shell|write)"/);
  }
  const sibling = ctx.harnessSessions.create();
  assert.match(await advertised(sibling.id), /"name":"shell"/);
  await app.runtime.configuration.update({ entries: { shell: { disabled: true } } });
  assert.doesNotMatch(await advertised(sibling.id), /"name":"shell"/);
});

test('Shell preserves native workspace and environment', async (t) => {
  const { app, paths } = await fixture(t);
  const ctx = app.runtime.plugins.ctx;
  await app.runtime.configuration.update({ entries: { shell: { disabled: false } } });
  const previous = process.env.MINI_HARNESS_TEST_ENV;
  process.env.MINI_HARNESS_TEST_ENV = 'native-environment';
  t.after(() => {
    if (previous === undefined) delete process.env.MINI_HARNESS_TEST_ENV;
    else process.env.MINI_HARNESS_TEST_ENV = previous;
  });
  const { id } = ctx.harnessSessions.create();
  const tool = expectPresent(
    ctx.harnessTools
      .list({ resourceId: id, scope: ctx.harnessSessions.runScope(id) })
      .find(({ name }) => name === 'shell'),
    'shell',
  );
  const result = await runTool(tool, 'native-environment', {
    command: 'node -e "console.log(JSON.stringify([process.cwd(), process.env.MINI_HARNESS_TEST_ENV]))"',
  });
  assert.equal(result.state, 'finished');
  const [cwd, value] = JSON.parse(String(result.details?.stdout));
  assert.equal(await realpath(cwd), await realpath(paths.cwd));
  assert.equal(value, 'native-environment');
});

test('independent shell calls use one task, retain output channels and do not duplicate process output', async (t) => {
  const { app, request } = await fixture(t);
  const ctx = app.runtime.plugins.ctx;
  await app.runtime.configuration.update({
    entries: { shell: { disabled: false, config: { timeoutMs: 1000 } } },
  });
  const session = ctx.harnessSessions.create({ permission: 'fullAccess' });
  ctx.harnessRuns.stop(session.id);
  const tool = ctx.harnessTools
    .list({ resourceId: session.id, scope: ctx.harnessSessions.runScope(session.id) })
    .find(({ name }) => name === 'start_background');
  assert.ok(tool);
  const command = 'node -e "setTimeout(() => console.log(\'task-output\'), 1500)"';
  const receipt = await runTool(tool, 'background-shell', {
    tool: 'shell',
    arguments: { command, timeoutMs: 30000 },
  });
  const id = String(receipt.details?.workId);
  const base = '/sessions/' + session.id + '/background';
  const [{ result }] = await waitUntil(
    async () => (await request(base)).body,
    (items) => items[0]?.state === 'completed',
  );
  assert.equal(result.details.exitCode, 0);
  assert.equal(result.details.timeoutMs, 30000);
  const { body: output } = await request(base + '/' + id + '/output');
  assert.match(
    output.chunks
      .filter(({ channel }: { channel: string }) => channel === 'stdout')
      .map(({ text }: { text: string }) => text)
      .join(''),
    /task-output/,
  );
  assert.doesNotMatch(JSON.stringify(result), /task-output/);
  await ctx.harnessSessions.delete([session.id]);
  assert.equal((await request(base)).status, 404);
});

test('foreground Shell streams live output and commits one final result', async (t) => {
  const command =
    "node -e \"console.log('live-shell-output');const timer=setInterval(()=>{if(require('node:fs').existsSync('release-shell-test')){clearInterval(timer);console.error('final-shell-output')}},20)\"";
  const { app, paths, request } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Done' : { tool: 'shell', args: { command, timeoutMs: 15000 } },
  );
  await app.runtime.configuration.update({ entries: { shell: { disabled: false } } });
  const { harnessRuns: runs, harnessSessions: sessions } = app.runtime.plugins.ctx;
  const { id } = sessions.create();
  const events: StreamEvent[] = [];
  const work = sendRun(runs, id, 'Stream shell output', (event) => events.push(event));
  const release = () => writeFileSync(join(paths.cwd, 'release-shell-test'), '');
  try {
    await waitUntil(
      () => runs.activity(id).tools,
      (tools) => tools.some((tool) => tool.streams?.stdout?.includes('live-shell-output')),
    );
    const active = (await request('/sessions/' + id)).body;
    assert.match(active.tools[0].streams.stdout, /live-shell-output/);
    assert.ok(events.some((event) => event.type === 'tool-output' && event.channel === 'stdout'));
    release();
    assert.equal(await work, 'Done');
    const completed = (await request('/sessions/' + id)).body;
    assert.deepEqual(completed.tools, []);
    const results = completed.timeline.filter((entry: { role?: string }) => entry.role === 'toolResult');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].details, { exitCode: 0, timeoutMs: 15000 });
    assert.match(JSON.stringify(results[0].content), /final-shell-output/);
  } finally {
    release();
    await work.catch(() => {});
  }
});
