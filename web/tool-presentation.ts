import type { ToolView } from './extensions.js';
import { textContent } from './session-projection.js';

export function toolPresentation(tool: ToolView) {
  const args = (tool.arguments && typeof tool.arguments === 'object' ? tool.arguments : {}) as Record<string, unknown>;
  const output = textContent({ content: tool.content ?? '' });
  const path = typeof args.path === 'string' ? args.path : undefined;
  let kind: 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'generic' = 'generic';
  if (/^(sandbox_shell|bash|powershell|terminal)$/.test(tool.name)) kind = 'terminal';
  else if (/^(edit|write|apply_patch)$/.test(tool.name)) kind = 'diff';
  else if (/^(read|read_file)$/.test(tool.name)) kind = 'read';
  else if (/^(grep|find|ls|search)$/.test(tool.name)) kind = 'search';
  else if (/^(web|fetch|web_search|browse)$/.test(tool.name)) kind = 'web';
  const actions = { terminal: 'Run command', diff: tool.name === 'write' ? 'Write file' : 'Edit file', read: 'Read file', search: 'Search', web: 'Open web resource', generic: tool.name.replaceAll('_', ' ') };
  const detail = kind === 'terminal' ? args.command : path ?? args.pattern ?? args.query ?? args.url;
  let exitCode: number;
  let terminalText: string;
  if (kind === 'terminal') try {
    const result = JSON.parse(output);
    if (typeof result.code === 'number' && Number.isInteger(result.code)) exitCode = result.code;
    terminalText = [result.reason, result.stdout, result.stderr].filter((part) => typeof part === 'string' && part).join('\n');
  } catch { /* Unstructured plugin output uses the generic output. */ }
  const details = tool.details as { diff?: unknown } | undefined;
  const diff = typeof details?.diff === 'string' ? details.diff : undefined;
  const added = diff?.split('\n').filter((line) => /^\+[^+]/.test(line)).length;
  const removed = diff?.split('\n').filter((line) => /^-[^-]/.test(line)).length;
  return { kind, diff, added, removed, icon: kind === 'terminal' ? 'terminal' : kind === 'diff' ? 'edit' : kind === 'read' ? 'file-text' : kind === 'search' ? 'search' : kind === 'web' ? 'globe' : 'plugin',
    title: actions[kind], summary: typeof detail === 'string' ? detail.slice(0, 180) : '', path, output, exitCode, terminalText } as const;
}
