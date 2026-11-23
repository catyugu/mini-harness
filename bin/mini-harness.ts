#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, closeSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { getPaths, ensurePaths, writeJson } from '@mini-harness/platform/config';
import { lockInstance, readServerInfo, requestShutdown, serverStatus } from '@mini-harness/host/process';

const executable = fileURLToPath(import.meta.url);

function help() {
  console.log(`mini-harness — minimal native agent harness

Usage:
  mini-harness [--port 3837]              Start the local web interface
  mini-harness --detached [--port 3837]   Run independently of this terminal
  mini-harness --no-open                 Start without opening a browser
  mini-harness status                    Show server status
  mini-harness stop                      Stop the running server
  mini-harness plugin install <id> <package[@version-or-tag]>
  mini-harness plugin update <id> [package[@version-or-tag]]
  mini-harness --help                    Show help

Configuration: ~/.mini-harness/settings.json (or MINI_HARNESS_HOME)
Workspace Skills: .mini-harness/skills/
Access: localhost only; bearer token required for all API endpoints.
`);
}

function parse(argv: string[]) {
  const args: { help?: boolean; noOpen?: boolean; detached: boolean; serve: boolean; cwd: string; port?: number; command?: 'status' | 'stop' } =
    { detached: false, serve: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--no-open') args.noOpen = true;
    else if (flag === '--detached') args.detached = true;
    else if (flag === '--serve') args.serve = true;
    else if (flag === '--cwd') {
      if (!argv[i + 1]) throw new Error('--cwd requires a value');
      args.cwd = resolve(argv[++i]);
    } else if (flag === '--port') {
      const number = Number(argv[++i]);
      if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error('Invalid port');
      args.port = number;
    } else if (flag === 'status' || flag === 'stop') {
      if (args.command) throw new Error('Specify one command');
      args.command = flag;
    } else throw new Error('Unknown option: ' + flag);
  }
  if (args.command && (args.detached || args.serve || args.port)) throw new Error('Server startup flags require the start command');
  return args;
}

async function detached(paths: ReturnType<typeof getPaths>, port?: number) {
  const running = await serverStatus(paths.home, paths.pid);
  if (running) throw new Error('mini-harness is already running (PID ' + running.pid + ')');
  const output = openSync(paths.log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [executable, '--serve', '--cwd', paths.cwd, ...(port ? ['--port', String(port)] : [])], {
      cwd: paths.cwd, detached: true, stdio: ['ignore', output, output], windowsHide: true
    });
  } finally { closeSync(output); }
  let failure: Error;
  child.on('error', (error) => { failure = error; });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (failure) throw failure;
    const info = readServerInfo(paths.pid);
    if (info?.pid === child.pid && await serverStatus(paths.home, paths.pid)) {
      console.log('mini-harness started independently (PID ' + child.pid + ')');
      console.log(info.url + '/#token=' + info.token);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  throw new Error('Detached server failed to become ready. See ' + paths.log);
}

async function serve(paths: ReturnType<typeof getPaths>, port?: number, open = false) {
  const unlock = await lockInstance(paths.home);
  let app: Awaited<ReturnType<typeof import('@mini-harness/host/server').createMiniHarnessServer>>;
  let ready: Promise<void>;
  let ending: Promise<void>;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    ending = (async () => {
      try { await ready?.catch(() => {}); await app?.close(); }
      finally {
        try { rmSync(paths.pid, { force: true }); }
        finally { await unlock(); }
      }
    })();
    ending.catch((error) => { console.error('mini-harness:', error.message); process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  ready = (async () => {
    rmSync(paths.pid, { force: true });
    const { createMiniHarnessServer } = await import('@mini-harness/host/server');
    app = await createMiniHarnessServer(paths, { shutdown });
    if (stopping) return;
    const listening = await app.listen(port);
    if (stopping) return;
    const url = 'http://127.0.0.1:' + listening;
    writeJson(paths.pid, { pid: process.pid, url, token: app.token, startedAt: new Date().toISOString() });
    const address = url + '/#token=' + app.token;
    console.log('mini-harness listening at ' + address);
    if (open) {
      const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', address] : [address], { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => {}); child.unref();
    }
  })();
  try {
    await ready;
  } catch (error) {
    shutdown();
    await ending;
    if (error.code === 'EADDRINUSE') throw new Error('The requested HTTP port is already in use. Choose another with --port.');
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'plugin') {
    const [, operation, id, spec, ...extra] = argv;
    if ((operation !== 'install' && operation !== 'update') || !id || extra.length || (operation === 'install' && !spec))
      throw new Error('Usage: mini-harness plugin install <id> <package> or mini-harness plugin update <id> [package]');
    const paths = getPaths();
    ensurePaths(paths);
    const unlock = await lockInstance(paths.home);
    try {
      const [{ installPackagedPlugin }, { plugins }] = await Promise.all([
        import('@mini-harness/plugins/package-installer'), import('@mini-harness/host/composition')
      ]);
      const { name, version } = await installPackagedPlugin(paths, operation, id, spec,
        (id) => plugins.some((plugin) => plugin.id === id));
      console.log(id + ': ' + name + '@' + version);
    } finally { await unlock(); }
    return;
  }
  const args = parse(argv);
  if (args.help) return help();
  const paths = getPaths(args.cwd);
  ensurePaths(paths);
  if (args.command) {
    const info = await serverStatus(paths.home, paths.pid);
    if (!info) {
      console.log('mini-harness is not running');
      if (args.command === 'status') process.exitCode = 1;
      return;
    }
    if (args.command === 'status') {
      console.log('mini-harness is running (PID ' + info.pid + ') at ' + info.url);
      return;
    }
    if (!await requestShutdown(info)) throw new Error('Could not request mini-harness shutdown');
    for (let i = 0; i < 100; i++) {
      if (readServerInfo(paths.pid)?.token !== info.token) {
        console.log('mini-harness stopped');
        return;
      }
      await sleep(100);
    }
    throw new Error('mini-harness is still shutting down');
  }
  if (args.detached && !args.serve) await detached(paths, args.port);
  else await serve(paths, args.port, !args.noOpen && !args.serve);
}

main().catch((error) => { console.error('mini-harness:', error.message); process.exitCode = 1; });
