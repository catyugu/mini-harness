import { dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition, type ToolResult } from '@mini-harness/tools/api';
import { FileTypeError, type FileReader, type RootedFileAccess } from '@mini-harness/file-access/api';
import { DomainError } from '@mini-harness/platform/errors';
import { WorkspaceSearch, readLimited } from './search.ts';

export const fileToolNames = ['read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
const outputLimit = 48 * 1024;
const pathSchema = Type.String({ minLength: 1, maxLength: 4096 });
const limitSchema = Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 }));
const textResult = (text: string, details?: Record<string, unknown>): ToolResult => ({
  state: 'finished',
  content: [
    {
      type: 'text',
      text: text.length > outputLimit ? text.slice(0, outputLimit) + '\n[Output truncated]' : text,
    },
  ],
  details,
});
function textFile(bytes: Buffer) {
  if (bytes.includes(0)) throw new Error('Binary files cannot be read or edited as text');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text files can be read or edited as text');
  }
}

function imageType(prefix: Buffer) {
  if (prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (prefix.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (/^GIF8[79]a/.test(prefix.toString('ascii', 0, 6))) return 'image/gif';
  if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

export function fileTools(
  cwd: string,
  access: () => RootedFileAccess,
  explicit: () => FileReader,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'read',
      label: 'Read',
      description:
        'Read the contents of a UTF-8 file or image. Use ls to list a directory. Text offsets are 1-based line numbers.',
      metadata: { guidance: ['Read files by absolute or workspace-relative path'] },
      parameters: Type.Object(
        { path: pathSchema, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: limitSchema },
        { additionalProperties: false },
      ),
      async execute({ path, offset = 1, limit = 2000 }, { signal }) {
        const files = explicit();
        signal.throwIfAborted();
        const bytes = await readLimited(files, path, undefined, signal).catch((error: unknown) => {
          if (error instanceof FileTypeError && error.kind === 'directory')
            throw new DomainError(
              'invalid_input',
              `Cannot read "${path}": the path is a directory. Use ls to list its contents.`,
              { cause: error },
            );
          throw error;
        });
        const mimeType = imageType(bytes.subarray(0, 12));
        signal.throwIfAborted();
        if (mimeType) {
          if (bytes.length > 6 * 1024 * 1024) throw new Error('Image exceeds the 6 MiB input limit');
          return {
            state: 'finished',
            content: [{ type: 'image', mimeType, data: bytes.toString('base64') }],
          };
        }
        const lines = textFile(bytes).split('\n');
        if (offset > lines.length) throw new Error('Offset exceeds file length (' + lines.length + ' lines)');
        const end = Math.min(lines.length, offset - 1 + limit);
        const result = lines.slice(offset - 1, end).join('\n');
        return textResult(
          result +
            (end < lines.length
              ? `\n[Showing lines ${offset}-${end} of ${lines.length}; use offset ${end + 1} to continue]`
              : ''),
        );
      },
    }),
    defineTool({
      name: 'write',
      label: 'Write',
      description: 'Create or replace a UTF-8 file inside the workspace. Creates parent directories.',
      metadata: { guidance: ['Write workspace files'] },
      parameters: Type.Object(
        { path: pathSchema, content: Type.String({ maxLength: 2 * 1024 * 1024 }) },
        { additionalProperties: false },
      ),
      async execute({ path, content }, { signal }) {
        const files = access();
        signal.throwIfAborted();
        await files.mkdir(dirname(resolve(cwd, path)));
        signal.throwIfAborted();
        await files.writeFile(path, content, true, signal);
        return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${path}`, { changedPath: path });
      },
    }),
    defineTool({
      name: 'edit',
      label: 'Edit',
      description:
        'Apply exact text replacements to a workspace file. Each oldText must occur exactly once. All edits are validated before writing.',
      metadata: { guidance: ['Edit workspace files with exact text replacements'] },
      parameters: Type.Object(
        {
          path: pathSchema,
          edits: Type.Array(
            Type.Object(
              {
                oldText: Type.String({ minLength: 1 }),
                newText: Type.String(),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 100 },
          ),
        },
        { additionalProperties: false },
      ),
      async execute({ path, edits }, { signal }) {
        const files = access();
        signal.throwIfAborted();
        let text = textFile(await readLimited(files, path, undefined, signal));
        for (const { oldText, newText } of edits) {
          const index = text.indexOf(oldText);
          if (index === -1) throw new Error('Text to replace was not found in ' + path);
          if (text.indexOf(oldText, index + 1) !== -1)
            throw new Error('Text to replace is ambiguous in ' + path + '; include more context');
          text = text.slice(0, index) + newText + text.slice(index + oldText.length);
        }
        signal.throwIfAborted();
        await files.writeFile(path, text, false, signal);
        return textResult(`Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${path}`, {
          changedPath: path,
        });
      },
    }),
    defineTool({
      name: 'ls',
      label: 'List',
      description: 'List directory entries by absolute or workspace-relative path.',
      parameters: Type.Object(
        { path: Type.Optional(pathSchema), limit: limitSchema },
        { additionalProperties: false },
      ),
      async execute({ path = '.', limit = 2000 }, { signal }) {
        const files = explicit();
        signal.throwIfAborted();
        const entries = await files.entries(path, signal);
        signal.throwIfAborted();
        return textResult(
          entries
            .slice(0, limit)
            .map(({ name, directory }) => name + (directory ? '/' : ''))
            .join('\n') || '(empty directory)',
        );
      },
    }),
    defineTool({
      name: 'find',
      label: 'Find',
      description:
        'Find workspace-relative paths matching a glob. Directories end with /. Respects .gitignore and skips links.',
      metadata: { guidance: ['Find files by workspace glob'] },
      parameters: Type.Object(
        {
          pattern: Type.String({ minLength: 1, maxLength: 4096 }),
          path: Type.Optional(pathSchema),
          limit: limitSchema,
        },
        { additionalProperties: false },
      ),
      async execute({ pattern, path = '.', limit = 1000 }, { signal }) {
        const files = access();
        signal.throwIfAborted();
        const matches = await new WorkspaceSearch(cwd, files).find(pattern, path, limit, signal);
        signal.throwIfAborted();
        return textResult(matches.join('\n') || 'No matches found');
      },
    }),
    defineTool({
      name: 'grep',
      label: 'Search',
      description:
        'Search workspace text files with a literal or RE2 pattern. Respects .gitignore and skips links.',
      metadata: { guidance: ['Search text files in the workspace'] },
      parameters: Type.Object(
        {
          pattern: Type.String({ minLength: 1, maxLength: 4096 }),
          path: Type.Optional(pathSchema),
          glob: Type.Optional(Type.String({ maxLength: 4096 })),
          literal: Type.Optional(Type.Boolean()),
          ignoreCase: Type.Optional(Type.Boolean()),
          limit: limitSchema,
          context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
        },
        { additionalProperties: false },
      ),
      async execute(input, { signal }) {
        const files = access();
        signal.throwIfAborted();
        const { matches, limited } = await new WorkspaceSearch(cwd, files).grep(input, signal);
        return textResult(
          (matches.join('\n') || 'No matches found') + (limited ? '\n[Results limited]' : ''),
        );
      },
    }),
  ];
}
