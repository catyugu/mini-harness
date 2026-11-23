import { manifest as ui_slots } from '../ui-slots/manifest.js';
import { manifest as ui_theme } from '../ui-theme/manifest.js';
import { manifest as ui_primitives } from '../ui-primitives/manifest.js';
import { manifest as ui_layout } from '../ui-layout/manifest.js';
import { manifest as workspaces } from '../workspaces/manifest.js';
import { manifest as sessions } from '../sessions/manifest.js';
import { manifest as agent } from '../agent/manifest.js';
import { manifest as prompt } from '../agent/prompt-manifest.js';
import { manifest as model_store } from '../models/store-manifest.js';
import { manifest as model_catalog } from '../models/catalog-manifest.js';
import { manifest as model_admin } from '../models/admin-manifest.js';
import { manifest as llm } from '../models/llm-manifest.js';
import { manifest as settings_data } from '../settings/data-manifest.js';
import { manifest as workspaces_data } from '../workspaces/data-manifest.js';
import { manifest as models_data } from '../models/data-manifest.js';
import { manifest as plugins_data } from '../plugins/data-manifest.js';
import { manifest as approvals_data } from '../approvals/data-manifest.js';
import { manifest as sessions_data } from '../sessions/data-manifest.js';
import { manifest as runs } from '../runs/manifest.js';
import { manifest as settings } from '../settings/manifest.js';
import { manifest as models } from '../models/manifest.js';
import { manifest as plugin_management } from '../plugins/manifest.js';
import { manifest as ui } from '../ui/descriptor.js';
import { manifest as file_access } from '../file-access/manifest.js';
import { manifest as files } from '../files/manifest.js';
import { manifest as skills } from '../skills/manifest.js';
import { manifest as subagents } from '../subagents/manifest.js';
import { manifest as shell } from '../shell/manifest.js';
import { manifest as session_helper } from '../session-helper/manifest.js';
import { manifest as approvals } from '../approvals/manifest.js';
import { manifest as sandbox } from '../sandbox/manifest.js';
import { manifest as process_execution } from '../process-execution/manifest.js';
import { manifest as tools } from '../tools/manifest.js';
import { manifest as conversation } from '../sessions/conversation-manifest.js';

export const plugins = [
  settings_data, workspaces_data, models_data, plugins_data, approvals_data, sessions_data, model_store, model_catalog, model_admin, llm, prompt,
  ui_slots, ui_theme, ui_primitives, ui_layout, workspaces, sessions, agent, runs, settings, models, plugin_management, ui, file_access, files, skills, subagents, shell, session_helper, approvals, sandbox, process_execution, tools, conversation
];
