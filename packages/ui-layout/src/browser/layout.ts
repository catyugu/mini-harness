interface LayoutElements {
  root: HTMLElement;
  sidebar: HTMLElement;
  sidebarButton: HTMLElement;
  sidebarClose: HTMLElement;
  main: HTMLElement;
  overlay: HTMLElement;
  panel: HTMLElement;
  panelButton: HTMLElement;
  panelClose: HTMLElement;
  resizeHandle: HTMLElement;
}

export function createLayout(view: LayoutElements, signal: AbortSignal) {
  const {
    root,
    sidebar,
    sidebarButton,
    sidebarClose,
    main,
    overlay,
    panel,
    panelButton,
    panelClose,
    resizeHandle,
  } = view;
  const narrow = matchMedia('(max-width: 860px)');
  const widthKey = 'mini-harness-panel-width';
  let width = Number(localStorage.getItem(widthKey)) || 380;
  let desktopSidebar = localStorage.getItem('mini-harness-sidebar') !== 'collapsed';
  let drawer = false;
  let panelOpen = false;
  let panelTrigger: HTMLElement;
  const viewport = window.visualViewport;

  function clamp(value: number) {
    return Math.round(
      Math.max(260, Math.min(value, innerWidth * 0.48, innerWidth - (desktopSidebar ? 280 : 56) - 300)),
    );
  }
  function measure(value = width) {
    const size = clamp(value);
    root.style.setProperty('--right-width', size + 'px');
    resizeHandle.setAttribute('aria-valuenow', String(size));
    resizeHandle.setAttribute('aria-valuemax', String(clamp(innerWidth)));
  }
  function render() {
    const mobile = narrow.matches;
    sidebar.classList.toggle('open', mobile && drawer);
    sidebar.inert = mobile && (!drawer || panelOpen);
    root.classList.toggle('sidebar-collapsed', !mobile && !desktopSidebar);
    root.classList.toggle('right-open', panelOpen);
    sidebarButton.setAttribute('aria-expanded', String(mobile ? drawer : desktopSidebar));
    panelButton.setAttribute('aria-expanded', String(panelOpen));
    panel.inert = !panelOpen;
    const modal = mobile && (drawer || panelOpen);
    const active = panelOpen ? panel : sidebar;
    main.inert = modal;
    overlay.hidden = !modal;
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
  }

  function closeDrawer(restore = true) {
    if (!drawer) return;
    drawer = false;
    render();
    if (restore) sidebarButton.focus();
  }
  function setPanel(open: boolean, focus = false) {
    if (open === panelOpen) return;
    if (open && focus) {
      const origin = document.activeElement as HTMLElement;
      panelTrigger = origin && !panel.contains(origin) && !sidebar.contains(origin) ? origin : panelButton;
    }
    if (open) drawer = false;
    if (!open && panel.contains(document.activeElement)) focus = true;
    panelOpen = open;
    render();
    if (open && (focus || narrow.matches)) panelClose.focus();
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
      if (event.key !== 'Tab' || !narrow.matches || (!drawer && !panelOpen)) return;
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

  let drag: { id: number; start: number; width: number } | undefined;
  resizeHandle.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { id: event.pointerId, start: event.clientX, width: panel.getBoundingClientRect().width };
      root.classList.add('resizing-panel');
      resizeHandle.setPointerCapture(event.pointerId);
    },
    { signal },
  );
  resizeHandle.addEventListener(
    'pointermove',
    (event) => {
      if (drag?.id !== event.pointerId) return;
      width = clamp(drag.width + drag.start - event.clientX);
      measure();
    },
    { signal },
  );
  resizeHandle.addEventListener(
    'lostpointercapture',
    () => {
      drag = undefined;
      root.classList.remove('resizing-panel');
      localStorage.setItem(widthKey, String(width));
    },
    { signal },
  );
  resizeHandle.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      width = clamp(clamp(width) + (event.key === 'ArrowLeft' ? 20 : -20));
      measure();
      localStorage.setItem(widthKey, String(width));
    },
    { signal },
  );

  function resize() {
    document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
    measure();
  }
  viewport?.addEventListener('resize', resize, { signal });
  window.addEventListener('resize', resize, { signal });
  resize();
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
