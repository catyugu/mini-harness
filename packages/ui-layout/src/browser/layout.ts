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
  const narrow = matchMedia('(max-width: 860px)');
  const sidebarWidthKey = 'mini-harness-sidebar-width';
  const panelWidthKey = 'mini-harness-panel-width';
  const sidebarMin = 280;
  const sidebarMax = 380;
  const collapsedWidth = 56;
  const panelMin = 260;
  const mainMin = 520;
  let sidebarWidth = Number(localStorage.getItem(sidebarWidthKey)) || 340;
  let panelWidth = Number(localStorage.getItem(panelWidthKey)) || 380;
  let desktopSidebar = localStorage.getItem('mini-harness-sidebar') !== 'collapsed';
  let drawer = false;
  let panelOpen = false;
  let panelTrigger: HTMLElement;
  const viewport = window.visualViewport;

  function clamp(value: number, min: number, max: number) {
    return Math.round(Math.max(min, Math.min(value, max)));
  }
  function sidebarSize(value = sidebarWidth) {
    return clamp(value, sidebarMin, sidebarMax);
  }
  function panelSpace() {
    return innerWidth - (desktopSidebar ? sidebarSize() : collapsedWidth) - mainMin;
  }
  function panelDrawer() {
    return narrow.matches || panelSpace() < panelMin;
  }
  function maxPanelWidth() {
    return Math.round(Math.max(panelMin, Math.min(innerWidth * 0.48, panelSpace())));
  }
  function panelSize(value = panelWidth) {
    return clamp(value, panelMin, maxPanelWidth());
  }
  function measure() {
    const left = sidebarSize();
    const right = panelSize();
    root.style.setProperty('--left-width', left + 'px');
    root.style.setProperty('--right-width', right + 'px');
    for (const [handle, size, min, max] of [
      [sidebarResize, left, sidebarMin, sidebarMax],
      [panelResize, right, panelMin, maxPanelWidth()],
    ] as const) {
      handle.setAttribute('aria-valuenow', String(size));
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(max));
    }
  }
  function render() {
    const mobile = narrow.matches;
    const floating = panelDrawer();
    const panelModal = floating && panelOpen;
    const focused = document.activeElement;
    const focusPanel = panelModal && (!panel.contains(focused) || focused === panelResize);
    if (focusPanel && focused instanceof HTMLElement && focused !== document.body && !panel.contains(focused))
      panelTrigger = focused;
    sidebar.classList.toggle('open', mobile && drawer);
    sidebar.inert = panelModal || (mobile && !drawer);
    sidebarResize.hidden = mobile || !desktopSidebar;
    root.classList.toggle('sidebar-collapsed', !mobile && !desktopSidebar);
    root.classList.toggle('right-open', panelOpen);
    root.classList.toggle('panel-drawer', floating);
    panelResize.hidden = !panelOpen || floating;
    sidebarButton.setAttribute('aria-expanded', String(mobile ? drawer : desktopSidebar));
    panelButton.setAttribute('aria-expanded', String(panelOpen));
    panel.inert = !panelOpen;
    const modal = panelModal || (mobile && drawer);
    const active = panelOpen ? panel : sidebar;
    main.inert = modal;
    overlay.hidden = !modal;
    overlay.setAttribute('aria-label', panelModal ? 'Dismiss workspace panel' : 'Close navigation');
    for (const element of [sidebar, panel]) {
      if (modal && element === active) {
        element.setAttribute('role', 'dialog');
        element.setAttribute('aria-modal', 'true');
      } else {
        element.removeAttribute('role');
        element.removeAttribute('aria-modal');
      }
    }
    measure();
    if (focusPanel) panelClose.focus();
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
      const origin = document.activeElement as HTMLElement;
      panelTrigger = origin && !panel.contains(origin) && !sidebar.contains(origin) ? origin : panelButton;
    }
    if (open) drawer = false;
    if (!open && panel.contains(document.activeElement)) focus = true;
    panelOpen = open;
    render();
    if (open && focus && !panelDrawer()) panelClose.focus();
    if (!open && focus)
      (panelTrigger?.isConnected && !panelTrigger.closest('[inert]') ? panelTrigger : panelButton).focus();
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
    if (panelOpen) setPanel(false, true);
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
      if (event.key === 'Escape' && (panelOpen || drawer)) {
        if (document.querySelector(':popover-open')) return;
        event.preventDefault();
        if (panelOpen) setPanel(false, true);
        else closeDrawer();
      }
      if (event.key !== 'Tab' || !((panelOpen && panelDrawer()) || (drawer && narrow.matches))) return;
      const container = panelOpen ? panel : sidebar;
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
    getWidth: () => number,
    setWidth: (value: number) => void,
  ) {
    let drag: { id: number; start: number; width: number } | undefined;
    const save = () => localStorage.setItem(key, String(getWidth()));
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
        setWidth(Number(handle.getAttribute('aria-valuenow')) + direction * delta);
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
    () => sidebarWidth,
    (value) => {
      sidebarWidth = sidebarSize(value);
    },
  );
  bindResize(
    panelResize,
    panel,
    -1,
    panelWidthKey,
    () => panelWidth,
    (value) => {
      panelWidth = panelSize(value);
    },
  );

  function resize() {
    document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
    render();
  }
  viewport?.addEventListener('resize', resize, { signal });
  window.addEventListener('resize', resize, { signal });
  resize();
  return {
    closeDrawer,
    setPanel,
    panelOpen: () => panelOpen,
    onPanelVisibilityChange(listener: () => void) {
      panel.addEventListener('panel-visibility', listener, { signal });
    },
  };
}
