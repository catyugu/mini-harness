import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';
import { Workspace, containsPath } from './workspace.js';
const exec = promisify(execFile);
export class Inspection {
  readonly files: Workspace;
  constructor(private cwd: string, home: string) { this.files = new Workspace(cwd, home); }
  async tree(path = '.') {
    return (await this.files.entries(resolve(this.cwd, path))).filter(({ name }) => name !== '.git');
  }
  async preview(path: string) {
    const bytes = await this.files.readFile(path);
    if (bytes.length > 512 * 1024) throw new Error('Preview is limited to 512 KiB');
    if (bytes.includes(0)) throw new Error('Binary file: attach or open it in a local application');
    return { path, content: bytes.toString('utf8') };
  }
  private async git(args: string[]) {
    return (await exec('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
      cwd: this.cwd, timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
    })).stdout;
  }
  async changes() {
    try {
      if (relative(this.cwd, (await this.git(['rev-parse', '--show-toplevel'])).trim()))
        return { available: false, files: [], reason: 'Open the repository root to inspect Git changes.' };
      const records = (await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).split('\0');
      const files: { path: string; status: string }[] = [];
      for (let index = 0; index < records.length; index++) {
        const entry = records[index]; if (!entry) continue;
        files.push({ status: entry.slice(0, 2), path: entry.slice(3) });
        if (/[RC]/.test(entry.slice(0, 2))) ++index;
      }
      return { available: true, files };
    } catch { return { available: false, files: [], reason: 'Git is unavailable or this workspace is not a repository.' }; }
  }
  async diff(path: string) {
    if (!containsPath(this.cwd, resolve(this.cwd, path))) throw new Error('Path outside workspace');
    const changes = await this.changes();
    const file = changes.files.find((item) => item.path === path);
    if (!file) return { path, content: 'No Git changes for this file.' };
    // Check live files with the same access rules as the agent. Deleted files have no live target.
    if (!file.status.includes('D')) await this.files.access(path);
    const args = ['--no-ext-diff', '--no-textconv', '--no-color', '--', path];
    if (file.status === '??') return this.preview(path);
    const unstaged = await this.git(['diff', ...args]);
    const staged = await this.git(['diff', '--cached', ...args]);
    return { path, content: [staged && 'Staged\n' + staged, unstaged && 'Working tree\n' + unstaged].filter(Boolean).join('\n') || 'Binary or metadata-only change.' };
  }
}
