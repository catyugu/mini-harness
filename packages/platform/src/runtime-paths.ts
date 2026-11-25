/** Runtime paths are data, not a dependency on the filesystem adapter. */
export interface Paths {
  home: string;
  cwd: string;
  registry: string;
  sessions: string;
  pid: string;
  log: string;
  plugins: string;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessState: { paths: Paths };
  }
}
