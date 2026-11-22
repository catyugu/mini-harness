import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createFixturePaths } from './helpers/mock-provider.js';
import { loadHarnessSkills } from '../src/skill-sources.js';

const skill = (base: string, name: string, description: string) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions`);
};

test('Skills retain native user discovery and report deterministic source conflicts', async (t) => {
  const { root, paths } = createFixturePaths('http://127.0.0.1');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  skill(paths.skills, 'shared', 'Global instructions');
  skill(join(paths.cwd, '.mini-harness', 'skills'), 'shared', 'Workspace instructions');
  const userSkill = join(homedir(), '.agents', 'skills');
  skill(userSkill, 'user-fixture', 'User instructions');
  skill(userSkill, 'shared', 'User shared instructions');
  t.after(() => {
    for (const name of ['user-fixture', 'shared']) rmSync(join(userSkill, name), { recursive: true, force: true });
  });
  const loaded = await loadHarnessSkills(paths, paths.cwd);
  assert.deepEqual(loaded.skills.filter(({ name }) => name === 'shared').map(({ name, description }) => ({ name, description })),
    [{ name: 'shared', description: 'Workspace instructions' }]);
  assert.ok(loaded.skills.some(({ name }) => name === 'user-fixture'));
  assert.ok(loaded.diagnostics.length > 0, 'Name collision is reported');
  const second = join(root, 'second');
  mkdirSync(second);
  assert.equal((await loadHarnessSkills(paths, second)).skills.find(({ name }) => name === 'shared').description, 'Global instructions');
  rmSync(join(paths.skills, 'shared'), { recursive: true });
  assert.equal((await loadHarnessSkills(paths, second)).skills.find(({ name }) => name === 'shared').description, 'User shared instructions');
});
