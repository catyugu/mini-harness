import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { moduleReferences } from '../dist/scripts/module-references.js';

const prefix = '@mini-harness/';
const cordis = 'mini-harness/cordis';
const exportsByPackage = new Map(
  ['packages', 'vendor'].flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => [
        name,
        {
          directory,
          exports: JSON.parse(readFileSync(resolve(directory, name, 'package.json'), 'utf8')).exports,
        },
      ]),
  ),
);

function rewrite(file) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(prefix) && !original.includes(cordis)) return;
  const declaration = file.endsWith('.d.ts');
  const output = declaration ? 'dist/types' : 'dist';
  const ast = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const edits = [];
  for (const { literal } of moduleReferences(ast)) {
    if (literal.text !== cordis && !literal.text.startsWith(prefix)) continue;
    const [name, ...subpath] =
      literal.text === cordis ? ['cordis-runtime'] : literal.text.slice(prefix.length).split('/');
    const owner = exportsByPackage.get(name);
    const entry = owner?.exports?.[subpath.length ? './' + subpath.join('/') : '.'];
    if (!entry) throw new Error('Missing workspace export ' + literal.text + ' in ' + file);
    const target = resolve(output, owner.directory, name, entry.replace(/(?:\.d)?\.ts$/, '.js'));
    const emitted = declaration ? target.replace(/\.js$/, '.d.ts') : target;
    if (!existsSync(emitted)) throw new Error('Missing build output ' + emitted);
    const path = relative(dirname(file), target).split(sep).join('/');
    edits.push({
      from: literal.getStart(ast),
      to: literal.end,
      value: JSON.stringify(path.startsWith('.') ? path : './' + path),
    });
  }
  let content = original;
  for (const { from, to, value } of edits.reverse())
    content = content.slice(0, from) + value + content.slice(to);
  if (edits.length) writeFileSync(file, content);
}

function emit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) emit(path);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) rewrite(path);
  }
}
emit('dist');
