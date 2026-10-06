(() => {
  // The visible feed tab's FeedTable (shadcn-port-workspace QA): scroll element, sticky header,
  // windowing, and row height.
  const panel = document.querySelector('[role=tabpanel]:not([hidden])');
  const vp = panel && panel.querySelector('[data-slot=scroll-area-viewport]');
  if (!vp) return JSON.stringify({ error: 'no feed viewport in the visible tab' });
  vp.scrollTop = Math.min(1200, vp.scrollHeight);
  vp.dispatchEvent(new Event('scroll'));
  const th = panel.querySelector('thead th');
  // Data rows: every body row except the virtualizer's single-cell spacer/sentinel rows.
  const rows = [...panel.querySelectorAll('tbody tr')].filter((r) => r.cells.length > 1);
  const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height * 100) / 100);
  return JSON.stringify({
    panel: panel.getAttribute('aria-label'),
    overflowX: getComputedStyle(vp).overflowX, vpClientW: vp.clientWidth, vpScrollW: vp.scrollWidth,
    vpClientH: vp.clientHeight, vpScrollH: vp.scrollHeight, scrolls: vp.clientHeight < vp.scrollHeight,
    scrollTop: vp.scrollTop,
    stickyOffset: th ? Math.round(th.getBoundingClientRect().top - vp.getBoundingClientRect().top) : null,
    mountedRows: rows.length,
    maxRowH: heights.length ? Math.max(...heights) : null, minRowH: heights.length ? Math.min(...heights) : null,
  });
})()
