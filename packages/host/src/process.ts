import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { createServer, type ListenOptions } from 'node:net';
import { readInstanceCredential } from './instance-credential.js';
import { readJson } from '@mini-harness/platform/json';

export interface ServerInfo {
  pid: number;
  url: string;
  startedAt: string;
}

export function readServerInfo(file: string): ServerInfo | undefined {
  try {
    const info = readJson<ServerInfo | null>(file, null);
    if (
      info &&
      Number.isSafeInteger(info.pid) &&
      info.pid > 0 &&
      /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(info.url) &&
      typeof info.startedAt === 'string'
    )
      return info;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

export async function lockInstance(home: string) {
  const physicalHome = realpathSync(home);
  const hash = createHash('sha256')
    .update(process.platform === 'win32' ? physicalHome.toLowerCase() : physicalHome)
    .digest('hex');
  const fallback: ListenOptions = {
    host: '127.0.0.1',
    port: 49152 + (parseInt(hash.slice(0, 4), 16) % 16384),
  };
  if (process.platform === 'win32')
    return listenLock({ path: '\\\\.\\pipe\\mini-harness-' + hash.slice(0, 32) });
  if (process.platform === 'linux') {
    try {
      return await listenLock({ path: '\0mini-harness-' + hash.slice(0, 32) });
    } catch (error) {
      if (
        !['EACCES', 'EPERM', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  return listenLock(fallback);
}

async function listenLock(options: ListenOptions) {
  const lock = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((done, reject) => {
      lock.once('error', reject);
      lock.listen(options, () => {
        lock.off('error', reject);
        done();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw Object.assign(
        new Error('mini-harness is already running or starting for this configuration directory'),
        { code: 'EADDRINUSE' },
      );
    }
    throw error;
  }
  return () => new Promise<void>((done) => lock.close(() => done()));
}

async function request(info: ServerInfo & { token: string }, operation: 'status' | 'shutdown') {
  try {
    const response = await fetch(info.url + '/api/' + operation, {
      method: operation === 'status' ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + info.token },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    const data = (await response.json()) as {
      pid: number;
      sessionDiagnostics?: { id: string; message: string }[];
    };
    return data.pid === info.pid ? data : undefined;
  } catch {
    return;
  }
}

export async function serverStatus(home: string, file: string) {
  const info = readServerInfo(file);
  if (info) {
    const token = readInstanceCredential(home);
    const status = token && (await request({ ...info, token }, 'status'));
    if (status && token) return { ...info, token, sessionDiagnostics: status.sessionDiagnostics ?? [] };
  }
  // Only the owner of the OS lock may change metadata. During startup it may still be absent.
  let unlock: () => Promise<void>;
  try {
    unlock = await lockInstance(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return undefined;
    throw error;
  }
  try {
    rmSync(file, { force: true });
  } finally {
    await unlock();
  }
}

export function requestShutdown(info: ServerInfo & { token: string }) {
  return request(info, 'shutdown');
}
