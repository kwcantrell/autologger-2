// AppLoadingSkeleton (nextjs-frontend-migration, task 2.3; design D9.1)
//
// Single-sourced static loading placeholder for the Next App Router shell.
// It is rendered as the `loading` fallback of every `ssr: false` client-
// island `dynamic()` import under `web/src/app/**` (see `IndexIsland.tsx` /
// `AdminIsland.tsx`) -- with `ssr: false` on the dynamic import, Next still
// server-renders the `loading` element itself, so the document served for
// every router-known path (design D9.1's "Server-rendered shell") contains
// real layout/skeleton markup instead of an empty mount node.
//
// Deliberately static: no props, no hooks, no user- or session-derived
// data -- safe to render for any request regardless of authentication
// state or session existence (the shell's no-existence-oracle property,
// `api-contract-freeze` delta).
//
// NOT YET wired into `RootGate`'s own loading branch (`RootGate.tsx` still
// renders its pre-existing `LoadingState`, unchanged by this task -- see
// task 2.3's implementation notes). Single-sourcing the two so they render
// the identical component, with a jsdom done-ness assertion, is task 5.1's
// job, not this one's.
export function AppLoadingSkeleton() {
  return (
    <div
      className="relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading"
      data-testid="app-loading-skeleton"
    >
      <div className="glass-panel relative box-border w-full max-w-[25rem] rounded-v5-lg px-7 py-9 text-center">
        <h1 className="m-0 font-league-gothic text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text">
          AutoLogger
        </h1>
      </div>
    </div>
  );
}
