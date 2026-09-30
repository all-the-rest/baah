/**
 * One question the shell has to be able to ask: **is there room for two columns?**
 *
 * ## Why this is `useSyncExternalStore` and not `useState` + an effect
 *
 * `matchMedia` is already a store with a `subscribe`, and `AppShell` uses
 * `useSyncExternalStore` for the runtime snapshot for exactly this reason (see its
 * own header): a value that can change between render and paint should not be
 * observed one frame late. An effect would paint one frame with the old width,
 * and on a phone that frame is the one where the drawer is open over a two-column
 * layout.
 *
 * The snapshot is read fresh on every call, so the value can never be a stale
 * cached boolean from a listener that has already been removed.
 *
 * ## Why the query is `rem` and not `px`
 *
 * Because this value has to agree with a Tailwind class. The shell switches shape
 * in JavaScript (does the sidebar exist?) *and* in CSS (`max-lg:fixed` for the
 * overlay). If the two thresholds disagreed by even one pixel — JS says narrow, CSS
 * says wide — the sidebar would be mounted as a static column inside a viewport that
 * cannot hold it, which is the original defect wearing a new hat.
 *
 * Tailwind's `lg` is `@media (width >= 64rem)`. `rem` inside a media query resolves
 * against the *initial* font size, which is also what `matchMedia` resolves `rem`
 * against, so `(min-width: 64rem)` is the same query as `lg:`. Both sides name it
 * through this one constant; neither repeats the number.
 *
 * ## Why 1024 px, and not 768
 *
 * Measured, not guessed: at a 1280 px viewport the right column's natural width is
 * **820 px** and the chat column gets 460 px — the sidebar's `max-content` share is
 * large because `WorkspacePanel`'s `modeExplanation` is a long paragraph in a column
 * with no width of its own. A two-column split is therefore not "possible from
 * 768 px", it is "possible from about a thousand", and `lg` is where it stops being
 * a squeeze. Below it the chat gets the whole viewport, which is the only arrangement
 * that gives a 390 px phone a usable composer.
 *
 * 1024 is also daisyUI's own drawer breakpoint, read out of the installed package
 * rather than remembered: `daisyui/components/drawer.css` emits its `lg:drawer-open`
 * rules inside `@media (width>=1024px)`. So the number was not picked here — it is
 * the one the framework this app already depends on picked for exactly this problem.
 */

import { useSyncExternalStore } from "react";

/**
 * The one place the threshold is written down.
 *
 * Mirrors Tailwind's `lg` (`@media (width >= 64rem)`). A change here is a change to
 * both halves of the shell at once, which is the point: they must never be tuned
 * separately.
 */
export const WIDE_VIEWPORT_QUERY = "(min-width: 64rem)";

/**
 * The cached `MediaQueryList`.
 *
 * One object, not one per call: `matchMedia` allocates, and `subscribe` and
 * `getSnapshot` both need the *same* list — a listener removed from a different
 * object than the one it was added to is a listener that never fires.
 *
 * Built lazily on first use and never at module scope: importing this file must not
 * touch `window`, because `vitest` imports modules without a DOM.
 */
let cached: MediaQueryList | undefined;

function query(): MediaQueryList {
  return (cached ??= window.matchMedia(WIDE_VIEWPORT_QUERY));
}

/** True while the viewport is at least as wide as `WIDE_VIEWPORT_QUERY` says. */
function read(): boolean {
  return query().matches;
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list.addEventListener("change", onChange);
  return () => {
    list.removeEventListener("change", onChange);
  };
}

/**
 * Whether the viewport is wide enough for the two-column shell.
 *
 * `true` above 1024 px, `false` below it. The shell asks this once and derives
 * everything else from it; nothing else in the tree asks.
 */
export function useIsWideViewport(): boolean {
  return useSyncExternalStore(subscribe, read);
}
