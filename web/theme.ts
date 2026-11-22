// Runs before styles are painted. Settings remain authoritative after bootstrap.
try {
  const theme = localStorage.getItem('mini-harness-theme');
  if (['light', 'dark', 'system'].includes(theme)) document.documentElement.dataset.theme = theme;
} catch { /* Storage can be unavailable in a private browser. */ }
