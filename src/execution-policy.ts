export const permissions = ['read-only', 'workspace-write', 'full'] as const;
export type Permission = typeof permissions[number];
export type ToolCapability = 'read' | 'workspace-write' | 'shell' | 'delegate' | 'trusted-code';
export const permissionRank = (permission: Permission) => permissions.indexOf(permission);
export function requirePermission(value: unknown): Permission {
  if (!permissions.includes(value as Permission)) throw new Error('Invalid execution permission');
  return value as Permission;
}
export function authorizeTool(permission: Permission, capabilities: readonly ToolCapability[]) {
  if (capabilities.includes('trusted-code') && permission !== 'full')
    throw new Error('Local plugin tools require full permission: their Node code has host access');
  if (capabilities.includes('workspace-write') && permission === 'read-only')
    throw new Error('Read-only permission forbids file modifications');
  // The built-in shell enforces read-only/workspace mounts at the OS boundary.
  // Delegates receive the same or a more restrictive permission, never a broader one.
}
