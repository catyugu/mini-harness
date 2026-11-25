#!/usr/bin/env node
import { bootProfile } from '@mini-harness/host/application';
import {
  allowsDetachment,
  dumpProfile,
  ensureProfile,
  profileSchema,
  recreateProfile,
} from '@mini-harness/host/profile';
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
  console.log(`Usage: mini-harness [--profile] <name> [options] [app-args...]
       mini-harness plugin --profile <name> <npm-args...>

mini-harness: a minimal native agent harness. Boot a Profile — an ordered stack of plugin-bundle layers.

Arguments:
  args                           arguments for the selected app (see: mini-harness web --help)

Options:
  -V, --version                  output the version number
  --profile <name>               select a Profile (default: web)
  --from-default-profile <name>  recreate the Profile from a shipped template
  --patch <path>                 apply an extra YAML overlay (repeatable)
  --dump-config                  print the composed Profile and exit
  --dump-config-schema           print the Profile JSON Schema without mounting
  --dump-default-config          print the Profile without user or extra overlays
  --detached                     run independently of this terminal
  -h, --help                     show launcher help

Examples:
  mini-harness web
  mini-harness rescue --from-default-profile web
  mini-harness web --patch ./extra.yml --port 3838
  mini-harness web --help
  mini-harness plugin --profile web add <package>

Instance commands: status, stop, reset-token
`);
}

function parse(argv: string[]) {
  const args: {
    help?: boolean;
    version?: boolean;
    template?: string;
    dump?: 'config' | 'schema' | 'default';
    detached: boolean;
    profile?: string;
    patches: string[];
    flags: string[];
  } = { detached: false, patches: [], flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(flag + ' requires a value');
      return next;
    };
    if (flag === '--profile') {
      if (args.profile) throw new Error('Specify one Profile');
      args.profile = value();
    } else if (flag === '--from-default-profile') args.template = value();
    else if (flag === '--patch') args.patches.push(resolve(value()));
    else if (flag === '--dump-config') args.dump = 'config';
    else if (flag === '--dump-config-schema') args.dump = 'schema';
    else if (flag === '--dump-default-config') args.dump = 'default';
    else if (flag === '--version' || flag === '-V') args.version = true;
    else if ((flag === '--help' || flag === '-h') && !args.profile) args.help = true;
    else if (flag === '--detached') args.detached = true;
    else if (flag !== '--' && !args.profile && !flag.startsWith('-')) args.profile = flag;
    else {
      args.flags = argv.slice(i + Number(flag === '--'));
      break;
    }
  }
  return { ...args, profile: args.profile ?? 'web' };
}

async function detached(
  paths: ReturnType<typeof getPaths>,
  profile: string,
  flags: string[],
  patches: string[],
) {
  if (!allowsDetachment(profile, paths, patches))
    throw new Error('Profile ' + profile + ' does not support --detached');
  const running = await serverStatus(paths.home, paths.pid);
  if (running) throw new Error('mini-harness is already running (PID ' + running.pid + ')');
  const output = openSync(paths.log, 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        executable,
        '--serve',
        '--profile',
        profile,
        ...patches.flatMap((patch) => ['--patch', patch]),
        '--',
        ...flags,
      ],
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
  if (argv[0] === 'plugin') {
    const [, option, name, ...npmArgs] = argv;
    if (option !== '--profile' || !name || !npmArgs.length)
      throw new Error('Usage: mini-harness plugin --profile <name> <npm-args...>');
    const paths = getPaths();
    ensurePaths(paths);
    const unlock = await lockInstance(paths.home);
    try {
      const { runPackageManager } = await import('@mini-harness/plugins/registry-client');
      await runPackageManager(ensureProfile(name, paths), npmArgs);
    } finally {
      await unlock();
    }
    return;
  }
  const serving = argv[0] === '--serve';
  if (serving) argv.shift();
  const command = ['status', 'stop', 'reset-token'].includes(argv[0]) ? argv[0] : undefined;
  if (command && argv.length !== 1) throw new Error('Instance commands do not accept arguments');
  const args = parse(command ? [] : argv);
  if (args.version) {
    console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  if (args.help) return help();
  if (args.dump === 'schema') {
    console.log(JSON.stringify(profileSchema, null, 2));
    return;
  }
  const paths = getPaths();
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
  if (command) {
    const info = await serverStatus(paths.home, paths.pid);
    if (command === 'status') {
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
    if (command === 'reset-token') {
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
  if (args.detached && !serving) await detached(paths, args.profile, args.flags, args.patches);
  else await serve(paths, args.profile, args.flags, serving, args.patches);
}

main().catch((error) => {
  console.error('mini-harness:', error.message);
  process.exitCode = 1;
});
