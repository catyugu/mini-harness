import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLoader, defaultSkillRoots, parseSkill } from '../src/server/loader.ts';

const loaderFrom = (...roots: string[]) =>
  new SkillLoader(
    () => roots,
    (path, error) => {
      assert.fail('Unexpected skill diagnostic at ' + path + ': ' + String(error));
    },
  );

function writeSkill(directory: string, name: string, text: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >\n  Review the task\n  with care\n---\n${text}`,
  );
}

test('four default roots override by priority and keep the user home independent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    app = join(root, 'custom-app-home'),
    cwd = join(root, 'project');
  const paths = [
    join(home, '.agents', 'skills'),
    join(app, 'skills'),
    join(cwd, '.agents', 'skills'),
    join(cwd, '.mini-harness', 'skills'),
  ];
  const roots = defaultSkillRoots(app, home);
  assert.deepEqual(roots(cwd), paths);
  for (const [index, path] of paths.entries()) {
    writeSkill(join(path, 'review'), 'review', 'Instructions ' + index);
    writeSkill(join(path, 'skill-' + index), 'skill-' + index, 'Unique skill');
  }
  const loader = new SkillLoader(roots, () => assert.fail('Unexpected scan diagnostic'));
  assert.deepEqual(
    (await loader.list(cwd)).map(({ name }) => name),
    ['review', 'skill-0', 'skill-1', 'skill-2', 'skill-3'],
  );
  assert.equal((await loader.load(cwd, 'review')).description, 'Review the task with care');
  const invocation = await loader.invocation(cwd, 'Please /skill:review inspect the change');
  assert.equal(invocation?.task, 'Please inspect the change');
  assert.match(invocation?.instruction ?? '', /Instructions 3/);
  for (const [index, path] of [...paths.entries()].reverse()) {
    assert.equal((await loader.load(cwd, 'review')).content, 'Instructions ' + index);
    rmSync(path, { recursive: true });
  }
  assert.equal(await loader.invocation(cwd, 'ordinary prompt'), undefined);
  await assert.rejects(loader.invocation(cwd, '/skill:missing'), /Unknown skill/);
});

test('root, parent and directory links are followed once per file, including Windows junctions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  writeSkill(join(outside, 'nested'), 'linked', 'External instructions');
  const low = join(root, 'low'),
    high = join(root, 'high');
  mkdirSync(low);
  mkdirSync(high);
  symlinkSync(outside, join(low, 'direct'), 'junction');
  symlinkSync(outside, join(high, 'multiple'), 'junction');
  symlinkSync(join(high, 'multiple'), join(high, 'alias'), 'junction');
  symlinkSync(outside, join(outside, 'loop'), 'junction');
  const missing = join(root, 'gone');
  mkdirSync(missing);
  symlinkSync(missing, join(high, 'broken'), 'junction');
  rmSync(missing, { recursive: true });
  const linkedParent = join(root, 'linked-parent');
  symlinkSync(root, linkedParent, 'junction');
  const roots = [join(linkedParent, 'low'), join(linkedParent, 'high', 'multiple')];
  const loader = loaderFrom(...roots);
  const [skill] = await loader.discover(root);
  assert.deepEqual(
    (await loader.list(root)).map(({ name }) => name),
    ['linked'],
  );
  assert.equal(skill.root, roots[1]);
  assert.equal(skill.content, 'External instructions');
  if (process.platform !== 'win32') {
    const fileLink = join(root, 'file-link');
    mkdirSync(fileLink);
    symlinkSync(join(outside, 'nested', 'SKILL.md'), join(fileLink, 'SKILL.md'), 'file');
    const [linked] = await loaderFrom(...roots, fileLink).discover(root);
    assert.equal(linked.file, skill.file);
    assert.equal(linked.root, fileLink);
  }
});

test('skill discovery ignores oversized files and invalid frontmatter', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-size-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeSkill(join(root, 'large'), 'large', 'x'.repeat(129 * 1024));
  assert.deepEqual(await loaderFrom(root).discover(root), []);
  assert.equal(parseSkill('---\nname: ../bad\ndescription: Bad\n---\nx', 'bad'), undefined);
  assert.equal(parseSkill('no frontmatter', 'bad'), undefined);
});

test('a skill that grows after opening is rejected with an actual bounded read', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-growth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, 'skills');
  mkdirSync(skills);
  const file = join(skills, 'SKILL.md');
  writeFileSync(file, '---\nname: growing\ndescription: Changes during reading\n---\nInitial content');
  const expected = fs.statSync(file, { bigint: true });
  const originalOpen = fs.promises.open;
  let readBytes = 0,
    intercepted = false,
    grew = false;
  const mock = t.mock.method(fs.promises, 'open', (async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    // Windows temp roots can have short-name aliases while discovery opens the canonical path.
    // Match the opened file itself, so the race is injected regardless of path spelling.
    const identity = await handle.stat({ bigint: true });
    if (identity.dev === expected.dev && identity.ino === expected.ino) {
      intercepted = true;
      const originalStat = handle.stat.bind(handle),
        originalRead = handle.read.bind(handle);
      t.mock.method(handle, 'stat', (async () => {
        const stat = await originalStat();
        if (!grew) {
          appendFileSync(file, 'x'.repeat(512 * 1024));
          grew = true;
        }
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
    const discovered = await loaderFrom(skills).discover(join(root, 'workspace'));
    assert.equal(
      intercepted,
      true,
      'The opened skill file must be intercepted even through a canonical path',
    );
    assert.equal(grew, true, 'The fixture must grow the file after the open-file size check');
    assert.deepEqual(discovered, []);
    assert.ok(
      readBytes > 0 && readBytes <= 128 * 1024 + 1,
      'Reading must remain bounded after the size check races a writer',
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('large directories have a bounded discovery budget and their iterators are closed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-skill-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'),
    secondRoot = join(root, 'more-skills');
  mkdirSync(skills);
  mkdirSync(secondRoot);
  let inspected = 0,
    closed = false;
  const mock = t.mock.method(fs.promises, 'opendir', (async () => {
    return (async function* () {
      try {
        for (let index = 0; index < 100000; index++) {
          inspected++;
          yield {
            name: 'irrelevant-' + index,
            isSymbolicLink: () => false,
            isFile: () => true,
            isDirectory: () => false,
          };
        }
      } finally {
        closed = true;
      }
    })();
  }) as any);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await loaderFrom(secondRoot, skills).discover(join(root, 'workspace')), []);
    assert.ok(
      inspected > 0 && inspected < 10000,
      'Discovery must stop before exhausting an oversized directory',
    );
    assert.equal(closed, true);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
