import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup as workspaceServices } from '../workspaces/host.js';
import { setup as sessionServices } from '../sessions/host.js';
import { setup as agentServices } from '../agent/host.js';
import { setup as runServices } from '../runs/host.js';
import { setup as operationsServices } from '../sessions/operations-host.js';
import { setup as modelServices } from '../models/host.js';
import { setup as settingsRoutes } from '../settings/host.js';
import { setup as pluginRoutes } from '../plugins/host.js';
import { setup as uiRoutes } from '../ui/host.js';
import { manifest as files } from '../files/manifest.js';
import { manifest as skills } from '../skills/manifest.js';
import { manifest as shell } from '../shell/manifest.js';
import { manifest as subagents } from '../subagents/manifest.js';
import { manifest as session_helper } from '../session-helper/manifest.js';
import { setup as files_setup } from '../files/host.js';
import { setup as skills_setup } from '../skills/host.js';
import { setup as shell_setup } from '../shell/host.js';
import { setup as subagents_setup } from '../subagents/host.js';
import { setup as session_helper_setup } from '../session-helper/host.js';

/** The only built-in feature composition point; no feature imports the runtime. */
export const builtins: BuiltinPlugin[] = [
  { ...files, setup: files_setup },
  { ...skills, setup: skills_setup },
  { ...subagents, setup: subagents_setup },
  { ...shell, setup: shell_setup },
  { ...session_helper, setup: session_helper_setup },
];

/** Essential service providers mount before opt-in plugins; they are not UI extensions. */
export const system: BuiltinPlugin[] = [
  { id: 'core-workspaces', title: 'Workspaces', description: 'Workspace identity and registry', inject: ['harnessState', 'harnessRoutes'], setup: workspaceServices },
  { id: 'core-sessions', title: 'Sessions', description: 'Session persistence and navigation', requires: ['core-workspaces'], inject: ['harnessState', 'harnessWorkspaces'], setup: sessionServices },
  { id: 'core-agent', title: 'Agent', description: 'Official Pi SDK adapter', requires: ['core-sessions'], inject: ['harnessState', 'harnessRegistry', 'harnessSettings', 'harnessSettingsStore'], setup: agentServices },
  { id: 'core-runs', title: 'Runs', description: 'Run lifecycle and transport', requires: ['core-agent'], inject: ['harnessRegistry', 'harnessPi', 'harnessSettings'], setup: runServices },
  { id: 'core-operations', title: 'Conversations', description: 'Conversation operations', requires: ['core-runs'], inject: ['harnessRegistry', 'harnessPi', 'harnessRuns', 'harnessSettingsStore', 'harnessWorkspaces', 'harnessRoutes', 'harnessMutations'], setup: operationsServices },
  { id: 'core-models', title: 'Models', description: 'Pi model endpoints and credential management', requires: ['core-operations'], inject: ['harnessPi', 'harnessOperations', 'harnessUpdateSettings', 'harnessSettings', 'harnessState', 'harnessRoutes', 'harnessMutations'], setup: modelServices },
  { id: 'core-settings-api', title: 'Settings', description: 'Configuration API', requires: ['core-operations'], inject: ['harnessUpdateSettings', 'harnessRoutes', 'harnessMutations'], setup: settingsRoutes },
  { id: 'core-plugins-api', title: 'Plugins', description: 'Installed plugin API', requires: ['core-operations'], inject: ['harnessPluginCatalog', 'harnessSettingsStore', 'harnessState', 'harnessSettings', 'harnessRoutes', 'harnessMutations'], setup: pluginRoutes },
  { id: 'core-ui-api', title: 'Web UI', description: 'Bootstrap composition', requires: ['core-models', 'core-plugins-api'], inject: ['harnessProviderCatalog', 'harnessPluginCatalog', 'harnessNavigation', 'harnessPi', 'harnessSettings', 'harnessRoutes'], setup: uiRoutes }
];
