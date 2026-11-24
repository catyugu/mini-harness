import { Workspace } from '@mini-harness/file-access/workspace';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { Inspection } from '../src/server/inspection.js';

import { fixture } from '../../../test/support/api-fixture.js';
test('Git inspection includes staged, unstaged and untracked files and refuses linked previews', async (t) => {
  const { paths, root } = await fixture(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: paths.cwd, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(paths.cwd, 'file.txt'), 'before\n'); git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(join(paths.cwd, 'file.txt'), 'staged\n'); git('add', '.'); writeFileSync(join(paths.cwd, 'file.txt'), 'after\n');
  writeFileSync(join(paths.cwd, 'new.txt'), 'new\n');
  const cwd = realpathSync.native(paths.cwd);
  const inspection = new Inspection(cwd, new Workspace(cwd, paths.home));
  const changes = await inspection.changes(); assert.equal(changes.available, true, JSON.stringify({ reason: changes.reason, workspace: paths.cwd, repository: git('rev-parse', '--show-toplevel').trim() })); assert.equal(changes.files.length, 2);
  const alias = join(root, 'workspace-alias'); symlinkSync(paths.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await new Inspection(alias, new Workspace(cwd, paths.home)).changes()).available, true, 'Directory aliases must resolve to the same repository root');
  const diff = await inspection.diff('file.txt'); assert.match(diff.content, /Staged/); assert.match(diff.content, /Working tree/);
  assert.match((await inspection.diff('new.txt')).content, /new/);
  writeFileSync(join(paths.cwd, 'file.txt'), 'modified change\n'.repeat(140000));
  const bounded = await inspection.diff('file.txt');
  assert.equal(bounded.truncated, true);
  assert.match(bounded.content, /\+modified change/);
  assert.ok(Buffer.byteLength(bounded.content) < 2 * 1024 * 1024);
  await assert.rejects(inspection.preview('../home/settings.json'));
  const nestedState = join(paths.cwd, 'private'); mkdirSync(nestedState); writeFileSync(join(nestedState, 'secret.txt'), 'private contents');
  git('add', '.'); git('commit', '-qm', 'track state for denial test'); rmSync(join(nestedState, 'secret.txt'));
  await assert.rejects(new Inspection(cwd, new Workspace(cwd, nestedState)).diff('private/secret.txt'));
  if (process.platform !== 'win32') {
    const outside = join(root, 'secret'); writeFileSync(outside, 'outside'); symlinkSync(outside, join(paths.cwd, 'link.txt'));
    await assert.rejects(inspection.preview('link.txt')); await assert.rejects(inspection.diff('link.txt'));
  }
});
