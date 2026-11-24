import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { moduleReferences } from './module-references.js';

// Retain the two SDKs' declaration dependencies without publishing private provider types.
const declarationRoot = resolve('dist/types');
const manifest: { exports: Record<string, { types: string }> } = JSON.parse(readFileSync('package.json', 'utf8'));
const publicDeclarations = new Set<string>();
function includeDeclaration(file: string) {
  if (!file.startsWith(declarationRoot + sep) || !file.endsWith('.d.ts'))
    throw new Error('SDK declaration is outside the published type directory: ' + file);
  if (publicDeclarations.has(file)) return;
  publicDeclarations.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const { literal: { text: specifier } } of moduleReferences(source)) {
    if (specifier.startsWith('.')) includeDeclaration(resolve(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
  }
}
for (const { types } of Object.values(manifest.exports)) includeDeclaration(resolve(types));
for (const entry of readdirSync(declarationRoot, { recursive: true, withFileTypes: true })) {
  const file = join(entry.parentPath, entry.name);
  if (entry.isFile() && !publicDeclarations.has(file)) rmSync(file);
}
