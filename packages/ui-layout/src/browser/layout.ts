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

export function createLayout(
  view: LayoutElements,
  signal: AbortSignal,
  tabs: { panelOpen(): boolean; setPanel(open: boolean, focus?: boolean): void },
) {
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
  const narrow = matchMedia('(max-width: 860px)');
  const sidebarStateKey = 'mini-harness-sidebar';
  const sidebarWidthKey = 'mini-harness-sidebar-width';
  const panelWidthKey = 'mini-harness-panel-width';
  const sidebarMin = 280;
  const sidebarMax = 380;
  const collapsedWidth = 56;
  const panelMin = 260;
  const mainMin = 520;
  let sidebarWidth = Number(localStorage.getItem(sidebarWidthKey)) || 340;
  let panelWidth = Number(localStorage.getItem(panelWidthKey)) || 380;
  let desktopSidebar = localStorage.getItem(sidebarStateKey) !== 'collapsed';
  let drawer = false;
  let panelTrigger: HTMLElement;
  const viewport = window.visualViewport;

  function clamp(value: number, min: number, max: number) {
    return Math.round(Math.max(min, Math.min(value, max)));
  }
  function sidebarSize(value = sidebarWidth) {
    return clamp(value, sidebarMin, sidebarMax);
  }
  function derive() {
    const mobile = narrow.matches;
    const left = sidebarSize();
    const space = innerWidth - (desktopSidebar ? left : collapsedWidth) - mainMin;
    const rightMax = Math.round(Math.max(panelMin, Math.min(innerWidth * 0.48, space)));
    const floating = mobile || space < panelMin;
    const panelOpen = tabs.panelOpen();
    const panelModal = floating && panelOpen;
    return {
      mobile,
      left,
      rightMax,
      floating,
      panelOpen,
      panelModal,
      right: clamp(panelWidth, panelMin, rightMax),
      modal: panelModal ? panel : mobile && drawer ? sidebar : undefined,
    };
  }
  let geometry = derive();
  function render() {
    geometry = derive();
    const { mobile, left, right, rightMax, floating, panelOpen, panelModal, modal } = geometry;
    const focused = document.activeElement;
    const focusPanel = panelModal && (!panel.contains(focused) || focused === panelResize);
    if (focusPanel && focused instanceof HTMLElement && focused !== document.body && !panel.contains(focused))
      panelTrigger = focused;
    root.classList.toggle('navigation-drawer', mobile);
    sidebar.classList.toggle('open', mobile && drawer);
    sidebarClose.hidden = !mobile;
    sidebar.inert = panelModal || (mobile && !drawer);
    sidebarResize.hidden = mobile || !desktopSidebar;
    root.classList.toggle('sidebar-collapsed', !mobile && !desktopSidebar);
    root.classList.toggle('right-open', panelOpen);
    root.classList.toggle('panel-drawer', floating);
    panelResize.hidden = !panelOpen || floating;
    sidebarButton.setAttribute('aria-expanded', String(mobile ? drawer : desktopSidebar));
    panelButton.setAttribute('aria-expanded', String(panelOpen));
    panel.inert = !panelOpen;
    main.inert = Boolean(modal);
    overlay.hidden = !modal;
    overlay.setAttribute('aria-label', panelModal ? 'Dismiss workspace panel' : 'Close navigation');
    for (const element of [sidebar, panel]) {
      if (element === modal) {
        element.setAttribute('role', 'dialog');
        element.setAttribute('aria-modal', 'true');
      } else {
        element.removeAttribute('role');
        element.removeAttribute('aria-modal');
      }
    }
    root.style.setProperty('--left-width', (desktopSidebar ? left : collapsedWidth) + 'px');
    root.style.setProperty('--right-width', right + 'px');
    for (const [handle, size, min, max] of [
      [sidebarResize, left, sidebarMin, sidebarMax],
      [panelResize, right, panelMin, rightMax],
    ] as const) {
      handle.setAttribute('aria-valuenow', String(size));
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(max));
    }
    if (focusPanel) panelClose.focus();
  }

  function closeDrawer(restore = true) {
    if (!drawer) return;
    drawer = false;
    render();
    if (restore) sidebarButton.focus();
  }
  function panelChanged(focus: boolean) {
    const open = tabs.panelOpen();
    if (open === geometry.panelOpen) return;
    if (open) {
      const origin = document.activeElement as HTMLElement;
      panelTrigger = origin && !panel.contains(origin) && !sidebar.contains(origin) ? origin : panelButton;
    }
    if (open) drawer = false;
    if (!open && panel.contains(document.activeElement)) focus = true;
    render();
    if (open && focus && !geometry.floating) panelClose.focus();
    if (!open && focus)
      (panelTrigger?.isConnected && !panelTrigger.closest('[inert]') ? panelTrigger : panelButton).focus();
  }
  sidebarButton.onclick = () => {
    if (narrow.matches) {
      if (drawer) closeDrawer();
      else {
        tabs.setPanel(false);
        drawer = true;
        render();
        sidebarClose.focus();
      }
    } else {
      desktopSidebar = !desktopSidebar;
      localStorage.setItem(sidebarStateKey, desktopSidebar ? 'open' : 'collapsed');
      render();
    }
  };
  sidebarClose.onclick = () => closeDrawer();
  panelClose.onclick = () => tabs.setPanel(false, true);
  overlay.onclick = () => {
    if (tabs.panelOpen()) tabs.setPanel(false, true);
    else closeDrawer();
  };
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape' && (tabs.panelOpen() || drawer)) {
        if (document.querySelector(':popover-open')) return;
        event.preventDefault();
        if (tabs.panelOpen()) tabs.setPanel(false, true);
        else closeDrawer();
      }
      const container = geometry.modal;
      if (event.key !== 'Tab' || !container) return;
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
    direction: 1 | -1,
    key: string,
    currentSize: () => number,
    preferredSize: () => number,
    setWidth: (value: number) => void,
  ) {
    let drag: { id: number; start: number; width: number } | undefined;
    const save = () => localStorage.setItem(key, String(preferredSize()));
    handle.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        handle.focus();
        drag = { id: event.pointerId, start: event.clientX, width: currentSize() };
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
        setWidth(currentSize() + direction * delta);
        render();
        save();
      },
      { signal },
    );
  }

  bindResize(
    sidebarResize,
    1,
    sidebarWidthKey,
    () => geometry.left,
    () => sidebarWidth,
    (value) => {
      sidebarWidth = sidebarSize(value);
    },
  );
  bindResize(
    panelResize,
    -1,
    panelWidthKey,
    () => geometry.right,
    () => panelWidth,
    (value) => {
      panelWidth = clamp(value, panelMin, geometry.rightMax);
    },
  );

  function resize() {
    const closesNavigation = geometry.mobile !== narrow.matches && drawer;
    if (closesNavigation) drawer = false;
    document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
    render();
    if (closesNavigation) sidebarButton.focus();
  }
  viewport?.addEventListener('resize', resize, { signal });
  window.addEventListener('resize', resize, { signal });
  resize();
  signal.addEventListener('abort', () => document.documentElement.style.removeProperty('--app-height'), {
    once: true,
  });
  return {
    closeDrawer,
    panelChanged,
  };
}
