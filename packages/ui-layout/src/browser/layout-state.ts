export const geometry = {
  mobileMax: 860,
  sidebarDefault: 340,
  sidebarMin: 280,
  sidebarMax: 380,
  sidebarCollapsed: 56,
  panelDefault: 380,
  panelMin: 260,
  panelFraction: 0.48,
  dockBudget: 520,
} as const;

export interface LayoutInput {
  width: number;
  mobile: boolean;
  sidebarPreference: number;
  panelPreference: number;
  desktopSidebar: boolean;
  drawer: boolean;
  panelOpen: boolean;
}

export function clampWidth(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(value, max)));
}

/** Only panel docking consumes the main-area budget. Preferences never change here. */
export function resolveLayout(input: LayoutInput) {
  const { width, mobile, desktopSidebar, drawer, panelOpen } = input;
  const sidebarPreference = clampWidth(input.sidebarPreference, geometry.sidebarMin, geometry.sidebarMax);
  const sidebarMode = mobile ? 'drawer' : desktopSidebar ? 'expanded' : 'collapsed';
  const sidebarWidth = mobile ? 0 : desktopSidebar ? sidebarPreference : geometry.sidebarCollapsed;
  const space = width - sidebarWidth - geometry.dockBudget;
  const panelDrawer = mobile || space < geometry.panelMin;
  const panelMax = Math.round(Math.max(geometry.panelMin, Math.min(width * geometry.panelFraction, space)));
  const panelWidth = clampWidth(input.panelPreference, geometry.panelMin, panelMax);
  const modal = panelOpen && panelDrawer ? 'panel' : mobile && drawer ? 'sidebar' : undefined;
  return {
    sidebarMode,
    sidebarWidth,
    sidebar: { value: sidebarPreference, min: geometry.sidebarMin, max: geometry.sidebarMax },
    panel: { value: panelWidth, min: geometry.panelMin, max: panelMax },
    panelDrawer,
    panelOpen,
    sidebarOpen: mobile ? drawer : desktopSidebar,
    modal,
    closeTarget: panelOpen ? 'panel' : mobile && drawer ? 'sidebar' : undefined,
  } as const;
}
