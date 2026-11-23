import { manifest as ui_theme } from '../ui-theme/manifest.js';
import { manifest as ui_primitives } from '../ui-primitives/manifest.js';
import { manifest as ui_layout } from '../ui-layout/manifest.js';
import { manifest as workspaces } from '../workspaces/manifest.js';
import { manifest as sessions } from '../sessions/manifest.js';
import { manifest as agent } from '../agent/manifest.js';
import { manifest as runs } from '../runs/manifest.js';
import { manifest as settings } from '../settings/manifest.js';
import { manifest as models } from '../models/manifest.js';
import { manifest as plugin_management } from '../plugins/manifest.js';
import { manifest as ui } from '../ui/descriptor.js';
import { manifest as files } from '../files/manifest.js';
import { manifest as skills } from '../skills/manifest.js';
import { manifest as subagents } from '../subagents/manifest.js';
import { manifest as shell } from '../shell/manifest.js';
import { manifest as session_helper } from '../session-helper/manifest.js';
import { manifest as approvals } from '../approvals/manifest.js';
import { manifest as process_execution } from '../process-execution/manifest.js';
import { manifest as tools } from '../tools/manifest.js';
import { manifest as conversation } from '../sessions/conversation-manifest.js';

export const plugins = [
  ui_theme, ui_primitives, ui_layout, workspaces, sessions, agent, runs, settings, models, plugin_management, ui, files, skills, subagents, shell, session_helper, approvals, process_execution, tools, conversation
];
