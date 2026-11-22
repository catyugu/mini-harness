import type { BuiltinPlugin } from '../src/kernel/plugin-api.js';
import { manifest as files } from './files/manifest.js';
import { manifest as skills } from './skills/manifest.js';
import { manifest as shell } from './shell/manifest.js';
import { manifest as subagents } from './subagents/manifest.js';
import { manifest as session_helper } from './session-helper/manifest.js';
import { setup as files_setup } from './files/host.js';
import { setup as skills_setup } from './skills/host.js';
import { setup as shell_setup } from './shell/host.js';
import { setup as subagents_setup } from './subagents/host.js';
import { setup as session_helper_setup } from './session-helper/host.js';

/** The only built-in feature composition point; no feature imports the runtime. */
export const builtins: BuiltinPlugin[] = [
  { ...files, setup: files_setup },
  { ...skills, setup: skills_setup },
  { ...subagents, setup: subagents_setup },
  { ...shell, setup: shell_setup },
  { ...session_helper, setup: session_helper_setup },
];
