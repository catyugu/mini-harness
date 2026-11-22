import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createFixturePaths } from './helpers/mock-provider.js';
import { harnessSkillOptions, loadHarnessSkills } from '../src/skill-sources.js';

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
  assert.equal(homedir(), process.env.MINI_HARNESS_TEST_HOME, 'Use npm test to isolate HOME before running Skill discovery tests');
  const userSkill = join(homedir(), '.agents', 'skills');
  skill(userSkill, 'user-fixture', 'User instructions');
  skill(userSkill, 'shared', 'User shared instructions');
  skill(userSkill, 'native-project', 'User native instructions');
  skill(paths.skills, 'native-project', 'Application native instructions');
  skill(join(paths.cwd, '.agents', 'skills'), 'native-project', 'Workspace native instructions');
  t.after(() => {
    for (const name of ['user-fixture', 'shared', 'native-project']) rmSync(join(userSkill, name), { recursive: true, force: true });
  });
  const loaded = await loadHarnessSkills(paths, paths.cwd);
  assert.deepEqual(loaded.skills.filter(({ name }) => name === 'shared').map(({ name, description }) => ({ name, description })),
    [{ name: 'shared', description: 'Workspace instructions' }]);
  assert.ok(loaded.skills.some(({ name }) => name === 'user-fixture'));
  assert.equal(loaded.skills.find(({ name }) => name === 'native-project').description, 'Workspace native instructions');
  assert.ok(loaded.diagnostics.length > 0, 'Name collision is reported');
  const second = join(root, 'second');
  mkdirSync(second);
  assert.equal((await loadHarnessSkills(paths, second)).skills.find(({ name }) => name === 'shared').description, 'Global instructions');
  rmSync(join(paths.skills, 'shared'), { recursive: true });
  assert.equal((await loadHarnessSkills(paths, second)).skills.find(({ name }) => name === 'shared').description, 'User shared instructions');
});


test('skill precedence survives collision diagnostics without structured metadata', (t) => {
  const { root, paths } = createFixturePaths('http://127.0.0.1');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(paths.cwd, '.mini-harness', 'skills');
  skill(paths.skills, 'duplicate', 'Global instructions');
  skill(project, 'duplicate', 'Project instructions');
  const native = loadSkills({ cwd: paths.cwd, agentDir: paths.agent, includeDefaults: false, skillPaths: [paths.skills, project] });
  assert.equal(native.skills[0].description, 'Global instructions');
  const options = harnessSkillOptions(paths, paths.cwd);
  const overridden = options.skillsOverride({
    ...native, diagnostics: native.diagnostics.map(({ type, path, message }) => ({ type, path, message }))
  });
  assert.equal(overridden.skills[0].description, 'Project instructions');
  assert.deepEqual(overridden.diagnostics.find(({ type }) => type === 'collision')?.collision, {
    resourceType: 'skill', name: 'duplicate', winnerPath: join(project, 'duplicate', 'SKILL.md'),
    loserPath: join(paths.skills, 'duplicate', 'SKILL.md')
  });
});
