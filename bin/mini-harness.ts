#!/usr/bin/env node
import { bootProfile } from '@mini-harness/host/application';
import { allowsDetachment, dumpProfile, initializeProfile, loadProfile, profileSchema, readProfile, recreateProfile, WEB_BUNDLES } from '@mini-harness/host/profile';
import { Context } from 'mini-harness/cordis';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
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
  mini-harness [--profile] <name> [options] [app-args...]
  mini-harness plugin --profile <name> <npm-args...>

Options:
  -V, --version                    Print version
  --profile <name>                 Select a Profile package (default: web)
  --from-default-profile <name>    Replace the selected Profile with a shipped template
  --patch <path>                   Apply an extra YAML overlay (repeatable)
  --dump-config                    Print the composed configuration without mounting
  --dump-config-schema             Print the Profile layer JSON Schema
  --dump-default-config            Print configuration without user or extra overlays
  --detached                       Run independently of this terminal
  --cwd <path>                     Select the workspace
  -h, --help                       Show launcher help (or the selected application's help)

Examples:
  mini-harness web
  mini-harness rescue --from-default-profile web
  mini-harness web --patch ./extra.yml --port 3838
  mini-harness web --help

Commands: status, stop, reset-token
Profiles: ~/.mini-harness/profiles/<name> (or MINI_HARNESS_HOME)
`);
}

function parse(argv: string[]) {
  const args: {
    help?: boolean;
    version?: boolean;
    template?: string;
    dump?: 'config' | 'schema' | 'default';
    detached: boolean;
    serve: boolean;
    cwd: string;
    profile: string;
    patches: string[];
    flags: string[];
    command?: 'status' | 'stop' | 'reset-token';
  } = { detached: false, serve: false, cwd: process.cwd(), profile: 'web', patches: [], flags: [] };
  let selected = false;
  const value = (index: number, option: string) => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(option + ' requires a value');
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--') {
      args.flags.push(...argv.slice(i + 1));
      break;
    } else if (flag === '--profile') {
      if (selected) throw new Error('Specify one Profile');
      args.profile = value(i++, flag);
      selected = true;
    } else if (flag === '--from-default-profile') args.template = value(i++, flag);
    else if (flag === '--patch') args.patches.push(resolve(value(i++, flag)));
    else if (flag === '--dump-config') args.dump = 'config';
    else if (flag === '--dump-config-schema') args.dump = 'schema';
    else if (flag === '--dump-default-config') args.dump = 'default';
    else if (flag === '--version' || flag === '-V') args.version = true;
    else if ((flag === '--help' || flag === '-h') && !selected) args.help = true;
    else if (flag === '--detached') args.detached = true;
    else if (flag === '--serve') args.serve = true;
    else if (flag === '--cwd') args.cwd = resolve(value(i++, flag));
    else if (!selected && !args.flags.length && ['status', 'stop', 'reset-token'].includes(flag)) {
      if (args.command) throw new Error('Specify one command');
      args.command = flag as NonNullable<typeof args.command>;
    } else if (!selected && !args.command && !args.flags.length && !flag.startsWith('-')) {
      args.profile = flag;
      selected = true;
    } else args.flags.push(flag);
  }
  if (args.command && (selected || args.detached || args.serve || args.flags.length || args.patches.length || args.template || args.dump))
    throw new Error('Profile startup flags require the start command');
  return args;
}

async function detached(paths: ReturnType<typeof getPaths>, profile: string, flags: string[], patches: string[]) {
  if (!allowsDetachment(profile, paths, patches)) throw new Error('Profile ' + profile + ' does not support --detached');
  const running = await serverStatus(paths.home, paths.pid);
  if (running) throw new Error('mini-harness is already running (PID ' + running.pid + ')');
  const output = openSync(paths.log, 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [executable, '--serve', '--profile', profile, '--cwd', paths.cwd, ...patches.flatMap((patch) => ['--patch', patch]), '--', ...flags],
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
  patches: string[],
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
  boot = bootProfile(profile, paths, { interactive: true, flags, detached, patches, shutdown: stop });
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
  if (argv[0] === 'profile' && argv[1] === 'init') {
    const [, , name, ...flags] = argv;
    if (!name || (flags.length && (flags.length !== 2 || flags[0] !== '--from' || flags[1] !== 'web')))
      throw new Error('Usage: mini-harness profile init <name> [--from web]');
    const paths = getPaths();
    ensurePaths(paths);
    const unlock = await lockInstance(paths.home);
    try {
      console.log(initializeProfile(name, paths, flags.length ? WEB_BUNDLES : []));
    } finally {
      await unlock();
    }
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
      try {
        const reserved = readProfile('web');
        const { name, version } = await installPackagedPlugin(paths, operation, id, spec, {
          settings: profile.read(),
          reserved: (id) => reserved.has(id),
          signal: cancellation.signal,
        });
        console.log(id + ': ' + name + '@' + version);
      } finally {
        await profile.close();
      }
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
      await unlock();
    }
    return;
  }
  const args = parse(argv);
  if (args.version) {
    console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  if (args.help) return help();
  if (args.dump === 'schema') {
    console.log(JSON.stringify(profileSchema, null, 2));
    return;
  }
  const paths = getPaths(args.cwd);
  ensurePaths(paths);
  if (args.template) {
    const unlock = await lockInstance(paths.home);
    try {
      recreateProfile(args.profile, args.template, paths);
    } finally {
      await unlock();
    }
  }
  if (args.dump) {
    process.stdout.write(dumpProfile(args.profile, paths, args.patches, args.dump === 'default'));
    return;
  }
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
  if (args.detached && !args.serve) await detached(paths, args.profile, args.flags, args.patches);
  else await serve(paths, args.profile, args.flags, args.serve, args.patches);
}

main().catch((error) => {
  console.error('mini-harness:', error.message);
  process.exitCode = 1;
});
