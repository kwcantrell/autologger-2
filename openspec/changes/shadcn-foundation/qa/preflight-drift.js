// QA helper (shadcn-foundation task 2.3/4.1): which elements does Preflight change?
// Snapshot computed styles with Preflight, delete Preflight's rules from @layer base
// (identified by its first selector `*, ::after, ::before, ::backdrop, ::file-selector-button`
// up to the end of the preflight block), snapshot again, report per-element property diffs.
(() => {
  const PROPS = ['margin-top','margin-bottom','margin-left','margin-right','padding-top','padding-bottom','padding-left','padding-right',
    'border-top-width','border-bottom-width','border-left-width','border-right-width','border-top-style','display','vertical-align',
    'line-height','font-size','font-weight','font-family','letter-spacing','list-style-type','color','background-color','text-decoration-line','height','width'];
  const els = [...document.querySelectorAll('body *')].filter((e) => !e.closest('nextjs-portal') && e.getClientRects().length);
  const snap = () => els.map((e) => { const cs = getComputedStyle(e); return PROPS.map((p) => cs.getPropertyValue(p)); });
  const before = snap();
  // find preflight rules: in a base layer block, from the universal reset rule through the [hidden] rule
  const removed = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const visit = (list, owner) => {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.cssRules && r.name === 'base') {
          const sub = r.cssRules; let start = -1, end = -1;
          for (let j = 0; j < sub.length; j++) {
            const t = sub[j].selectorText || '';
            if (start < 0 && /^\*, ::after, ::before, ::backdrop/.test(t)) start = j;
            if (start >= 0 && /\[hidden\]:where\(:not\(\[hidden="until-found"\]\)\)/.test(t)) { end = j; break; }
          }
          if (start >= 0 && end >= start) { for (let j = end; j >= start; j--) { removed.push(sub[j].cssText.slice(0, 60)); r.deleteRule(j); } }
        } else if (r.cssRules) visit(r.cssRules, r);
      }
    };
    visit(rules, sheet);
  }
  const after = snap();
  const label = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ((e.getAttribute('class') || '') ? '.' + (e.getAttribute('class') || '').split(/\s+/).slice(0, 4).join('.') : '') + ' "' + (e.textContent || '').trim().slice(0, 24) + '"';
  const diffs = [];
  els.forEach((e, i) => {
    const d = PROPS.map((p, k) => before[i][k] !== after[i][k] ? `${p}: ${after[i][k]} → ${before[i][k]}` : null).filter(Boolean)
      .filter((s) => !/^(height|width):/.test(s));
    if (d.length) diffs.push(label(e) + ' :: ' + d.join('; '));
  });
  return JSON.stringify({ removedRules: removed.length, changed: diffs.length, diffs: diffs.slice(0, 80) });
})()
