// QA contrast probe (shadcn migration, plan Phase 0). Run in-page via
// `agent-browser eval "$(cat contrast.js)"`. For every visible element with its
// own text (plus input placeholders) it composites the text colour over the
// effective background (ancestor background-color layers; gradients use their
// first colour stop and are flagged approx) and reports WCAG ratios.
(() => {
  const parse = (s) => {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, bot) => {
    const a = top[3] + bot[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // Every gradient layer contributes one stop: the one that gives the LOWEST contrast against
  // this text colour (conservative). Layers paint bottom-up: background-color, then
  // background-image layers last-to-first. Ancestors are walked until an opaque layer.
  const stopsOf = (img) => img.split(/(?:linear|radial|conic)-gradient\(/).slice(1)
    .map((seg) => [...seg.matchAll(/rgba?\([^)]+\)|transparent/g)].map((m) => m[0] === 'transparent' ? [0, 0, 0, 0] : parse(m[0])));
  const bgOf = (el, fg) => {
    const layers = []; let approx = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const img = cs.backgroundImage;
      const own = [];
      if (img && img !== 'none') { const g = stopsOf(img); if (g.length) { approx = true; own.push(...g.map((stops) => ({ stops }))); } }
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) own.push({ stops: [c] });
      layers.push(...own); // own is top-first; whole list stays top-first
      if (c && c[3] >= 1) break;
    }
    let acc = [255, 255, 255, 1]; // browser canvas default when no ancestor is opaque
    for (let i = layers.length - 1; i >= 0; i--) {
      let worst = null, wr = Infinity;
      for (const st of layers[i].stops) {
        const cand = over(st, acc); const r = ratio(over(fg, cand), cand);
        if (r < wr) { wr = r; worst = cand; }
      }
      acc = worst || acc;
    }
    return { bg: acc, approx };
  };
  const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const label = (el) => {
    const id = el.getAttribute('data-testid');
    const cls = (el.getAttribute('class') || '').split(/\s+/).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (id ? `[data-testid=${id}]` : '') + (cls ? '.' + cls : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[aria-hidden="true"]');
  };
  const rows = [];
  const check = (el, text, fgStr, kind) => {
    const fg = parse(fgStr); if (!fg) return;
    const disabled = el.closest(':disabled,[aria-disabled="true"],[data-disabled]') !== null;
    const op = opacityOf(el); if (op < 0.05) return;
    const f = fg.slice(); f[3] *= op;
    const { bg, approx } = bgOf(el, f);
    const r = ratio(over(f, bg), bg);
    rows.push({ el: label(el), kind, text: text.slice(0, 40), ratio: Math.round(r * 100) / 100, approx, disabled, bg: bg.slice(0, 3).map(Math.round) });
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(el.tagName) || !visible(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) check(el, own, getComputedStyle(el).color, 'text');
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder && !el.value)
      check(el, el.placeholder, getComputedStyle(el, '::placeholder').color, 'placeholder');
  }
  const fails = rows.filter((r) => r.ratio < 4.5 && !r.disabled);
  return JSON.stringify({ url: location.pathname, checked: rows.length, fails: fails.length, approx: rows.filter((r) => r.approx).length, min: Math.min(...rows.map((r) => r.ratio)), failures: fails }, null, 1);
})()
