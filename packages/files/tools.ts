import { dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition, type ToolResult } from '#mini-harness/contracts/tools.js';
import type { WorkspaceFileAccess } from '#mini-harness/contracts/files.js';

export const fileToolNames = ['read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
const outputLimit = 48 * 1024;
const pathSchema = Type.String({ minLength: 1, maxLength: 4096 });
const limitSchema = Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 }));
const textResult = (text: string, details?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: text.length > outputLimit ? text.slice(0, outputLimit) + '\n[Output truncated]' : text }], details
});
function textFile(bytes: Buffer) {
  if (bytes.includes(0)) throw new Error('Binary files cannot be read or edited as text');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Only UTF-8 text files can be read or edited as text'); }
}

/** All file operations stay behind WorkspaceFileAccess, including metadata and searches. */
export function fileTools(cwd: string, files: WorkspaceFileAccess): ToolDefinition[] {
  return [
    defineTool({
      name: 'read', label: 'Read', description: 'Read a UTF-8 file or image inside the workspace. Text offsets are 1-based line numbers.',
      promptSnippet: 'Read workspace files',
      parameters: Type.Object({ path: pathSchema, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: limitSchema }, { additionalProperties: false }),
      async execute(_id, { path, offset = 1, limit = 2000 }, signal) {
        signal?.throwIfAborted();
        const imageType = await files.imageType(path);
        const bytes = await files.readFile(path);
        signal?.throwIfAborted();
        if (imageType) {
          if (bytes.length > 6 * 1024 * 1024) throw new Error('Image exceeds the 6 MiB input limit');
          return { content: [{ type: 'image', mimeType: imageType, data: bytes.toString('base64') }] };
        }
        const lines = textFile(bytes).split('\n');
        if (offset > lines.length) throw new Error('Offset exceeds file length (' + lines.length + ' lines)');
        const end = Math.min(lines.length, offset - 1 + limit);
        const result = lines.slice(offset - 1, end).join('\n');
        return textResult(result + (end < lines.length ? `\n[Showing lines ${offset}-${end} of ${lines.length}; use offset ${end + 1} to continue]` : ''));
      }
    }),
    defineTool({
      name: 'write', label: 'Write', description: 'Create or replace a UTF-8 file inside the workspace. Creates parent directories.',
      promptSnippet: 'Write workspace files',
      parameters: Type.Object({ path: pathSchema, content: Type.String({ maxLength: 2 * 1024 * 1024 }) }, { additionalProperties: false }),
      async execute(_id, { path, content }, signal) {
        signal?.throwIfAborted();
        await files.mkdir(dirname(resolve(cwd, path)));
        signal?.throwIfAborted();
        await files.writeFile(path, content);
        return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${path}`, { changedPath: path });
      }
    }),
    defineTool({
      name: 'edit', label: 'Edit', description: 'Apply exact text replacements to a workspace file. Each oldText must occur exactly once. All edits are validated before writing.',
      promptSnippet: 'Edit workspace files with exact text replacements',
      parameters: Type.Object({ path: pathSchema, edits: Type.Array(Type.Object({
        oldText: Type.String({ minLength: 1 }), newText: Type.String()
      }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }),
      async execute(_id, { path, edits }, signal) {
        signal?.throwIfAborted();
        let text = textFile(await files.readFile(path));
        for (const { oldText, newText } of edits) {
          const index = text.indexOf(oldText);
          if (index === -1) throw new Error('Text to replace was not found in ' + path);
          if (text.indexOf(oldText, index + 1) !== -1) throw new Error('Text to replace is ambiguous in ' + path + '; include more context');
          text = text.slice(0, index) + newText + text.slice(index + oldText.length);
        }
        signal?.throwIfAborted();
        await files.writeFile(path, text, false);
        return textResult(`Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${path}`, { changedPath: path });
      }
    }),
    defineTool({
      name: 'ls', label: 'List', description: 'List workspace directory entries. Links and private harness state are excluded.',
      parameters: Type.Object({ path: Type.Optional(pathSchema), limit: limitSchema }, { additionalProperties: false }),
      async execute(_id, { path = '.', limit = 2000 }, signal) {
        signal?.throwIfAborted();
        const entries = await files.entries(resolve(cwd, path));
        signal?.throwIfAborted();
        return textResult(entries.slice(0, limit).map(({ name, directory }) => name + (directory ? '/' : '')).join('\n') || '(empty directory)');
      }
    }),
    defineTool({
      name: 'find', label: 'Find', description: 'Find files and directories matching a glob in the workspace. Respects .gitignore and skips links.',
      promptSnippet: 'Find files by workspace glob',
      parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 4096 }), path: Type.Optional(pathSchema), limit: limitSchema }, { additionalProperties: false }),
      async execute(_id, { pattern, path = '.', limit = 1000 }, signal) {
        signal?.throwIfAborted();
        const matches = await files.find(pattern, path, limit);
        signal?.throwIfAborted();
        return textResult(matches.join('\n') || 'No matches found');
      }
    }),
    defineTool({
      name: 'grep', label: 'Search', description: 'Search workspace text files with a literal or RE2 pattern. Respects .gitignore and skips links.',
      promptSnippet: 'Search text files in the workspace',
      parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 4096 }), path: Type.Optional(pathSchema),
        glob: Type.Optional(Type.String({ maxLength: 4096 })), literal: Type.Optional(Type.Boolean()), ignoreCase: Type.Optional(Type.Boolean()),
        limit: limitSchema, context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })) }, { additionalProperties: false }),
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        const { matches, limited } = await files.grep(input, signal);
        return textResult((matches.join('\n') || 'No matches found') + (limited ? '\n[Results limited]' : ''));
      }
    })
  ];
}
