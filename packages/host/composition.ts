import { manifest as ui_slots } from '@mini-harness/ui-slots/manifest';
import { manifest as ui_theme } from '@mini-harness/ui-theme/manifest';
import { manifest as ui_primitives } from '@mini-harness/ui-primitives/manifest';
import { manifest as ui_layout } from '@mini-harness/ui-layout/manifest';
import { manifest as workspaces } from '@mini-harness/workspaces/manifest';
import { manifest as sessions } from '@mini-harness/sessions/manifest';
import { manifest as agent } from '@mini-harness/agent/manifest';
import { manifest as prompt } from '@mini-harness/agent/prompt-manifest';
import { manifest as model_store } from '@mini-harness/models/store-manifest';
import { manifest as model_catalog } from '@mini-harness/models/catalog-manifest';
import { manifest as model_admin } from '@mini-harness/models/admin-manifest';
import { manifest as llm } from '@mini-harness/models/llm-manifest';
import { manifest as settings_data } from '@mini-harness/settings/data-manifest';
import { manifest as workspaces_data } from '@mini-harness/workspaces/data-manifest';
import { manifest as sessions_data } from '@mini-harness/sessions/data-manifest';
import { manifest as runs } from '@mini-harness/runs/manifest';
import { manifest as settings } from '@mini-harness/settings/manifest';
import { manifest as models } from '@mini-harness/models/manifest';
import { manifest as plugin_management } from '@mini-harness/plugins/manifest';
import { manifest as ui } from '@mini-harness/ui/descriptor';
import { manifest as file_access } from '@mini-harness/file-access/manifest';
import { manifest as files } from '@mini-harness/files/manifest';
import { manifest as skills } from '@mini-harness/skills/manifest';
import { manifest as subagents } from '@mini-harness/subagents/manifest';
import { manifest as shell } from '@mini-harness/shell/manifest';
import { manifest as session_helper } from '@mini-harness/session-helper/manifest';
import { manifest as approvals } from '@mini-harness/approvals/manifest';
import { manifest as sandbox } from '@mini-harness/sandbox/manifest';
import { manifest as process_execution } from '@mini-harness/process-execution/manifest';
import { manifest as tools } from '@mini-harness/tools/manifest';
import { manifest as conversation } from '@mini-harness/sessions/conversation-manifest';

export const plugins = [
  settings_data, workspaces_data, sessions_data, model_store, model_catalog, model_admin, llm, prompt,
  ui_slots, ui_theme, ui_primitives, ui_layout, workspaces, sessions, agent, runs, settings, models, plugin_management, ui, file_access, files, skills, subagents, shell, session_helper, approvals, sandbox, process_execution, tools, conversation
];

export const authority = {
  trustedContributors: new Set([files.id, skills.id]),
  protectedProviders: new Map([['harnessTools', tools.id]])
};
