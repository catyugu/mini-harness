#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPaths, ensurePaths, writeJson, readJson } from '../src/config.js';

const executable = fileURLToPath(import.meta.url);

function help() {
  console.log(`minih — minimal Pi harness

Usage:
  minih [--port 3837]              Start local web interface
  minih --detached [--port 3837]   Run independently of this terminal
  minih --serve --cwd PATH         Internal detached server entry
  minih --help                     Show help

Configuration: ~/.minih/settings.json (or MINIH_HOME)
Workspace Skills: .minih/skills/
Access: localhost only; bearer token required for all API endpoints.
`);
}

function parse(argv) {
  const args = { detached: false, serve: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--detached') args.detached = true;
    else if (flag === '--serve') args.serve = true;
    else if (flag === '--cwd') { if (!argv[i + 1]) throw new Error('--cwd requires a value'); args.cwd = resolve(argv[++i]); }
    else if (flag === '--port') {
      const number = Number(argv[++i]);
      if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error('Invalid port');
      args.port = number;
    } else throw new Error('Unknown option: ' + flag);
  }
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) return help();
  const paths = getPaths(args.cwd);
  ensurePaths(paths);
  if (args.detached && !args.serve) {
    const output = openSync(paths.log, 'a');
    const child = spawn(process.execPath, [executable, '--serve', '--cwd', paths.cwd, ...(args.port ? ['--port', String(args.port)] : [])], {
      cwd: paths.cwd, detached: true, stdio: ['ignore', output, output], windowsHide: true
    });
    closeSync(output);
    child.unref();
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const info = readJson(paths.pid, null);
      if (info?.pid === child.pid && info.url && info.token) {
        console.log('minih started independently (PID ' + child.pid + ')');
        console.log(info.url + '/#token=' + info.token);
        return;
      }
    }
    throw new Error('Detached server failed to become ready; see ' + paths.log);
  }
  const { createMinihServer } = await import('../src/server.js');
  const app = await createMinihServer(paths);
  const port = await app.listen(args.port);
  const url = 'http://127.0.0.1:' + port;
  writeJson(paths.pid, { pid: process.pid, url, token: app.token, startedAt: new Date().toISOString() });
  console.log('minih listening at ' + url + '/#token=' + app.token);
  let ending = false;
  async function stop() {
    if (ending) return;
    ending = true;
    try { await app.close(); } finally {
      const info = readJson(paths.pid, null);
      if (info?.pid === process.pid) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(paths.pid);
      }
    }
  }
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
}

main().catch((error) => { console.error('minih:', error.message); process.exitCode = 1; });
