/** Feature-owned live projections subscribe without coupling the browser boot to their data. */
export interface BrowserProjection {
  sync(revision: number, reconnect: boolean, id?: string): Promise<void> | void;
}

export interface BrowserProjectionPort {
  register(domain: string, projection: BrowserProjection): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniProjections: BrowserProjectionPort;
  }
}
