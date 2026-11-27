import { clampWidth, geometry, resolveLayout } from './layout-state.ts';

interface LayoutElements {
  root: HTMLElement;
  sidebar: HTMLElement;
  sidebarButton: HTMLElement;
  sidebarClose: HTMLElement;
  sidebarResize: HTMLElement;
  main: HTMLElement;
  overlay: HTMLElement;
  panel: HTMLElement;
  panelButton: HTMLElement;
  panelClose: HTMLElement;
  panelResize: HTMLElement;
}

export function createLayout(view: LayoutElements, signal: AbortSignal) {
  const {
    root,
    sidebar,
    sidebarButton,
    sidebarClose,
    sidebarResize,
    main,
    overlay,
    panel,
    panelButton,
    panelClose,
    panelResize,
  } = view;
  const narrow = matchMedia('(max-width: ' + geometry.mobileMax + 'px)');
  const sidebarWidthKey = 'mini-harness-sidebar-width';
  const panelWidthKey = 'mini-harness-panel-width';
  function preference(key: string, initial: number) {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : initial;
  }
  let sidebarWidth = preference(sidebarWidthKey, geometry.sidebarDefault);
  let panelWidth = preference(panelWidthKey, geometry.panelDefault);
  let desktopSidebar = localStorage.getItem('mini-harness-sidebar') !== 'collapsed';
  let drawer = false;
  let panelOpen = false;
  let panelTrigger = panelButton;
  const viewport = window.visualViewport;

  const resolve = () =>
    resolveLayout({
      width: innerWidth,
      mobile: narrow.matches,
      sidebarPreference: sidebarWidth,
      panelPreference: panelWidth,
      desktopSidebar,
      drawer,
      panelOpen,
    });

  function project(next: ReturnType<typeof resolveLayout>) {
    const mobile = next.sidebarMode === 'drawer';
    const panelModal = next.modal === 'panel';
    root.classList.toggle('mobile-layout', mobile);
    root.classList.toggle('sidebar-collapsed', next.sidebarMode === 'collapsed');
    root.classList.toggle('right-open', next.panelOpen);
    root.classList.toggle('panel-drawer', next.panelDrawer);
    root.style.setProperty('--left-width', next.sidebarWidth + 'px');
    root.style.setProperty('--right-width', next.panel.value + 'px');
    sidebar.classList.toggle('open', mobile && next.sidebarOpen);
    sidebar.inert = panelModal || (mobile && !next.sidebarOpen);
    sidebarResize.hidden = next.sidebarMode !== 'expanded';
    panelResize.hidden = !next.panelOpen || next.panelDrawer;
    sidebarButton.setAttribute('aria-expanded', String(next.sidebarOpen));
    panelButton.setAttribute('aria-expanded', String(next.panelOpen));
    panel.inert = !next.panelOpen;
    main.inert = next.modal !== undefined;
    overlay.hidden = next.modal === undefined;
    overlay.setAttribute('aria-label', panelModal ? 'Dismiss workspace panel' : 'Close navigation');
    for (const [element, active] of [
      [sidebar, next.modal === 'sidebar'],
      [panel, panelModal],
    ] as const) {
      if (active) {
        element.setAttribute('role', 'dialog');
        element.setAttribute('aria-modal', 'true');
      } else {
        element.removeAttribute('role');
        element.removeAttribute('aria-modal');
      }
    }
    for (const [handle, range] of [
      [sidebarResize, next.sidebar],
      [panelResize, next.panel],
    ] as const) {
      handle.setAttribute('aria-valuenow', String(range.value));
      handle.setAttribute('aria-valuemin', String(range.min));
      handle.setAttribute('aria-valuemax', String(range.max));
    }
  }

  function render() {
    const next = resolve();
    const focused = document.activeElement;
    const focusPanel = next.modal === 'panel' && (!panel.contains(focused) || focused === panelResize);
    if (focusPanel && focused instanceof HTMLElement && focused !== document.body && !panel.contains(focused))
      panelTrigger = focused;
    project(next);
    if (focusPanel) panelClose.focus();
    return next;
  }

  function closeDrawer(restore = true) {
    if (!drawer) return;
    drawer = false;
    render();
    if (restore) sidebarButton.focus();
  }
  function setPanel(open: boolean, focus = false) {
    if (open === panelOpen) return;
    if (open) {
      const origin = document.activeElement;
      panelTrigger =
        origin instanceof HTMLElement && !panel.contains(origin) && !sidebar.contains(origin)
          ? origin
          : panelButton;
    }
    if (open) drawer = false;
    if (!open && panel.contains(document.activeElement)) focus = true;
    panelOpen = open;
    const next = render();
    if (open && focus && !next.panelDrawer) panelClose.focus();
    if (!open && focus)
      (panelTrigger.isConnected && !panelTrigger.closest('[inert]') ? panelTrigger : panelButton).focus();
    panel.dispatchEvent(new Event('panel-visibility'));
  }
  sidebarButton.onclick = () => {
    if (narrow.matches) {
      if (drawer) closeDrawer();
      else {
        setPanel(false);
        drawer = true;
        render();
        sidebarClose.focus();
      }
    } else {
      desktopSidebar = !desktopSidebar;
      localStorage.setItem('mini-harness-sidebar', desktopSidebar ? 'open' : 'collapsed');
      render();
    }
  };
  sidebarClose.onclick = () => closeDrawer();
  panelClose.onclick = () => setPanel(false, true);
  overlay.onclick = () => {
    if (resolve().modal === 'panel') setPanel(false, true);
    else closeDrawer();
  };
  narrow.addEventListener(
    'change',
    () => {
      drawer = false;
      render();
    },
    { signal },
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      const next = resolve();
      if (event.key === 'Escape' && next.closeTarget) {
        if (document.querySelector(':popover-open')) return;
        event.preventDefault();
        if (next.closeTarget === 'panel') setPanel(false, true);
        else closeDrawer();
        return;
      }
      if (event.key !== 'Tab' || !next.modal) return;
      const container = next.modal === 'panel' ? panel : sidebar;
      const controls = [
        ...container.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, summary, [tabindex]',
        ),
      ].filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.matches(':disabled') &&
          node.getClientRects().length &&
          !node.closest('[inert]'),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (
        !container.contains(document.activeElement) ||
        document.activeElement === (event.shiftKey ? first : last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    },
    { signal },
  );

  function bindResize(
    handle: HTMLElement,
    target: HTMLElement,
    direction: 1 | -1,
    key: string,
    side: 'sidebar' | 'panel',
    getPreference: () => number,
    setPreference: (value: number) => void,
  ) {
    let drag: { id: number; start: number; width: number } | undefined;
    const save = () => localStorage.setItem(key, String(getPreference()));
    function setWidth(value: number) {
      const { min, max } = resolve()[side];
      setPreference(clampWidth(value, min, max));
    }
    handle.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        handle.focus();
        drag = { id: event.pointerId, start: event.clientX, width: target.getBoundingClientRect().width };
        root.classList.add('resizing');
        handle.setPointerCapture(event.pointerId);
      },
      { signal },
    );
    handle.addEventListener(
      'pointermove',
      (event) => {
        if (drag?.id !== event.pointerId) return;
        setWidth(drag.width + direction * (event.clientX - drag.start));
        render();
      },
      { signal },
    );
    handle.addEventListener(
      'lostpointercapture',
      (event) => {
        if (drag?.id !== event.pointerId) return;
        drag = undefined;
        root.classList.remove('resizing');
        save();
      },
      { signal },
    );
    handle.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 20 : -20;
        setWidth(resolve()[side].value + direction * delta);
        render();
        save();
      },
      { signal },
    );
  }

  bindResize(
    sidebarResize,
    sidebar,
    1,
    sidebarWidthKey,
    'sidebar',
    () => sidebarWidth,
    (value) => {
      sidebarWidth = value;
    },
  );
  bindResize(
    panelResize,
    panel,
    -1,
    panelWidthKey,
    'panel',
    () => panelWidth,
    (value) => {
      panelWidth = value;
    },
  );

  function resizeHeight() {
    root.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
  }
  viewport?.addEventListener('resize', resizeHeight, { signal });
  window.addEventListener(
    'resize',
    () => {
      resizeHeight();
      render();
    },
    { signal },
  );
  resizeHeight();
  render();
  return {
    closeDrawer,
    setPanel,
    panelOpen: () => panelOpen,
    onPanelVisibilityChange(listener: () => void) {
      panel.addEventListener('panel-visibility', listener, { signal });
    },
  };
}
