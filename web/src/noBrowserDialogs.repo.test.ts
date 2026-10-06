/// <reference types="node" />
// web-ui-system "Themed confirmations replace browser chrome", scenario "No browser-native
// confirm/prompt remains" (shadcn-shared-wrappers D7): the frontend never calls
// `window.confirm`/`window.prompt` or the bare `confirm()`/`prompt()` globals. Comment prose
// and the `useConfirm` hook's own `confirm` are not matches. Themed replacements: `useConfirm`
// (shared/ui/ConfirmDialog) and `useTextPrompt` (shared/ui/PromptDialog).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findBrowserDialogCalls } from './test/browserDialogCalls';

describe('findBrowserDialogCalls (detector)', () => {
  it('flags window.confirm / window.prompt and the bare globals', () => {
    expect(findBrowserDialogCalls("if (window.confirm('Delete?')) go();")).toEqual([1]);
    expect(findBrowserDialogCalls("const raw = window.prompt('URL?');")).toEqual([1]);
    expect(findBrowserDialogCalls("const raw = prompt('URL?');")).toEqual([1]);
    expect(findBrowserDialogCalls("if (!confirm('Sure?')) return;")).toEqual([1]);
  });

  it('ignores comments, member calls on other objects, and similarly named identifiers', () => {
    expect(findBrowserDialogCalls('// was window.prompt(...)\n/* confirm() */')).toEqual([]);
    expect(
      findBrowserDialogCalls('onConfirm(); requestText({}); api.prompt(x); usePrompt();'),
    ).toEqual([]);
  });

  it("allows the useConfirm hook's own confirm in a file that destructures it", () => {
    const src =
      'const { confirm, confirmElement } = useConfirm();\nif (!(await confirm({ title }))) return;';
    expect(findBrowserDialogCalls(src)).toEqual([]);
  });
});

describe('web/src has no browser-native confirm/prompt', () => {
  it('finds zero occurrences in production source', () => {
    const SRC = path.dirname(fileURLToPath(import.meta.url));
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'test' ? [] : walk(p);
        return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
      });
    const hits = walk(SRC).flatMap((f) =>
      findBrowserDialogCalls(fs.readFileSync(f, 'utf8'), path.basename(f)).map(
        (line) => `${path.relative(SRC, f)}:${line}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});
