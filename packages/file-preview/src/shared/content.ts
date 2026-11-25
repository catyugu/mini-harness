export type PreviewContent =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'bytes'; data: string; mimeType: string }
  | { kind: 'binary' }
  | { kind: 'directory' };

export const textLimit = 512 * 1024;
export const workspaceReadLimit = 16 * 1024 * 1024;
export const imageMime = /^image\/(?:png|jpeg|gif|webp|avif)$/;
export const videoMime = /^video\/(?:mp4|webm|ogg|quicktime|x-m4v)$/;
export const extension = (name: string) =>
  name
    .split('/')
    .at(-1)
    ?.match(/\.([^.]*)$/)?.[1]
    .toLowerCase() ?? '';
export const codeExtensions = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'py',
  'rs',
  'go',
  'c',
  'cpp',
  'h',
  'hpp',
  'java',
  'cs',
  'css',
  'html',
  'json',
  'yaml',
  'yml',
  'toml',
  'sh',
  'sql',
]);

const mediaByExtension: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
};

export function mediaType(name: string, mimeType = '') {
  const type = mimeType.toLowerCase();
  if (imageMime.test(type) || videoMime.test(type)) return type;
  return Object.hasOwn(mediaByExtension, extension(name)) ? mediaByExtension[extension(name)] : undefined;
}

export function decodeText(bytes: Uint8Array) {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: bytes.length === textLimit });
  } catch {
    return undefined;
  }
}
