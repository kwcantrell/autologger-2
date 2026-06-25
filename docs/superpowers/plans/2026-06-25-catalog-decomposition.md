# Catalog Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 978-line god class `Catalog` (`src/db/d1.ts`) into five focused, composed domain stores behind a thin delegating facade, with zero behavior change.

**Architecture:** `Catalog` stays the public class behind the per-request `c.get('catalog')` Hono context var, but its body becomes a thin facade: it constructs `StudioRegistry`, `AuthStore`, `ShowsStore`, `SessionIndexStore`, and `ProfileAssembler`, exposes them as `readonly` props, and delegates every router-called method to the relevant store. Extraction proceeds in dependency order (leaves first) so the worker compiles and behaves identically after every task.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `noUnusedLocals`), Cloudflare Workers + D1, Hono, Zod, vitest (new, for pure-function tests).

## Global Constraints

- **No behavior change.** JSON output of every endpoint must be byte-identical. The README's "Same JSON Shapes" frontend-compatibility invariant is the acceptance bar.
- **Blast radius stays in `src/db/`.** No router, no `src/middleware/auth.ts`, no `src/types.ts`, no `src/auth/identity.ts` edits. The facade preserves `new Catalog(db)`, `init()`, and the full router-called method surface.
- **`verbatimModuleSyntax: true`** — every type-only import/export MUST use `import type` / `export type`. Value imports (classes, functions, consts) use plain `import`.
- **`noUnusedLocals` / `noUnusedParameters: true`** — no unused locals or params. (Unused class methods are NOT flagged, so un-delegated store methods are fine.)
- **`D1Database`** is an ambient global from `worker-configuration.d.ts` — never import it.
- **Verify after every task:** `npm run typecheck` (`tsc --noEmit`) passes AND `npx vitest run` passes before committing.
- **Move bodies verbatim.** When a task says "move method X (lines A–B)," copy the method body exactly; apply ONLY the explicitly-listed cross-store rewrites. Do not refactor logic.
- **The two dead methods** `getShowShowCode` and `setSessionEpisodeDate` have zero callers anywhere. Relocate them faithfully (into their store, NOT delegated on the facade) and leave a `// TODO(cleanup): no callers — candidate for removal in a separate pass` comment. Do not remove them in this refactor.

---

## File structure (end state)

- `src/db/shared.ts` (new) — `Row`, `AuthUser`, `ProfileCtx` types + `nowIso()` helper. No imports from other `db/` files (breaks the facade↔store import cycle).
- `src/db/studioRegistry.ts` (new) — `StudioRegistry`: registry state (`order`/`names`), settings, settings blobs, admin studio ops.
- `src/db/authStore.ts` (new) — `AuthStore`: users, memberships, prefs, admin user ops.
- `src/db/showsStore.ts` (new) — `ShowsStore`: shows CRUD + the pure shapers.
- `src/db/sessionIndexStore.ts` (new) — `SessionIndexStore(db, studios, shows)`: sessions index + live projection.
- `src/db/profileAssembler.ts` (new) — `ProfileAssembler(studios, auth, shows)`: `profilePayload` orchestrator.
- `src/db/d1.ts` (slimmed) — `Catalog` facade: constructs the five stores, re-exports types + shapers, delegates the router surface.
- `src/db/showsStore.test.ts` (new) — characterization tests for the pure shapers.
- `src/db/d1.test.ts` (new) — facade smoke test.

---

## Task 1: Stand up vitest + characterization tests for the pure shapers

Lock the current output of the pure functions BEFORE they move, so the move is provably behavior-preserving. Test the two exported functions (`showApiDict`, `showCategoriesApiShape`) — they transitively exercise the three private helpers (`hexColorsFromJson`, `categoriesListFromShowRow`, `dropdownOptionsApiShape`).

**Files:**
- Modify: `package.json` (add `test` script + `vitest` devDep)
- Test: `src/db/showsStore.test.ts` (created now, importing from `./d1`; re-pointed to `./showsStore` in Task 3)

**Interfaces:**
- Consumes: `showApiDict(r: Row)`, `showCategoriesApiShape(rawCategories: unknown)` — currently exported from `src/db/d1.ts`.
- Produces: a green test suite other tasks must keep green.

- [ ] **Step 1: Add vitest as a dev dependency**

Run:
```bash
npm install -D vitest@^2.1.8
```
Expected: `package.json` gains `"vitest"` under `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Add the `test` script to `package.json`**

In `package.json`, add a `test` entry to the `scripts` object (place it after `"typecheck"`):
```json
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
```

- [ ] **Step 3: Write the characterization tests**

Create `src/db/showsStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { showApiDict, showCategoriesApiShape } from './d1';

describe('showApiDict', () => {
  it('shapes a full show row with a custom palette', () => {
    const row = {
      id: 'sh1',
      studio_id: 'st1',
      name: 'My Show',
      show_code: 'MS',
      next_episode: 3,
      categories_json: '[{"label":"Cue","type":"BUTTON","color":"#ff0000"}]',
      event_palette_json: '["#111111","#222222"]',
      event_palette_preset: 'custom',
      event_palette_custom_json: '["#333333"]',
    };
    expect(showApiDict(row)).toEqual({
      id: 'sh1',
      studio_id: 'st1',
      name: 'My Show',
      show_code: 'MS',
      next_episode: 3,
      categories: [{ label: 'Cue', type: 'BUTTON', color: '#ff0000' }],
      event_palette: ['#111111', '#222222', '', '', '', '', '', '', ''],
      event_palette_preset: 'custom',
      event_palette_custom: ['#333333', '', '', '', '', '', '', '', ''],
    });
  });

  it('defaults next_episode to 1 and empty palettes/categories on bad JSON', () => {
    const row = {
      id: 'sh2',
      studio_id: 'st2',
      name: 'Bare',
      show_code: 'BR',
      next_episode: 0,
      categories_json: 'not json',
      event_palette_json: 'not json',
      event_palette_preset: '',
      event_palette_custom_json: 'not json',
    };
    const out = showApiDict(row);
    expect(out.next_episode).toBe(1);
    expect(out.categories).toEqual([]);
    expect(out.event_palette).toEqual(['', '', '', '', '', '', '', '', '']);
    // empty custom falls back to a copy of the (empty) palette
    expect(out.event_palette_custom).toEqual(['', '', '', '', '', '', '', '', '']);
    expect(out.event_palette_preset).toBe('custom');
  });
});

describe('showCategoriesApiShape', () => {
  it('shapes BUTTON and DROPDOWN categories, dropping non-objects', () => {
    const raw = [
      { id: 'c1', label: 'Mic', color: '#7cb7ff', type: 'button' },
      {
        id: 'c2',
        name: 'Scene',
        type: 'dropdown',
        dropdown_options: ['One', { label: 'Two', needs_context: true }, { name: '' }],
        on_label: 'ON',
        off_label: 'OFF',
      },
      'garbage',
      null,
    ];
    expect(showCategoriesApiShape(raw)).toEqual([
      {
        id: 'c1',
        label: 'Mic',
        color: '#7cb7ff',
        type: 'BUTTON',
        dropdown_options: [],
        on_label: '',
        off_label: '',
      },
      {
        id: 'c2',
        label: 'Scene',
        color: '#7cb7ff',
        type: 'DROPDOWN',
        dropdown_options: [
          { label: 'One', needs_context: false },
          { label: 'Two', needs_context: true },
        ],
        on_label: 'ON',
        off_label: 'OFF',
      },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(showCategoriesApiShape('nope')).toEqual([]);
    expect(showCategoriesApiShape(null)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the tests; they must pass against the current code**

Run: `npx vitest run`
Expected: PASS (both files compile against current `src/db/d1.ts` exports; 4 tests green). If any expectation disagrees with current output, FIX THE TEST to match current behavior (this is characterization — current behavior is the source of truth), not the implementation.

- [ ] **Step 5: Confirm typecheck still passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/db/showsStore.test.ts
git commit -m "test: add vitest + characterization tests for catalog pure shapers"
```

---

## Task 2: Extract shared types + `nowIso` into `src/db/shared.ts`

Break the future facade↔store import cycle by putting `Row`, `AuthUser`, `ProfileCtx`, and `nowIso()` in a leaf module. `d1.ts` re-exports the three types so `src/types.ts` and `src/auth/identity.ts` (which import them from `../db/d1`) keep working unchanged.

**Files:**
- Create: `src/db/shared.ts`
- Modify: `src/db/d1.ts` (remove local defs of `AuthUser`/`ProfileCtx`/`Row`/`nowIso`; import + re-export from `./shared`)

**Interfaces:**
- Produces: `shared.ts` exporting `interface AuthUser`, `interface ProfileCtx`, `type Row = Record<string, unknown>`, `function nowIso(): string`.

- [ ] **Step 1: Create `src/db/shared.ts`**

```ts
// Shared D1-layer types and helpers, kept dependency-free so both the Catalog
// facade and the individual domain stores can import them without a cycle.

export interface AuthUser {
  id: string;
  email: string;
  google_sub: string;
  given_name: string;
  family_name: string;
  picture_url: string;
}

export interface ProfileCtx {
  oauthConfigured: boolean;
  adminMeta: Record<string, boolean>;
}

export type Row = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 2: Update `src/db/d1.ts` to use and re-export the shared module**

In `src/db/d1.ts`:
1. DELETE the local `interface AuthUser` (lines 25–32), `interface ProfileCtx` (lines 34–37), `export type Row = Record<string, unknown>;` (line 39), and `function nowIso()` (lines 41–43).
2. Immediately AFTER the existing `import { ... } from '../studio';` block, add:
```ts
import { nowIso } from './shared';
import type { AuthUser, ProfileCtx, Row } from './shared';

export type { AuthUser, ProfileCtx, Row } from './shared';
```

(`nowIso` is a value import — it is still called by `authCreateUserGoogle`, `createShow`, `adminCreateStudio`, `authSetUserDisabled`. `AuthUser`/`ProfileCtx`/`Row` are type-only — note `import type` and `export type` per `verbatimModuleSyntax`.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `tsc` reports `AuthUser`/`Row`/`ProfileCtx` as unused value imports, confirm they are imported via `import type` — they are only used in type positions.)

- [ ] **Step 4: Tests still green**

Run: `npx vitest run`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/shared.ts src/db/d1.ts
git commit -m "refactor(db): extract shared Row/AuthUser/ProfileCtx/nowIso into shared.ts"
```

---

## Task 3: Extract `ShowsStore` + pure shapers into `src/db/showsStore.ts`

Shows CRUD and the pure shapers are self-contained (no calls into other domains), so this is the first store extraction. `d1.ts` re-exports the two public shapers so the three routers importing them (`shows.ts`, `companion.ts`, `events.ts`) are untouched.

**Files:**
- Create: `src/db/showsStore.ts`
- Modify: `src/db/d1.ts` (construct `ShowsStore`, delegate shows methods, remove moved bodies, re-export shapers)
- Modify: `src/db/showsStore.test.ts` (re-point import to `./showsStore`)

**Interfaces:**
- Produces: `class ShowsStore` with `constructor(private db: D1Database)` and methods `getShowRow(showId: string): Promise<Row | null>`, `getShowShowCode(showId: string): Promise<string>`, `listShowsForStudio(studioId: string): Promise<Row[]>`, `createShow(opts): Promise<string>`, `updateShowFields(showId: string, fields): Promise<boolean>`; exported functions `showApiDict(r: Row)`, `showCategoriesApiShape(rawCategories: unknown)`.
- Consumes: `nowIso`, `Row` from `./shared`; `normalizeEventPaletteNine`, `validateEventPalettePreset` from `../studio`.

- [ ] **Step 1: Create `src/db/showsStore.ts`**

Header + class skeleton (write this exactly):
```ts
// Shows CRUD + the pure per-show / per-category shaping functions the React
// app's api/types.ts expects. Moved verbatim out of d1.ts (Catalog).

import { normalizeEventPaletteNine, validateEventPalettePreset } from '../studio';
import { nowIso } from './shared';
import type { Row } from './shared';

function categoriesListFromShowRow(r: Row): unknown[] {
  // ... move verbatim from d1.ts lines 45–52 ...
}

function hexColorsFromJson(rawJson: unknown, maxCount = 9): string[] {
  // ... move verbatim from d1.ts lines 54–68 ...
}

/** _show_api_dict — the per-show shape the React app's api/types.ts expects. */
export function showApiDict(r: Row): Record<string, unknown> {
  // ... move verbatim from d1.ts lines 70–90 ...
}

function dropdownOptionsApiShape(raw: unknown): Array<{ label: string; needs_context: boolean }> {
  // ... move verbatim from d1.ts lines 942–956 ...
}

/** _show_categories_api_shape — label/color/type/dropdown_options/on-off for the browser. */
export function showCategoriesApiShape(rawCategories: unknown): Array<Record<string, unknown>> {
  // ... move verbatim from d1.ts lines 958–978 ...
}

export class ShowsStore {
  constructor(private db: D1Database) {}

  // Move these methods verbatim from d1.ts (strip the leading `async` indentation
  // is unchanged; bodies reference only this.db and the helpers above — NO cross-store edits):
  //   getShowRow              (d1.ts lines 375–377)
  //   getShowShowCode         (d1.ts lines 379–382)   // TODO(cleanup): no callers
  //   listShowsForStudio      (d1.ts lines 384–390)
  //   createShow              (d1.ts lines 392–420)
  //   updateShowFields        (d1.ts lines 422–464)
}
```
Move each referenced body verbatim into the marked locations. `getShowShowCode`/`createShow` use `this.db`; `createShow` uses `nowIso()` (now imported). `showApiDict` uses `normalizeEventPaletteNine`, `validateEventPalettePreset`, `hexColorsFromJson`, `categoriesListFromShowRow` — all in-module. Add the `// TODO(cleanup): no callers — candidate for removal in a separate pass` comment above `getShowShowCode`.

- [ ] **Step 2: Update `src/db/d1.ts` — construct the store, delegate, remove moved code, re-export shapers**

1. Add the class import near the top of `d1.ts` (import ONLY the class — `d1.ts` itself no longer calls the shapers, so importing them as locals would trip `noUnusedLocals`):
```ts
import { ShowsStore } from './showsStore';
```
2. Add the shaper re-export as a separate `export ... from` statement (so routers importing from `../db/d1` keep working without `d1.ts` holding an unused local):
```ts
export { showApiDict, showCategoriesApiShape } from './showsStore';
```
3. DELETE from `d1.ts`: the now-moved top-level functions `categoriesListFromShowRow` (45–52), `hexColorsFromJson` (54–68), `showApiDict` (70–90), `dropdownOptionsApiShape` (942–956), `showCategoriesApiShape` (958–978). Also remove `normalizeEventPaletteNine` and `validateEventPalettePreset` from the `'../studio'` import (they are no longer used in `d1.ts`).
4. DELETE the moved `Catalog` methods `getShowRow`, `getShowShowCode`, `listShowsForStudio`, `createShow`, `updateShowFields` (lines 375–464).
5. In the `Catalog` class, add a `shows` field and construct it. Change the constructor and add delegates:
```ts
  readonly shows = new ShowsStore(this.db);

  // (existing) constructor(private db: D1Database) {}  — leave as-is; field initializers run after super/param props.

  // --- shows delegates ---
  getShowRow = (showId: string) => this.shows.getShowRow(showId);
  getShowShowCode = (showId: string) => this.shows.getShowShowCode(showId);
  listShowsForStudio = (studioId: string) => this.shows.listShowsForStudio(studioId);
  createShow = (opts: Parameters<ShowsStore['createShow']>[0]) => this.shows.createShow(opts);
  updateShowFields = (showId: string, fields: Parameters<ShowsStore['updateShowFields']>[1]) =>
    this.shows.updateShowFields(showId, fields);
```
Note: `readonly shows = new ShowsStore(this.db)` is a class field initializer — valid because `db` is a constructor parameter property and field initializers run inside the constructor after parameter properties are assigned. The internal `Catalog` callers of these methods (e.g. `profilePayload` calling `this.listShowsForStudio`, session methods calling `this.getShowRow`) keep working because the same-named delegate forwards to the store.

- [ ] **Step 3: Re-point the characterization test import**

In `src/db/showsStore.test.ts`, change line 2:
```ts
import { showApiDict, showCategoriesApiShape } from './showsStore';
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `tsc` flags `normalizeEventPaletteNine`/`validateEventPalettePreset` as unused in `d1.ts`, you missed removing them from the `'../studio'` import — remove them.

- [ ] **Step 5: Tests green**

Run: `npx vitest run`
Expected: PASS (4 tests, now importing from `./showsStore`).

- [ ] **Step 6: Commit**

```bash
git add src/db/showsStore.ts src/db/d1.ts src/db/showsStore.test.ts
git commit -m "refactor(db): extract ShowsStore + pure shapers from Catalog"
```

---

## Task 4: Extract `StudioRegistry` into `src/db/studioRegistry.ts`

The registry owns the shared `order`/`names` state plus settings, settings blobs, and admin studio ops. Because the STATE fields move here, any still-in-`Catalog` method that reads `this.order` / `this.names` directly must be rewritten to call the registry (delegates cover method calls, but not raw field access).

**Files:**
- Create: `src/db/studioRegistry.ts`
- Modify: `src/db/d1.ts`

**Interfaces:**
- Produces: `class StudioRegistry` with `constructor(private db: D1Database)` and methods: `init(): Promise<void>`, `refreshStudioRegistry(): Promise<void>`, `studioOrderTuple(): string[]`, `studioNamesDict(): Record<string, string>`, `isKnownStudio` (arrow: `(studioId: string) => boolean`), `getSetting(key, def?)`, `setSetting(key, value)`, `getStudioSettingsBlob(studioIdIn)`, `saveStudioSettingsBlob(studioId, blob)`, `loadStudioProfile(studioId)`, `resolveActiveStudio()`, `allStudioSettingsForAllowedStudios(allowedIds)`, `listStudiosBrief()`, `listStudiosBriefAllowed(allowedIds)`, `adminCreateStudio(studioId, displayName)`, `adminDeleteStudio(studioId)`.
- Consumes: from `../studio`: `BUILTIN_STUDIO_NAMES`, `BUILTIN_STUDIO_ORDER`, `DEFAULT_STUDIO_ID`, `blobToProfile`, `defaultSettingsBlob`, `SETTING_ACTIVE_STUDIO`, `studioConfigKey`, `ValidationError`, `validateSettingsBlob`, type `SettingsBlob`, type `StudioProfile`. From `./shared`: `nowIso`, type `Row`.

- [ ] **Step 1: Create `src/db/studioRegistry.ts`**

```ts
// Studio registry (built-ins merged with studio_definitions), app_settings,
// per-studio settings blobs, and admin studio create/delete. Moved verbatim
// out of d1.ts (Catalog) — this module owns the order/names registry state.

import {
  BUILTIN_STUDIO_NAMES,
  BUILTIN_STUDIO_ORDER,
  blobToProfile,
  DEFAULT_STUDIO_ID,
  defaultSettingsBlob,
  SETTING_ACTIVE_STUDIO,
  studioConfigKey,
  ValidationError,
  validateSettingsBlob,
} from '../studio';
import type { SettingsBlob, StudioProfile } from '../studio';
import { nowIso } from './shared';
import type { Row } from './shared';

export class StudioRegistry {
  private order: string[] = [];
  private names: Record<string, string> = {};

  constructor(private db: D1Database) {}

  // Move the following verbatim from d1.ts. Bodies reference this.db / this.order /
  // this.names / this.getSetting / this.setSetting / this.getStudioSettingsBlob /
  // this.loadStudioProfile / this.isKnownStudio — ALL intra-registry, so NO cross-store edits:
  //   init                              (d1.ts 98–101)
  //   refreshStudioRegistry             (d1.ts 105–127)
  //   studioOrderTuple                  (d1.ts 129–131)
  //   studioNamesDict                   (d1.ts 133–135)
  //   isKnownStudio (arrow property)    (d1.ts 137)
  //   getSetting                        (d1.ts 141–147)
  //   setSetting                        (d1.ts 149–156)
  //   getStudioSettingsBlob             (d1.ts 160–187)
  //   saveStudioSettingsBlob            (d1.ts 189–192)
  //   loadStudioProfile                 (d1.ts 194–198)
  //   resolveActiveStudio               (d1.ts 200–204)
  //   allStudioSettingsForAllowedStudios(d1.ts 206–224)
  //   listStudiosBrief                  (d1.ts 226–228)
  //   listStudiosBriefAllowed           (d1.ts 230–235)
  //   STUDIO_ID_SLUG_RE (static field)  (d1.ts 888)
  //   adminCreateStudio                 (d1.ts 890–916)
  //   adminDeleteStudio                 (d1.ts 918–938)
}
```
Move each body verbatim. In `adminCreateStudio`/`adminDeleteStudio`, the reference `Catalog.STUDIO_ID_SLUG_RE` becomes `StudioRegistry.STUDIO_ID_SLUG_RE` (the static moved with them). `adminDeleteStudio` deletes `user_studio_memberships` rows via `this.db.batch([...])` — keep as-is (raw SQL, no cross-store call). `adminCreateStudio` uses `nowIso()` (imported).

- [ ] **Step 2: Update `src/db/d1.ts` — construct, delegate, remove moved code, rewrite remaining field reads**

1. Add import:
```ts
import { StudioRegistry } from './studioRegistry';
```
2. From the `'../studio'` import in `d1.ts`, REMOVE the names now used only by the registry: `BUILTIN_STUDIO_NAMES`, `BUILTIN_STUDIO_ORDER`, `defaultSettingsBlob`, `SETTING_ACTIVE_STUDIO`, `studioConfigKey`, `validateSettingsBlob`. KEEP names still used by code remaining in `d1.ts` (e.g. `DEFAULT_STUDIO_ID`, `blobToProfile`, `emptyActiveStudioApiDict`, `newSessionTitlePrefix`, `SETTING_ACTIVE_SHOW`, `studioToApiDict`, `ValidationError`, type `SettingsBlob`, type `StudioProfile`). After editing, let `tsc` (Step 4) tell you the exact unused set and trim accordingly.
3. DELETE from `Catalog`: the state fields `order`/`names` (lines 93–94), and every method listed in Task 4 Step 1 (init, refreshStudioRegistry, studioOrderTuple, studioNamesDict, isKnownStudio, getSetting, setSetting, getStudioSettingsBlob, saveStudioSettingsBlob, loadStudioProfile, resolveActiveStudio, allStudioSettingsForAllowedStudios, listStudiosBrief, listStudiosBriefAllowed, STUDIO_ID_SLUG_RE, adminCreateStudio, adminDeleteStudio).
4. Add the registry field + delegates to `Catalog`:
```ts
  readonly studios = new StudioRegistry(this.db);

  // --- studio registry / settings delegates ---
  init = () => this.studios.init();
  isKnownStudio = (studioId: string) => this.studios.isKnownStudio(studioId);
  studioOrderTuple = () => this.studios.studioOrderTuple();
  studioNamesDict = () => this.studios.studioNamesDict();
  getSetting = (key: string, def: string | null = null) => this.studios.getSetting(key, def);
  setSetting = (key: string, value: string) => this.studios.setSetting(key, value);
  saveStudioSettingsBlob = (studioId: string, blob: Record<string, unknown>) =>
    this.studios.saveStudioSettingsBlob(studioId, blob);
  listStudiosBrief = () => this.studios.listStudiosBrief();
  adminCreateStudio = (studioId: string, displayName: string) =>
    this.studios.adminCreateStudio(studioId, displayName);
  adminDeleteStudio = (studioId: string) => this.studios.adminDeleteStudio(studioId);
  // internal-use delegates (kept until their callers are extracted in Tasks 6–7):
  private getStudioSettingsBlob = (studioId: string) => this.studios.getStudioSettingsBlob(studioId);
  private loadStudioProfile = (studioId: string) => this.studios.loadStudioProfile(studioId);
  private resolveActiveStudio = () => this.studios.resolveActiveStudio();
  private allStudioSettingsForAllowedStudios = (allowedIds: Set<string> | null) =>
    this.studios.allStudioSettingsForAllowedStudios(allowedIds);
  private listStudiosBriefAllowed = (allowedIds: Set<string> | null) =>
    this.studios.listStudiosBriefAllowed(allowedIds);
```
5. **Rewrite raw field reads** in the methods that REMAIN in `Catalog` (they still reference the now-removed `this.order` / `this.names`). Apply these exact edits:
   - In `authSection` (d1.ts ~516–537): `this.order` → `this.studios.studioOrderTuple()`; `this.names` → `this.studios.studioNamesDict()`.
   - In `profileStudioForUser` (~480–502): `this.order` → `this.studios.studioOrderTuple()`.
   - In `studioProfileForSession` (~834–846): `this.names` → `this.studios.studioNamesDict()`.
   (All other references in remaining methods are method calls like `this.resolveActiveStudio()` / `this.getSetting()` — covered by the delegates above; leave them.)

- [ ] **Step 3: Watch for `noUnusedLocals` on private delegates**

`getStudioSettingsBlob`, `loadStudioProfile`, `resolveActiveStudio`, `allStudioSettingsForAllowedStudios`, `listStudiosBriefAllowed` are marked `private` and ARE still called by remaining methods (`profilePayload`, `studioProfileForSession`, etc.), so they are used. `noUnusedLocals` does not flag class methods/fields anyway. No action unless `tsc` says otherwise.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. `tsc` will pinpoint any missed `this.order`/`this.names` read or any now-unused `'../studio'` import — fix each it names.

- [ ] **Step 5: Tests green**

Run: `npx vitest run`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/studioRegistry.ts src/db/d1.ts
git commit -m "refactor(db): extract StudioRegistry (registry state, settings, admin studios)"
```

---

## Task 5: Extract `AuthStore` into `src/db/authStore.ts`

All `auth*` user/membership/prefs methods plus the admin-user ops are self-contained on `this.db` (their internal calls are to other auth methods). No cross-store rewrites.

**Files:**
- Create: `src/db/authStore.ts`
- Modify: `src/db/d1.ts`

**Interfaces:**
- Produces: `class AuthStore` with `constructor(private db: D1Database)` and methods `authGetUserByGoogleSub`, `authGetUserById`, `authCreateUserGoogle`, `authUpdateUserProfile`, `authUpdateUserNames`, `authUserHasStudio`, `authListStudioIdsForUser`, `authAddMemberships`, `authGetPrefs`, `authEnsurePrefsRow`, `authSetPrefs`, `authSeedPrefsFromGlobals`, `authListUsersAdmin`, `authGetUserRowAny`, `authSetUserDisabled`, `authRemoveMembership` (same signatures as the current `Catalog` methods).
- Consumes: `nowIso`, type `Row` from `./shared`.

- [ ] **Step 1: Create `src/db/authStore.ts`**

```ts
// Users, studio memberships, per-user prefs, and admin user operations.
// Moved verbatim out of d1.ts (Catalog). Self-contained on this.db.

import { nowIso } from './shared';
import type { Row } from './shared';

export class AuthStore {
  constructor(private db: D1Database) {}

  // Move verbatim from d1.ts (bodies reference only this.db, nowIso, and other
  // auth* methods on `this` — all intra-store, NO cross-store edits):
  //   authGetUserByGoogleSub   (d1.ts 239–244)
  //   authGetUserById          (d1.ts 246–251)
  //   authCreateUserGoogle     (d1.ts 253–277)
  //   authUpdateUserProfile    (d1.ts 279–296)
  //   authUpdateUserNames      (d1.ts 298–304)
  //   authUserHasStudio        (d1.ts 306–312)
  //   authListStudioIdsForUser (d1.ts 314–320)
  //   authAddMemberships       (d1.ts 322–333)
  //   authGetPrefs             (d1.ts 335–337)
  //   authEnsurePrefsRow       (d1.ts 339–352)
  //   authSetPrefs             (d1.ts 354–360)
  //   authSeedPrefsFromGlobals (d1.ts 362–371)
  //   authListUsersAdmin       (d1.ts 850–859)
  //   authGetUserRowAny        (d1.ts 862–864)
  //   authSetUserDisabled      (d1.ts 866–878)
  //   authRemoveMembership     (d1.ts 880–886)
}
```
`authCreateUserGoogle` and `authSetUserDisabled` use `nowIso()` (imported). `authUpdateUserNames` calls `this.authUpdateUserProfile` (intra-store). `authSetPrefs`/`authSeedPrefsFromGlobals` call `this.authEnsurePrefsRow`/`this.authGetPrefs`/`this.authSetPrefs` (intra-store).

- [ ] **Step 2: Update `src/db/d1.ts`**

1. Add import:
```ts
import { AuthStore } from './authStore';
```
2. DELETE the 16 moved `auth*` methods from `Catalog` (lines 239–371 and 850–886, leaving the `// -- users / auth --` and `// -- admin --` section comments tidy).
3. Add the field + delegates:
```ts
  readonly auth = new AuthStore(this.db);

  // --- auth delegates ---
  authGetUserByGoogleSub = (googleSub: string) => this.auth.authGetUserByGoogleSub(googleSub);
  authGetUserById = (userId: string) => this.auth.authGetUserById(userId);
  authCreateUserGoogle = (opts: Parameters<AuthStore['authCreateUserGoogle']>[0]) =>
    this.auth.authCreateUserGoogle(opts);
  authUpdateUserProfile = (userId: string, fields: Parameters<AuthStore['authUpdateUserProfile']>[1]) =>
    this.auth.authUpdateUserProfile(userId, fields);
  authUpdateUserNames = (userId: string, givenName: string, familyName: string) =>
    this.auth.authUpdateUserNames(userId, givenName, familyName);
  authUserHasStudio = (userId: string, studioId: string) =>
    this.auth.authUserHasStudio(userId, studioId);
  authListStudioIdsForUser = (userId: string) => this.auth.authListStudioIdsForUser(userId);
  authAddMemberships = (userId: string, studioIds: string[]) =>
    this.auth.authAddMemberships(userId, studioIds);
  authGetPrefs = (userId: string) => this.auth.authGetPrefs(userId);
  authSetPrefs = (userId: string, activeStudioId: string, activeShowId: string) =>
    this.auth.authSetPrefs(userId, activeStudioId, activeShowId);
  authSeedPrefsFromGlobals = (userId: string, activeStudioId: string, activeShowId: string) =>
    this.auth.authSeedPrefsFromGlobals(userId, activeStudioId, activeShowId);
  authListUsersAdmin = () => this.auth.authListUsersAdmin();
  authGetUserRowAny = (userId: string) => this.auth.authGetUserRowAny(userId);
  authSetUserDisabled = (userId: string, disabled: boolean) =>
    this.auth.authSetUserDisabled(userId, disabled);
  authRemoveMembership = (userId: string, studioId: string) =>
    this.auth.authRemoveMembership(userId, studioId);
  // internal-use delegate (callers extracted in Task 7):
  private authEnsurePrefsRow = (userId: string) => this.auth.authEnsurePrefsRow(userId);
```
The still-in-`Catalog` methods (`profileStudioForUser`, `authSection`, `profilePayload`) call `this.authListStudioIdsForUser`, `this.authEnsurePrefsRow`, `this.authGetPrefs`, `this.authSetPrefs` — all covered by the delegates above.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Tests green**

Run: `npx vitest run`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/authStore.ts src/db/d1.ts
git commit -m "refactor(db): extract AuthStore (users, memberships, prefs, admin users)"
```

---

## Task 6: Extract `SessionIndexStore` into `src/db/sessionIndexStore.ts`

Sessions index + live projection. This is the first store with cross-store dependencies: it needs `StudioRegistry` (for `resolveActiveStudio`/`loadStudioProfile`/`isKnownStudio`/`studioNamesDict`) and `ShowsStore` (for `getShowRow`). Apply the listed rewrites.

**Files:**
- Create: `src/db/sessionIndexStore.ts`
- Modify: `src/db/d1.ts`

**Interfaces:**
- Produces: `class SessionIndexStore` with `constructor(private db: D1Database, private studios: StudioRegistry, private shows: ShowsStore)` and methods `getSessionStudioId`, `getSessionIndexRow`, `getSessionJoinedRow`, `listSessionsForShow`, `createSessionIndex`, `bumpShowNextEpisodeFromEpisodeString`, `updateSessionIndex`, `setSessionArchived`, `setSessionUiHidden`, `setSessionEpisodeDate`, `projectSessionLive`, `getSessionShowCategories`, `studioProfileForSession` (same signatures as current `Catalog`).
- Consumes: `ValidationError`, `blobToProfile`, type `StudioProfile`, type `SettingsBlob` from `../studio`; type `Row` from `./shared`; `StudioRegistry`, `ShowsStore` (constructor-injected).

- [ ] **Step 1: Create `src/db/sessionIndexStore.ts`**

```ts
// D1 sessions index + the live projection mirrored from the SessionDO, plus
// session→studio profile resolution. Moved verbatim out of d1.ts (Catalog),
// with the cross-store calls rewritten to the injected studios/shows stores.

import { blobToProfile, ValidationError } from '../studio';
import type { SettingsBlob, StudioProfile } from '../studio';
import type { Row } from './shared';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

export class SessionIndexStore {
  constructor(
    private db: D1Database,
    private studios: StudioRegistry,
    private shows: ShowsStore,
  ) {}

  // Move verbatim from d1.ts, THEN apply the cross-store rewrites in Step 2:
  //   getSessionStudioId                 (d1.ts 641–652)
  //   getSessionIndexRow                 (d1.ts 654–661)
  //   getSessionJoinedRow                (d1.ts 663–672)
  //   listSessionsForShow                (d1.ts 674–685)
  //   createSessionIndex                 (d1.ts 687–720)
  //   bumpShowNextEpisodeFromEpisodeString (d1.ts 722–734)
  //   updateSessionIndex                 (d1.ts 736–755)
  //   setSessionArchived                 (d1.ts 757–763)
  //   setSessionUiHidden                 (d1.ts 765–771)
  //   setSessionEpisodeDate              (d1.ts 773–778)  // TODO(cleanup): no callers
  //   projectSessionLive                 (d1.ts 780–808)
  //   getSessionShowCategories           (d1.ts 810–832)
  //   studioProfileForSession            (d1.ts 834–846)
}
```
Add the `// TODO(cleanup): no callers — candidate for removal in a separate pass` comment above `setSessionEpisodeDate`.

- [ ] **Step 2: Apply the cross-store rewrites inside the moved bodies**

- `createSessionIndex`: `this.bumpShowNextEpisodeFromEpisodeString(...)` → unchanged (intra-store).
- `getSessionShowCategories`: `this.getShowRow(showId)` → `this.shows.getShowRow(showId)`. (`this.getSessionIndexRow(...)` stays.)
- `studioProfileForSession`: apply ALL of:
  - `this.resolveActiveStudio()` → `this.studios.resolveActiveStudio()`
  - `this.isKnownStudio(stu)` → `this.studios.isKnownStudio(stu)`
  - `this.loadStudioProfile(stu)` → `this.studios.loadStudioProfile(stu)`
  - `this.names[stu]` → `this.studios.studioNamesDict()[stu]`
  - (`this.getSessionShowCategories(...)` and `this.getSessionStudioId(...)` stay — intra-store.)
- `updateSessionIndex`: unchanged except it uses `ValidationError` (imported) and `this.getSessionIndexRow` (intra-store).

- [ ] **Step 3: Update `src/db/d1.ts`**

1. Add import:
```ts
import { SessionIndexStore } from './sessionIndexStore';
```
2. DELETE the 13 moved session methods from `Catalog` (lines 641–846).
3. Add the field (AFTER `studios` and `shows` are declared, since it depends on them) + delegates:
```ts
  readonly sessions = new SessionIndexStore(this.db, this.studios, this.shows);

  // --- session index delegates ---
  getSessionStudioId = (sessionId: string) => this.sessions.getSessionStudioId(sessionId);
  getSessionIndexRow = (sessionId: string, opts: Parameters<SessionIndexStore['getSessionIndexRow']>[1] = {}) =>
    this.sessions.getSessionIndexRow(sessionId, opts);
  getSessionJoinedRow = (sessionId: string, opts: Parameters<SessionIndexStore['getSessionJoinedRow']>[1] = {}) =>
    this.sessions.getSessionJoinedRow(sessionId, opts);
  listSessionsForShow = (showId: string) => this.sessions.listSessionsForShow(showId);
  createSessionIndex = (opts: Parameters<SessionIndexStore['createSessionIndex']>[0]) =>
    this.sessions.createSessionIndex(opts);
  updateSessionIndex = (sessionId: string, fields: Parameters<SessionIndexStore['updateSessionIndex']>[1]) =>
    this.sessions.updateSessionIndex(sessionId, fields);
  setSessionArchived = (sessionId: string, archived: boolean) =>
    this.sessions.setSessionArchived(sessionId, archived);
  setSessionUiHidden = (sessionId: string, hidden: boolean) =>
    this.sessions.setSessionUiHidden(sessionId, hidden);
  projectSessionLive = (sessionId: string, p: Parameters<SessionIndexStore['projectSessionLive']>[1]) =>
    this.sessions.projectSessionLive(sessionId, p);
  getSessionShowCategories = (sessionId: string) => this.sessions.getSessionShowCategories(sessionId);
  studioProfileForSession = (sessionId: string) => this.sessions.studioProfileForSession(sessionId);
```
(`bumpShowNextEpisodeFromEpisodeString`, `setSessionEpisodeDate` are NOT delegated — no external callers.)

**Field ordering matters:** ensure the `readonly studios`, `readonly shows`, then `readonly sessions` field initializers appear in that order in the class body, because `sessions`'s initializer reads `this.studios` and `this.shows`. TypeScript runs field initializers top-to-bottom.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. `tsc` will flag any missed `this.getShowRow`/`this.resolveActiveStudio`/`this.names` inside the moved file — fix per Step 2.

- [ ] **Step 5: Tests green**

Run: `npx vitest run`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/sessionIndexStore.ts src/db/d1.ts
git commit -m "refactor(db): extract SessionIndexStore (sessions index + live projection)"
```

---

## Task 7: Extract `ProfileAssembler` into `src/db/profileAssembler.ts`

The orchestrator that produces the `/api/profile` payload. Depends on all three of `StudioRegistry`, `AuthStore`, `ShowsStore`. It does NOT take `db`. Apply the full rewrite table.

**Files:**
- Create: `src/db/profileAssembler.ts`
- Modify: `src/db/d1.ts`

**Interfaces:**
- Produces: `class ProfileAssembler` with `constructor(private studios: StudioRegistry, private auth: AuthStore, private shows: ShowsStore)` and methods `profilePayload(user: AuthUser | null, ctx: ProfileCtx): Promise<Record<string, unknown>>`, `getEffectiveStudioForUser(user: AuthUser | null, oauthConfigured: boolean): Promise<StudioProfile | null>` (plus private `resolveActiveShowIdForStudio`, `profileStudioForUser`, `authSection`).
- Consumes: from `../studio`: `DEFAULT_STUDIO_ID`, `emptyActiveStudioApiDict`, `newSessionTitlePrefix`, `SETTING_ACTIVE_SHOW`, `studioToApiDict`, type `StudioProfile`. From `./showsStore`: `showApiDict`. From `./shared`: type `AuthUser`, type `ProfileCtx`. Constructor-injected: `StudioRegistry`, `AuthStore`, `ShowsStore`.

- [ ] **Step 1: Create `src/db/profileAssembler.ts`**

```ts
// Assembles the /api/profile payload (byte-compatible with the Python server)
// from the studio registry, auth store, and shows store. Moved verbatim out of
// d1.ts (Catalog), with cross-store calls rewritten to the injected stores.

import {
  DEFAULT_STUDIO_ID,
  emptyActiveStudioApiDict,
  newSessionTitlePrefix,
  SETTING_ACTIVE_SHOW,
  studioToApiDict,
} from '../studio';
import type { StudioProfile } from '../studio';
import type { AuthStore } from './authStore';
import type { AuthUser, ProfileCtx } from './shared';
import { showApiDict } from './showsStore';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

export class ProfileAssembler {
  constructor(
    private studios: StudioRegistry,
    private auth: AuthStore,
    private shows: ShowsStore,
  ) {}

  // Move verbatim from d1.ts, THEN apply the rewrites in Step 2:
  //   resolveActiveShowIdForStudio (private) (d1.ts 468–478)
  //   profileStudioForUser                   (d1.ts 480–502)
  //   getEffectiveStudioForUser              (d1.ts 504–514)
  //   authSection (private)                  (d1.ts 516–537)
  //   profilePayload                         (d1.ts 539–637)
}
```

- [ ] **Step 2: Apply the cross-store rewrite table inside the moved bodies**

`resolveActiveShowIdForStudio`:
- `this.listShowsForStudio(studioId)` → `this.shows.listShowsForStudio(studioId)`

`profileStudioForUser`:
- `this.authListStudioIdsForUser(userId)` → `this.auth.authListStudioIdsForUser(userId)`
- `this.authEnsurePrefsRow(userId)` → `this.auth.authEnsurePrefsRow(userId)`
- `this.authGetPrefs(userId)` → `this.auth.authGetPrefs(userId)`
- `this.order` → `this.studios.studioOrderTuple()`
- `this.loadStudioProfile(studioId)` → `this.studios.loadStudioProfile(studioId)`
- `this.resolveActiveShowIdForStudio(...)` → unchanged (intra-class)
- `DEFAULT_STUDIO_ID` → imported const, unchanged

`getEffectiveStudioForUser`:
- `this.resolveActiveStudio()` → `this.studios.resolveActiveStudio()`
- `this.profileStudioForUser(user.id)` → unchanged (intra-class)

`authSection`:
- `this.authListStudioIdsForUser(user.id)` → `this.auth.authListStudioIdsForUser(user.id)`
- `this.order` → `this.studios.studioOrderTuple()`
- `this.names` → `this.studios.studioNamesDict()`

`profilePayload`:
- `this.allStudioSettingsForAllowedStudios(...)` → `this.studios.allStudioSettingsForAllowedStudios(...)`
- `this.authSection(...)` → unchanged (intra-class)
- `this.resolveActiveStudio()` → `this.studios.resolveActiveStudio()`
- `this.listShowsForStudio(...)` → `this.shows.listShowsForStudio(...)`
- `this.getSetting(...)` → `this.studios.getSetting(...)`
- `this.setSetting(...)` → `this.studios.setSetting(...)`
- `this.listStudiosBrief()` → `this.studios.listStudiosBrief()`
- `this.listStudiosBriefAllowed(...)` → `this.studios.listStudiosBriefAllowed(...)`
- `this.profileStudioForUser(...)` → unchanged (intra-class)
- `this.authEnsurePrefsRow(...)` → `this.auth.authEnsurePrefsRow(...)`
- `this.authSetPrefs(...)` → `this.auth.authSetPrefs(...)`
- `showApiDict(...)`, `emptyActiveStudioApiDict()`, `studioToApiDict(...)`, `newSessionTitlePrefix(...)`, `SETTING_ACTIVE_SHOW` → imported, unchanged

- [ ] **Step 3: Update `src/db/d1.ts`**

1. Add import:
```ts
import { ProfileAssembler } from './profileAssembler';
```
2. DELETE the 5 moved methods from `Catalog` (lines 468–637): `resolveActiveShowIdForStudio`, `profileStudioForUser`, `getEffectiveStudioForUser`, `authSection`, `profilePayload`.
3. Add the field (after `studios`, `auth`, `shows`) + delegates:
```ts
  readonly profile = new ProfileAssembler(this.studios, this.auth, this.shows);

  // --- profile delegates ---
  profilePayload = (user: AuthUser | null, ctx: ProfileCtx) =>
    this.profile.profilePayload(user, ctx);
  getEffectiveStudioForUser = (user: AuthUser | null, oauthConfigured: boolean) =>
    this.profile.getEffectiveStudioForUser(user, oauthConfigured);
```
This requires `AuthUser`/`ProfileCtx` as types in `d1.ts` — they are already imported via `import type { AuthUser, ProfileCtx, Row } from './shared';` (Task 2). If `Row` is now unused in `d1.ts`, `tsc` will say so in Step 5 — drop it from that `import type` (keep the separate `export type { ... Row } from './shared'` re-export, which is independent).

- [ ] **Step 4: Remove now-dead private internal delegates from `Catalog`**

After Task 7, nothing in `Catalog` calls the internal-only delegates anymore (their callers were the methods just extracted). DELETE these private delegate properties added earlier: `getStudioSettingsBlob`, `loadStudioProfile`, `resolveActiveStudio`, `allStudioSettingsForAllowedStudios`, `listStudiosBriefAllowed` (Task 4 Step 2.4) and `authEnsurePrefsRow` (Task 5 Step 2.3). (They remain available as public methods on the underlying stores if needed later.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. Fix anything `tsc` flags (missed rewrite, unused import).

- [ ] **Step 6: Tests green**

Run: `npx vitest run`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/profileAssembler.ts src/db/d1.ts
git commit -m "refactor(db): extract ProfileAssembler (/api/profile orchestrator)"
```

---

## Task 8: Finalize the facade — smoke test, verify, version bump

`d1.ts` is now a thin facade. Add a smoke test that guards the delegation surface, expose the stores as the forward-looking API, run the full verification, and bump the version.

**Files:**
- Test: `src/db/d1.test.ts` (create)
- Modify: `src/db/d1.ts` (header comment + ensure `readonly` stores are public)
- Modify: `package.json` (version bump)

**Interfaces:**
- Consumes: `Catalog` from `./d1`.

- [ ] **Step 1: Confirm the final `Catalog` shape**

Open `src/db/d1.ts` and verify the `Catalog` class body now contains ONLY:
- `constructor(private db: D1Database) {}`
- `readonly studios`, `readonly auth`, `readonly shows`, `readonly sessions`, `readonly profile` field initializers (in that dependency order)
- the public delegate properties for the external surface (the methods listed across Tasks 3–7 that are called outside `d1.ts`)

No SQL, no business logic, no `private` helper methods should remain. Update the top-of-file comment to:
```ts
// Catalog — thin facade over the D1 domain stores (studioRegistry / authStore /
// showsStore / sessionIndexStore / profileAssembler). Preserves the per-request
// `new Catalog(db)` + init() + method surface that routers call via c.get('catalog').
// The flat delegate methods are a compatibility shim; the `readonly` store fields
// are the forward-looking API.
```

- [ ] **Step 2: Write the facade smoke test**

Create `src/db/d1.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Catalog } from './d1';

// A stub D1Database — construction must not touch it (init() is never called here).
const stubDb = {} as unknown as D1Database;

describe('Catalog facade', () => {
  const catalog = new Catalog(stubDb);

  it('exposes the domain stores as readonly props', () => {
    for (const key of ['studios', 'auth', 'shows', 'sessions', 'profile'] as const) {
      expect(catalog[key]).toBeDefined();
    }
  });

  it('delegates every router-called method as a function', () => {
    const surface = [
      'init', 'isKnownStudio', 'getSetting', 'setSetting', 'saveStudioSettingsBlob',
      'studioNamesDict', 'studioOrderTuple', 'listStudiosBrief',
      'adminCreateStudio', 'adminDeleteStudio',
      'authGetUserByGoogleSub', 'authGetUserById', 'authCreateUserGoogle',
      'authUpdateUserProfile', 'authUpdateUserNames', 'authUserHasStudio',
      'authListStudioIdsForUser', 'authAddMemberships', 'authGetPrefs', 'authSetPrefs',
      'authSeedPrefsFromGlobals', 'authListUsersAdmin', 'authGetUserRowAny',
      'authSetUserDisabled', 'authRemoveMembership',
      'getShowRow', 'createShow', 'listShowsForStudio', 'updateShowFields',
      'createSessionIndex', 'getSessionIndexRow', 'getSessionJoinedRow',
      'getSessionShowCategories', 'getSessionStudioId', 'listSessionsForShow',
      'projectSessionLive', 'setSessionArchived', 'setSessionUiHidden',
      'updateSessionIndex', 'studioProfileForSession',
      'profilePayload', 'getEffectiveStudioForUser',
    ] as const;
    for (const name of surface) {
      expect(typeof (catalog as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
```

> **Note on `D1Database` in tests:** vitest strips type annotations via esbuild and does not run `tsc`, so the ambient `D1Database` type (used only in `as unknown as D1Database`) is erased at runtime — the stub is just `{}`. No worker runtime is needed.

- [ ] **Step 3: Run the smoke test (and the full suite)**

Run: `npx vitest run`
Expected: PASS — 3 test files, 6 tests total (4 shaper + 2 facade). If any surface method is `undefined`, you missed a delegate in Tasks 3–7; add it.

- [ ] **Step 4: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual behavior verification**

Start the worker and confirm the `/api/profile` shapes are unchanged in all three auth states, plus admin users:
```bash
npm run dev
```
Then, in another shell, exercise:
- `GET /api/profile` while logged OUT with OAuth configured → `auth.logged_in === false`, `studios: []`.
- `GET /api/profile` while logged OUT with OAuth NOT configured → populated `active_studio`, `studios`, `shows`.
- `GET /api/profile` while logged IN → studios filtered to memberships.
- `GET /api/admin/users` → `studios_catalog` + `users` array.

Expected: identical JSON to pre-refactor (diff against a capture from `main` if available). If anything differs, a cross-store rewrite is wrong — re-check the relevant Task 6/7 rewrite table.

- [ ] **Step 6: Bump the worker version**

In `package.json`, bump `"version"` from `"0.1.0"` to `"0.2.0"` (architecture change). (This worker subdirectory has no `pyproject.toml`/`CHANGELOG.md`; the parent project's versioning rule does not apply here.)

- [ ] **Step 7: Commit**

```bash
git add src/db/d1.ts src/db/d1.test.ts package.json
git commit -m "refactor(db): finalize Catalog facade + smoke test; bump worker to 0.2.0"
```

---

## Final state checklist

- `src/db/d1.ts` is a thin facade (constructor + 5 `readonly` stores + external-surface delegates); no SQL or business logic remains.
- Five new store files each own one domain; `shared.ts` holds shared types + `nowIso`.
- `new Catalog(db)`, `init()`, and every router-called method work unchanged; no router/middleware/types file was edited.
- `npm run typecheck` passes; `npx vitest run` passes (6 tests).
- `/api/profile` (3 states) + `/api/admin/users` return byte-identical JSON.
- `package.json` version bumped to `0.2.0`.
- `getShowShowCode` and `setSessionEpisodeDate` relocated with `TODO(cleanup)` comments, not removed.
