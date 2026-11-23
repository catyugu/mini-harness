import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeJson } from '@mini-harness/platform/config';

const windows = process.platform === 'win32';
const format = /^[a-f0-9]{64}$/;

function protect(operation: 'Protect' | 'Unprotect', value: Buffer) {
  const script = '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Security; ' +
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
    '$result = [System.Security.Cryptography.ProtectedData]::' + operation +
    '($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Console]::Out.Write([Convert]::ToBase64String($result))';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value.toString('base64'), encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  if (result.status !== 0 || !result.stdout?.length)
    throw new Error('Windows could not access the mini-harness instance credential for the current user');
  return Buffer.from(result.stdout, 'base64');
}

function credentialPath(home: string) {
  const directory = lstatSync(home);
  if (!directory.isDirectory() || directory.isSymbolicLink() || relative(home, realpathSync(home)) ||
      (!windows && (directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)))
    throw new Error('MINI_HARNESS_HOME must be owned by the current user and protected against other users writing to it');
  return join(home, 'instance-credential.json');
}

export function readInstanceCredential(home: string) {
  const file = credentialPath(home);
  const before = lstatSync(file, { throwIfNoEntry: false });
  if (!before) return;
  if (!before.isFile() || before.nlink !== 1 || before.size > 8192 ||
      (!windows && (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0)))
    throw new Error('Instance credential must be a private file owned by the current user');
  const handle = openSync(file, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW));
  try {
    const actual = fstatSync(handle);
    if (actual.ino !== before.ino || actual.dev !== before.dev || actual.size !== before.size ||
        relative(file, realpathSync(file))) throw new Error('Instance credential file changed while opening');
    const stored: unknown = JSON.parse(readFileSync(handle, 'utf8'));
    if (typeof stored !== 'string') throw new Error('Invalid instance credential');
    const token = windows ? protect('Unprotect', Buffer.from(stored, 'base64')).toString('utf8') : stored;
    if (!format.test(token)) throw new Error('Invalid instance credential');
    return token;
  } finally { closeSync(handle); }
}

/** Call while holding the instance lock. */
export function instanceCredential(home: string, reset = false) {
  const current = readInstanceCredential(home);
  if (current && !reset) return current;
  const token = randomBytes(32).toString('hex');
  writeJson(credentialPath(home), windows ? protect('Protect', Buffer.from(token)).toString('base64') : token);
  return token;
}
