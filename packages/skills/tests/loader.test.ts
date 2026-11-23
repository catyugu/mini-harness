import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLoader, parseSkill } from '../loader.js';

test('skills resolve workspace overrides and expand explicit commands without losing task arguments', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), cwd = join(root, 'project');
  const local = join(cwd, '.mini-harness', 'skills');
  const skill = (base: string, name: string, instructions: string) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  Review the task\n  with care\n---\n${instructions}`);
  };
  skill(home, 'review', 'Home instructions');
  skill(local, 'review', 'Workspace instructions');
  skill(home, 'other', 'Other instructions');
  const loader = new SkillLoader(home);
  assert.deepEqual((await loader.discover(cwd)).map(({ name }) => name), ['other', 'review']);
  assert.equal((await loader.discover(cwd)).find(({ name }) => name === 'review').description, 'Review the task with care');
  const expanded = await loader.expand(cwd, '/skill:review inspect this change\nand the tests');
  assert.match(expanded, /Workspace instructions/);
  assert.doesNotMatch(expanded, /Home instructions/);
  assert.match(expanded, /inspect this change\nand the tests$/);
  assert.equal(await loader.expand(cwd, 'ordinary prompt'), 'ordinary prompt');
  await assert.rejects(loader.expand(cwd, '/skill:missing'), /Unknown skill/);
  assert.match(await loader.prompt(cwd), /load_skill/);
});

test('skill discovery excludes links, oversized files and invalid frontmatter', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'), outside = join(root, 'private');
  mkdirSync(skills); mkdirSync(outside);
  writeFileSync(join(outside, 'SKILL.md'), '---\nname: private\ndescription: Secret\n---\nSecret instructions');
  symlinkSync(outside, join(skills, 'linked'), 'junction');
  mkdirSync(join(skills, 'large'));
  writeFileSync(join(skills, 'large', 'SKILL.md'), '---\nname: large\ndescription: Too big\n---\n' + 'x'.repeat(129 * 1024));
  assert.deepEqual(await new SkillLoader(skills).discover(join(root, 'project')), []);
  assert.equal(parseSkill('---\nname: ../bad\ndescription: Bad\n---\nx', 'bad'), undefined);
  assert.equal(parseSkill('no frontmatter', 'bad'), undefined);
});

test('configured skill roots and their configuration parents cannot redirect discovery through links', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-roots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateHome = join(root, 'private-home'), privateProject = join(root, 'private-project');
  const cwd = join(root, 'workspace'), home = join(root, 'linked-home');
  mkdirSync(privateHome); mkdirSync(join(privateProject, 'skills'), { recursive: true }); mkdirSync(cwd);
  const content = '---\nname: private\ndescription: Must not be loaded\n---\nPrivate instructions';
  writeFileSync(join(privateHome, 'SKILL.md'), content);
  writeFileSync(join(privateProject, 'skills', 'SKILL.md'), content);
  symlinkSync(privateHome, home, 'junction');
  symlinkSync(privateProject, join(cwd, '.mini-harness'), 'junction');
  assert.deepEqual(await new SkillLoader(home).discover(cwd), []);
});

test('a skill that grows after opening is rejected with an actual bounded read', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-growth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'); mkdirSync(skills);
  const file = join(skills, 'SKILL.md');
  writeFileSync(file, '---\nname: growing\ndescription: Changes during reading\n---\nInitial content');
  const originalOpen = fs.promises.open;
  let readBytes = 0;
  const mock = t.mock.method(fs.promises, 'open', (async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === file) {
      const originalStat = handle.stat.bind(handle), originalRead = handle.read.bind(handle);
      let grew = false;
      t.mock.method(handle, 'stat', (async () => {
        const stat = await originalStat();
        if (!grew) { appendFileSync(file, 'x'.repeat(512 * 1024)); grew = true; }
        return stat;
      }) as typeof handle.stat);
      t.mock.method(handle, 'read', (async (...readArgs: any[]) => {
        const result = await (originalRead as any)(...readArgs);
        readBytes += result.bytesRead;
        return result;
      }) as typeof handle.read);
    }
    return handle;
  }) as typeof fs.promises.open);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await new SkillLoader(skills).discover(join(root, 'workspace')), []);
    assert.ok(readBytes > 0 && readBytes <= 128 * 1024 + 1, 'Reading must remain bounded after the size check races a writer');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('large directories have a bounded discovery budget and their iterators are closed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'); mkdirSync(skills);
  let inspected = 0, closed = false;
  const mock = t.mock.method(fs.promises, 'opendir', (async () => {
    return (async function* () {
      try {
        for (let index = 0; index < 100000; index++) {
          inspected++;
          yield { name: 'irrelevant-' + index, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
        }
      } finally { closed = true; }
    })();
  }) as any);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await new SkillLoader(skills).discover(join(root, 'workspace')), []);
    assert.ok(inspected > 0 && inspected < 10000, 'Discovery must stop before exhausting an oversized directory');
    assert.equal(closed, true);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
