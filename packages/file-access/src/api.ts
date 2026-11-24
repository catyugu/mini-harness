import type {} from 'mini-harness/cordis';

export interface SearchInput {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  limit?: number;
  context?: number;
}

export interface FileAccessPort {
  open(workspaceId: string): WorkspaceFileAccess;
}

export interface WorkspaceFileAccess {
  validatePath(path: string): Promise<void>;
  searchFiles(query: string, signal?: AbortSignal): Promise<string[]>;
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string, create?: boolean, signal?: AbortSignal): Promise<void>;
  chunks(path: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  imageType(path: string): Promise<'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  entries(path?: string): Promise<{ name: string; directory: boolean }[]>;
  find(pattern: string, root: string, limit: number): Promise<string[]>;
  grep(input: SearchInput, signal?: AbortSignal): Promise<{ matches: string[]; limited: boolean }>;
}

declare module 'mini-harness/cordis' {
  interface Context { harnessFileAccess: FileAccessPort }
}
