import { manifest as ui_slots } from '#mini-harness/ui-slots/manifest.js';
import { manifest as ui_theme } from '#mini-harness/ui-theme/manifest.js';
import { manifest as ui_primitives } from '#mini-harness/ui-primitives/manifest.js';
import { manifest as ui_layout } from '#mini-harness/ui-layout/manifest.js';
import { manifest as workspaces } from '#mini-harness/workspaces/manifest.js';
import { manifest as sessions } from '#mini-harness/sessions/manifest.js';
import { manifest as agent } from '#mini-harness/agent/manifest.js';
import { manifest as prompt } from '#mini-harness/agent/prompt-manifest.js';
import { manifest as model_store } from '#mini-harness/models/store-manifest.js';
import { manifest as model_catalog } from '#mini-harness/models/catalog-manifest.js';
import { manifest as model_admin } from '#mini-harness/models/admin-manifest.js';
import { manifest as llm } from '#mini-harness/models/llm-manifest.js';
import { manifest as settings_data } from '#mini-harness/settings/data-manifest.js';
import { manifest as workspaces_data } from '#mini-harness/workspaces/data-manifest.js';
import { manifest as models_data } from '#mini-harness/models/data-manifest.js';
import { manifest as plugins_data } from '#mini-harness/plugins/data-manifest.js';
import { manifest as approvals_data } from '#mini-harness/approvals/data-manifest.js';
import { manifest as sessions_data } from '#mini-harness/sessions/data-manifest.js';
import { manifest as runs } from '#mini-harness/runs/manifest.js';
import { manifest as settings } from '#mini-harness/settings/manifest.js';
import { manifest as models } from '#mini-harness/models/manifest.js';
import { manifest as plugin_management } from '#mini-harness/plugins/manifest.js';
import { manifest as ui } from '#mini-harness/ui/descriptor.js';
import { manifest as file_access } from '#mini-harness/file-access/manifest.js';
import { manifest as files } from '#mini-harness/files/manifest.js';
import { manifest as skills } from '#mini-harness/skills/manifest.js';
import { manifest as subagents } from '#mini-harness/subagents/manifest.js';
import { manifest as shell } from '#mini-harness/shell/manifest.js';
import { manifest as session_helper } from '#mini-harness/session-helper/manifest.js';
import { manifest as approvals } from '#mini-harness/approvals/manifest.js';
import { manifest as sandbox } from '#mini-harness/sandbox/manifest.js';
import { manifest as process_execution } from '#mini-harness/process-execution/manifest.js';
import { manifest as tools } from '#mini-harness/tools/manifest.js';
import { manifest as conversation } from '#mini-harness/sessions/conversation-manifest.js';

export const plugins = [
  settings_data, workspaces_data, models_data, plugins_data, approvals_data, sessions_data, model_store, model_catalog, model_admin, llm, prompt,
  ui_slots, ui_theme, ui_primitives, ui_layout, workspaces, sessions, agent, runs, settings, models, plugin_management, ui, file_access, files, skills, subagents, shell, session_helper, approvals, sandbox, process_execution, tools, conversation
];
