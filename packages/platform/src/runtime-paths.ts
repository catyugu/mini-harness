import type {} from 'mini-harness/cordis';

/** Runtime paths are data, not a dependency on the filesystem adapter. */
export interface Paths {
  home: string;
  cwd: string;
  settings: string;
  registry: string;
  sessions: string;
  pid: string;
  log: string;
  plugins: string;
  devPlugin?: string;
}

declare module 'mini-harness/cordis' {
  interface Context { harnessState: { paths: Paths } }
}
