#!/usr/bin/env node
import { bootProfile } from '@mini-harness/host/application';
import { allowsDetachment, loadProfile, readProfile } from '@mini-harness/host/profile';
import { Context } from 'mini-harness/cordis';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { getPaths, ensurePaths } from '@mini-harness/platform/paths';
import { lockInstance, readServerInfo, requestShutdown, serverStatus } from '@mini-harness/host/process';

import { instanceCredential } from '@mini-harness/host/instance-credential';

const executable = fileURLToPath(import.meta.url);

function help() {
  console.log(`mini-harness — minimal native agent harness

Usage:
  mini-harness [--profile web] [--port 3837]              Start the local web interface
  mini-harness --detached [--port 3837]   Run independently of this terminal
  mini-harness --no-open                 Start without opening a browser
  mini-harness status                    Show server status
  mini-harness stop                      Stop the running server
  mini-harness reset-token               Stop the server and replace its browser credential
  mini-harness plugin dev <directory>    Build and reload a plugin in an isolated host
  mini-harness plugin install <id> <package[@version-or-tag]>
  mini-harness plugin update <id> [package[@version-or-tag]]
  mini-harness --help                    Show help

Configuration: ~/.mini-harness/profiles/<profile>/cordis.yml (or MINI_HARNESS_HOME)
Workspace Skills: .mini-harness/skills/
Access: localhost only; bearer token required for all API endpoints.
`);
}

function parse(argv: string[]) {
  const args: {
    help?: boolean;
    detached: boolean;
    serve: boolean;
    cwd: string;
    profile: string;
    flags: string[];
    command?: 'status' | 'stop' | 'reset-token';
  } = { detached: false, serve: false, cwd: process.cwd(), profile: 'web', flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--detached') args.detached = true;
    else if (flag === '--serve') args.serve = true;
    else if (flag === '--cwd') {
      if (!argv[i + 1]) throw new Error('--cwd requires a value');
      args.cwd = resolve(argv[++i]);
    } else if (flag === '--profile') {
      if (!argv[i + 1]) throw new Error('--profile requires a name');
      args.profile = argv[++i];
    } else if (flag === 'status' || flag === 'stop' || flag === 'reset-token') {
      if (args.command) throw new Error('Specify one command');
      args.command = flag;
    } else args.flags.push(flag);
  }
  if (args.command && (args.detached || args.serve || args.flags.length))
    throw new Error('Server startup flags require the start command');
  return args;
}

async function detached(paths: ReturnType<typeof getPaths>, profile: string, flags: string[]) {
  if (!allowsDetachment(profile)) throw new Error('Profile ' + profile + ' does not support --detached');
  const running = await serverStatus(paths.home, paths.pid);
  if (running) throw new Error('mini-harness is already running (PID ' + running.pid + ')');
  const output = openSync(paths.log, 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [executable, '--serve', '--profile', profile, '--cwd', paths.cwd, ...flags],
      {
        cwd: paths.cwd,
        detached: true,
        stdio: ['ignore', output, output],
        windowsHide: true,
      },
    );
  } finally {
    closeSync(output);
  }
  let failure: Error | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (failure) throw failure;
    const info = readServerInfo(paths.pid);
    if (info && info.pid === child.pid) {
      const running = await serverStatus(paths.home, paths.pid);
      if (running?.pid === info.pid) {
        console.log('mini-harness started independently (PID ' + child.pid + ')');
        console.log(info.url + '/#token=' + running.token);
        return;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  throw new Error('Detached server failed to become ready. See ' + paths.log);
}

async function serve(
  paths: ReturnType<typeof getPaths>,
  profile: string,
  flags: string[],
  detached: boolean,
) {
  const unlock = await lockInstance(paths.home);
  let boot: ReturnType<typeof bootProfile>;
  let ending: Promise<void> | undefined;
  const release = async () => {
    process.off('SIGTERM', stop);
    // An interactive surface handles terminal Ctrl+C itself when possible.
    process.off('SIGINT', stop);
    await unlock();
  };
  const stop = () => {
    ending ??= boot
      .then(
        (app) => app.close(),
        () => {},
      )
      .finally(release);
    ending.catch((error) => {
      console.error('mini-harness:', error.message);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  boot = bootProfile(profile, paths, { interactive: true, flags, detached, shutdown: stop });
  try {
    await boot;
  } catch (error) {
    stop();
    await ending;
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'plugin' && argv[1] === 'dev') {
    if (argv.length !== 3) throw new Error('Usage: mini-harness plugin dev <directory>');
    const { pluginDev } = await import('./plugin-dev.js');
    await pluginDev(argv[2], executable);
    return;
  }
  if (argv[0] === 'plugin') {
    const [, operation, id, spec, ...extra] = argv;
    if (
      (operation !== 'install' && operation !== 'update') ||
      !id ||
      extra.length ||
      (operation === 'install' && !spec)
    )
      throw new Error(
        'Usage: mini-harness plugin install <id> <package> or mini-harness plugin update <id> [package]',
      );
    const paths = getPaths();
    ensurePaths(paths);
    const unlock = await lockInstance(paths.home);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      const { installPackagedPlugin } = await import('@mini-harness/plugins/package-installer');
      const profile = await loadProfile('web', paths, new Context());
      const reserved = readProfile('web');
      const { name, version } = await installPackagedPlugin(paths, operation, id, spec, {
        settings: profile.read(),
        reserved: (id) => reserved.has(id),
        signal: cancellation.signal,
      });
      console.log(id + ': ' + name + '@' + version);
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
      await unlock();
    }
    return;
  }
  const args = parse(argv);
  if (args.help) return help();
  const paths = getPaths(args.cwd);
  ensurePaths(paths);
  if (args.command) {
    const info = await serverStatus(paths.home, paths.pid);
    if (args.command === 'status') {
      if (info) {
        console.log('mini-harness is running (PID ' + info.pid + ') at ' + info.url);
        for (const diagnostic of info.sessionDiagnostics)
          console.log('Conversation ' + diagnostic.id + ': ' + diagnostic.message);
      } else {
        console.log('mini-harness is not running');
        process.exitCode = 1;
      }
      return;
    }
    if (info) {
      if (!(await requestShutdown(info))) throw new Error('Could not request mini-harness shutdown');
      for (let i = 0; i < 100 && readServerInfo(paths.pid)?.pid === info.pid; i++) await sleep(100);
      if (readServerInfo(paths.pid)?.pid === info.pid) throw new Error('mini-harness is still shutting down');
    }
    if (args.command === 'reset-token') {
      const unlock = await lockInstance(paths.home);
      try {
        instanceCredential(paths.home, true);
      } finally {
        await unlock();
      }
      console.log('Browser credential reset. Start mini-harness and open the new URL.');
    } else console.log(info ? 'mini-harness stopped' : 'mini-harness is not running');
    return;
  }
  if (args.detached && !args.serve) await detached(paths, args.profile, args.flags);
  else await serve(paths, args.profile, args.flags, args.serve);
}

main().catch((error) => {
  console.error('mini-harness:', error.message);
  process.exitCode = 1;
});
