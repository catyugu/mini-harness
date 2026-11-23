import {
  createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, truncateHead
} from '@earendil-works/pi-coding-agent';
import type { WorkspaceFileAccess } from '../contracts/files.js';

export function fileTools(cwd: string, files: WorkspaceFileAccess) {
  const readFile = (path: string) => files.readFile(path);
  const access = (path: string) => files.access(path);
  const exists = async (path: string) => { await files.stat(path); return true; };
  const find = createFindToolDefinition(cwd, { operations: {
    exists, glob: (pattern, root, { limit }) => files.find(pattern, root, limit)
  } });
  const grep = createGrepToolDefinition(cwd);
  return [
    createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: (path) => files.imageType(path),
      createReadStream: (path, { signal }) => files.chunks(path, signal) } }),
    createEditToolDefinition(cwd, { operations: { readFile, access, writeFile: (path, content) => files.writeFile(path, content, false) } }),
    createWriteToolDefinition(cwd, { operations: { writeFile: (path, content) => files.writeFile(path, content),
      mkdir: (path) => files.mkdir(path) } }),
    createLsToolDefinition(cwd, { operations: {
      exists, stat: (path) => files.stat(path), readdir: async (path) => (await files.entries(path)).map(({ name }) => name)
    } }),
    { ...find, description: 'Find files and directories matching a glob in the workspace. Respects .gitignore and skips links.',
      promptSnippet: 'Find files by workspace glob' },
    { ...grep, description: 'Search workspace text files with a literal or RE2 pattern. Respects .gitignore and skips links.',
      promptSnippet: 'Search text files in the workspace',
      async execute(_id: string, input: Parameters<typeof grep.execute>[1], signal?: AbortSignal) {
        const { matches, limited } = await files.grep(input, signal);
        const result = truncateHead(matches.join('\n'));
        return { content: [{ type: 'text' as const, text: (result.content || 'No matches found') +
          (result.truncated || limited ? '\n[Results limited]' : '') }], details: undefined };
      }
    }
  ];
}
