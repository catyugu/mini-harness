import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLayout, type LayoutInput } from '../src/browser/layout-state.ts';

const initial: LayoutInput = {
  width: 1440, mobile: false, sidebarPreference: 380, panelPreference: 400,
  desktopSidebar: true, drawer: false, panelOpen: true,
};

test('docking preserves user preferences across budget and media boundaries', () => {
  for (const [width, mobile, expanded, mode, panelWidth] of [
    [1440, false, true, 'docked', 400],
    [1220, false, true, 'docked', 320],
    [1160, false, true, 'docked', 260],
    [1159, false, true, 'drawer', 260],
    [900, false, true, 'drawer', 260],
    [900, false, false, 'docked', 324],
    [860, true, false, 'drawer', 340],
    [1440, false, true, 'docked', 400],
  ] as const) {
    const input = { ...initial, width, mobile, desktopSidebar: expanded };
    const next = resolveLayout(input);
    assert.equal(next.panelDrawer ? 'drawer' : 'docked', mode);
    assert.equal(next.panel.value, panelWidth);
    assert.equal(next.sidebarWidth, mobile ? 0 : expanded ? 380 : 56);
    assert.equal(next.modal, mode === 'drawer' ? 'panel' : undefined);
    assert.equal(input.sidebarPreference, 380);
    assert.equal(input.panelPreference, 400);
  }
  const bounded = resolveLayout({ ...initial, width: 1000, desktopSidebar: false, sidebarPreference: 20, panelPreference: 9999 });
  assert.equal(bounded.sidebar.value, 280);
  assert.equal(bounded.panel.value, 424);
  assert.equal(resolveLayout({ ...initial, width: 2000, sidebarPreference: 9999, panelPreference: 9999 }).panel.value, 960);
  const mobile = resolveLayout({ ...initial, mobile: true, width: 860, drawer: true, panelOpen: false });
  assert.equal(mobile.modal, 'sidebar');
  assert.equal(mobile.closeTarget, 'sidebar');
  assert.equal(resolveLayout(initial).closeTarget, 'panel');
});
