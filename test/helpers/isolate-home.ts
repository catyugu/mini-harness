// Loaded before application/SDK imports. Product discovery keeps native user Skills;
// tests never inspect or modify the developer's real user directories.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'mini-harness-test-home-'));
process.env.HOME = home;
process.env.MINI_HARNESS_TEST_HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');
mkdirSync(process.env.XDG_CONFIG_HOME);
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
