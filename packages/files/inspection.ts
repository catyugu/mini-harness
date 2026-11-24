import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { DomainError } from '@mini-harness/platform/errors';
import { resolve, relative } from 'node:path';
import type { WorkspaceFileAccess } from '@mini-harness/contracts/files';

const diffLimit = 1024 * 1024;
const statusLimit = 8 * 1024 * 1024;

export class Inspection {
  constructor(private readonly cwd: string, readonly files: WorkspaceFileAccess, private readonly signal?: AbortSignal) {}
  async tree(path = '.') {
    return (await this.files.entries(resolve(this.cwd, path))).filter(({ name }) => name !== '.git');
  }
  async preview(path: string) {
    const bytes = await this.files.readFile(path);
    if (bytes.length > 512 * 1024) throw new DomainError('invalid_input', 'Preview is limited to 512 KiB');
    const image = await this.files.imageType(path);
    if (image) return { path, content: bytes.toString('base64'), image };
    if (bytes.includes(0)) throw new DomainError('invalid_input', 'Binary file: attach or open it in a local application');
    return { path, content: bytes.toString('utf8') };
  }

  private async git(args: string[], limit: number) {
    const timeout = AbortSignal.timeout(10000);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
      cwd: this.cwd, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
    });
    let failure: Error | undefined;
    child.on('error', (error) => { failure = error; });
    const closed = new Promise<number | null>((done) => { child.once('close', done); });
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    for await (const chunk of child.stdout) {
      const bytes: Buffer = chunk;
      const remaining = limit - length;
      const piece = bytes.subarray(0, remaining);
      if (piece.length) {
        chunks.push(piece);
        length += piece.length;
      }
      if (piece.length < bytes.length && !truncated) { truncated = true; child.kill(); }
    }
    const code = await closed;
    signal.throwIfAborted();
    if (failure || !truncated && code !== 0) throw new Error('Git command failed: ' + args[0], { cause: failure });
    return { content: Buffer.concat(chunks).toString('utf8'), truncated };
  }

  private async repository() {
    try {
      const [workspaceRoot, repositoryRoot] = await Promise.all([
        realpath(this.cwd),
        this.git(['rev-parse', '--show-toplevel'], 8192).then(({ content }) => realpath(content.trim()))
      ]);
      if (relative(workspaceRoot, repositoryRoot)) return 'Open the repository root to inspect Git changes.';
    } catch (error) {
      if (this.signal?.aborted) throw error;
      return 'Git is unavailable or this workspace is not a repository.';
    }
  }

  async changes() {
    const reason = await this.repository();
    if (reason) return { available: false, files: [], reason };
    try {
      const { content, truncated } = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], statusLimit);
      const records = content.split('\0');
      records.pop();
      const files: { path: string; status: string }[] = [];
      for (let index = 0; index < records.length; index++) {
        const entry = records[index];
        const status = entry.slice(0, 2);
        if (/[RC]/.test(status) && ++index >= records.length) break;
        files.push({ status, path: entry.slice(3) });
      }
      return { available: true, files, truncated };
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw new DomainError('unavailable', 'Git could not read the status for this workspace.', { cause: error });
    }
  }

  async diff(path: string) {
    await this.files.validatePath(path);
    const reason = await this.repository();
    if (reason) return { path, content: reason };
    try {
      const { content: status } = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path], 8192);
      if (!status) return { path, content: 'No Git changes for this file.' };
      const state = status.slice(0, 2);
      // Deleted files have no live target to validate.
      if (!state.includes('D')) await this.files.access(path);
      if (state === '??') {
        const chunks: Buffer[] = [];
        let remaining = diffLimit;
        let truncated = false;
        for await (const chunk of this.files.chunks(path, this.signal)) {
          const bytes = Buffer.from(chunk);
          const piece = bytes.subarray(0, remaining);
          if (piece.includes(0)) return { path, content: 'Binary file.' };
          chunks.push(piece);
          remaining -= piece.length;
          if (piece.length < bytes.length) { truncated = true; break; }
        }
        return { path, content: Buffer.concat(chunks).toString('utf8'), truncated };
      }
      const args = ['--no-ext-diff', '--no-textconv', '--no-color', '--', path];
      const [staged, unstaged] = await Promise.all([
        this.git(['diff', '--cached', ...args], diffLimit),
        this.git(['diff', ...args], diffLimit)
      ]);
      return { path, truncated: staged.truncated || unstaged.truncated,
        content: [staged.content && 'Staged\n' + staged.content, unstaged.content && 'Working tree\n' + unstaged.content]
          .filter(Boolean).join('\n') || 'Binary or metadata-only change.' };
    } catch (error) {
      if (this.signal?.aborted || error instanceof DomainError) throw error;
      throw new DomainError('unavailable', 'Git could not read the diff for this file.', { cause: error });
    }
  }
}
