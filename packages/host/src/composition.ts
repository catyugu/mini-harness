import { manifest as ui_slots } from '@mini-harness/ui-slots/manifest';
import { manifest as ui_theme } from '@mini-harness/ui-theme/manifest';
import { manifest as ui_primitives } from '@mini-harness/ui-primitives/manifest';
import { manifest as ui_layout } from '@mini-harness/ui-layout/manifest';
import { manifest as workspaces } from '@mini-harness/workspaces/manifests/workspaces';
import { manifest as tool_policy } from '@mini-harness/sessions/manifests/tool-policy';
import { manifest as sessions } from '@mini-harness/sessions/manifest';
import { manifest as agent } from '@mini-harness/agent/manifests/agent';
import { manifest as prompt } from '@mini-harness/agent/manifests/prompt';
import { manifest as model_store } from '@mini-harness/models/manifests/store';
import { manifest as model_catalog } from '@mini-harness/models/manifests/catalog';
import { manifest as llm } from '@mini-harness/models/manifests/llm';
import { manifest as workspaces_data } from '@mini-harness/workspaces/manifests/data';
import { manifest as sessions_data } from '@mini-harness/conversation/manifests/session-data';
import { manifest as runs } from '@mini-harness/runs/manifest';
import { manifest as settings } from '@mini-harness/settings/manifest';
import { manifest as models, administrationManifest as model_admin } from '@mini-harness/models/manifests/models';
import { manifest as plugin_management } from '@mini-harness/plugins/manifest';
import { manifest as ui } from '@mini-harness/ui-gateway/manifest';
import { manifest as file_access } from '@mini-harness/file-access/manifest';
import { manifest as files } from '@mini-harness/files/manifest';
import { manifest as skills } from '@mini-harness/skills/manifest';
import { manifest as subagents } from '@mini-harness/subagents/manifest';
import { manifest as shell } from '@mini-harness/shell/manifest';
import { manifest as session_helper } from '@mini-harness/session-helper/manifest';
import { manifest as approval_data } from '@mini-harness/approvals/browser/manifest';
import { manifest as approvals } from '@mini-harness/approvals/manifest';
import { manifest as sandbox } from '@mini-harness/sandbox/manifest';
import { manifest as process_execution } from '@mini-harness/process-execution/manifest';
import { manifest as tools } from '@mini-harness/tools/manifest';
import { manifest as navigation } from '@mini-harness/conversation/manifests/navigation';
import { manifest as workspace_navigation } from '@mini-harness/conversation/manifests/workspace';
import { manifest as conversation, composerManifest as composer, historyManifest as history } from '@mini-harness/conversation/manifests/conversation';

export const plugins = [
  workspaces_data, sessions_data, workspace_navigation, navigation, model_store, model_catalog, llm, prompt,
  ui_slots, ui_theme, ui_primitives, ui_layout, workspaces, sessions, agent, runs, settings, models, model_admin, plugin_management, ui, file_access, files, skills, subagents, shell, session_helper, approvals, approval_data, sandbox, process_execution, tool_policy, tools, conversation, composer, history
];

export const composition = {
  fixedPlugins: new Set([ui.id, settings.id, plugin_management.id, model_admin.id, conversation.id, navigation.id]),
  requiredServices: new Set([
    'harnessAgent', 'harnessApprovalRequests', 'harnessApprovals', 'harnessExecution', 'harnessFileAccess', 'harnessLlm',
    'harnessModels', 'harnessModelStore', 'harnessModelPreference', 'harnessProcess', 'harnessPrompt', 'harnessRegistry',
    'harnessRuns', 'harnessSandbox', 'harnessSessions', 'harnessToolPolicy', 'harnessTools', 'harnessWorkspaces'
  ]),
  requiredBrowserServices: new Set([
    'harnessBrowser', 'miniAppearance', 'miniApprovals', 'miniComposer', 'miniConversation', 'miniDialogs', 'miniHeader',
    'miniLayout', 'miniMessages', 'miniModels', 'miniPages', 'miniPrimitives', 'miniSelection', 'miniSessions',
    'miniSettings', 'miniSettingsData', 'miniSettingsRegistry', 'miniSlots', 'miniTabs', 'miniWorkspace', 'miniWorkspaces'
  ]),
  trustedContributors: new Set([files.id, skills.id]),
  protectedProviders: new Map([['harnessTools', tools.id], ['harnessToolPolicy', tool_policy.id]])
};
