import { spawnSync } from 'node:child_process';

export function protectLocal(operation: 'Protect' | 'Unprotect', value: Buffer) {
  const script =
    '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Security; ' +
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
    '$result = [System.Security.Cryptography.ProtectedData]::' +
    operation +
    '($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[Console]::Out.Write([Convert]::ToBase64String($result))';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value.toString('base64'),
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout?.length)
    throw new Error('Windows could not access protected data for the current user');
  return Buffer.from(result.stdout, 'base64');
}
