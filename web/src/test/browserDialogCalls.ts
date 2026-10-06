// Detector for noBrowserDialogs.repo.test.ts (shadcn-shared-wrappers D7). Returns the 1-based
// line numbers of browser-native dialog calls in `source`: `window.confirm(` / `window.prompt(`,
// and the bare `confirm(` / `prompt(` globals. Comments are stripped first. A bare `confirm(` is
// allowed when the file destructures `confirm` from `useConfirm()` (the themed hook's own API),
// or when the file is ConfirmDialog.tsx, which defines that hook.

const WINDOW_CALL = /\bwindow\s*\.\s*(confirm|prompt)\s*\(/;
const BARE_PROMPT = /(?<![\w$.])prompt\s*\(/;
const BARE_CONFIRM = /(?<![\w$.])confirm\s*\(/;
const USES_CONFIRM_HOOK = /\{[^}]*\bconfirm\b[^}]*\}\s*=\s*useConfirm\s*\(/;

/** Blank out block and line comments, keeping line breaks so line numbers stay true. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, (_m, lead: string) => lead);
}

export function findBrowserDialogCalls(source: string, fileName = ''): number[] {
  const code = stripComments(source);
  const confirmIsHook = USES_CONFIRM_HOOK.test(code) || fileName === 'ConfirmDialog.tsx';
  const hits: number[] = [];
  code.split('\n').forEach((line, i) => {
    if (
      WINDOW_CALL.test(line) ||
      BARE_PROMPT.test(line) ||
      (!confirmIsHook && BARE_CONFIRM.test(line))
    ) {
      hits.push(i + 1);
    }
  });
  return hits;
}
