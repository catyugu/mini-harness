import { mediaType } from '../shared/content.ts';

interface FileLabel {
  name: string;
  mimeType: string;
  size?: number;
}

export type PreviewResource =
  | { kind: 'workspace'; workspaceId: string; path: string }
  | ({ kind: 'attachment'; workspaceId: string; sessionId: string; id: string } & FileLabel)
  | ({
      kind: 'memory';
      workspaceId: string;
      sessionId?: string;
      key: string;
      data: string;
      signal: AbortSignal;
    } & FileLabel);

export type PreviewPlacement = 'sidebar' | 'dialog';

declare module 'mini-harness/cordis' {
  interface Context {
    miniFilePreview: {
      open(resource: PreviewResource, placement: PreviewPlacement): void;
      thumbnail(
        resource: Exclude<PreviewResource, { kind: 'workspace' }>,
        image: HTMLImageElement,
        signal: AbortSignal,
      ): void;
    };
  }
}

export function attachmentPlacement(name: string, mimeType: string): PreviewPlacement {
  return mediaType(name, mimeType) ? 'dialog' : 'sidebar';
}
