/**
 * Shared fixtures.
 *
 * Two things every spec needs, and which must not be re-implemented per spec:
 *
 * - the in-page stream pacer (`pacer.ts`), so a stream can be held open or cut
 *   at a precise point;
 * - a console/page-error recorder, so "the app booted without throwing" is an
 *   assertion rather than an impression.
 *
 * The recorder is what keeps the suite honest across Wave 2: a smoke test that
 * only checked "the app renders" would stay green while a hydration error or a
 * failed import sits in the console.
 */
import { test as base, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { pacerCommand, pacerInitScript, pacerState, type PacerCommand, type PacerState } from "./pacer.ts";
import { installProvider, type ProviderFake, type ProviderStep } from "./provider.ts";
import { streamMarkerHeader } from "./sse.ts";

/** A console message the page produced. */
export type ConsoleEntry = {
  readonly type: string;
  readonly text: string;
};

/** Something that makes the page unusable. */
export type PageFault = {
  readonly kind: "console-error" | "pageerror";
  readonly text: string;
};

export type AppFixtures = {
  /** The page under test, with the pacer installed. */
  app: Page;
  /** Everything the page logged, and everything that threw. */
  faults: {
    readonly entries: readonly ConsoleEntry[];
    readonly errors: readonly PageFault[];
    /** Fail if anything was logged at `error` level or threw uncaught. */
    assertClean(): void;
  };
  /** The faked provider, already installed. */
  provider: ProviderFake;
  /** Drive the in-page stream pacer. */
  pacer: {
    command(command: PacerCommand): Promise<PacerState>;
    state(): Promise<PacerState>;
  };
};

export type AppOptions = {
  /** Steps the provider answers with, consumed in order. */
  steps?: readonly ProviderStep[];
};

export const test = base.extend<AppFixtures, AppOptions & { steps: readonly ProviderStep[] }>({
  steps: [async ({}, use) => use([]), { option: true, scope: "worker" }],

  provider: async ({ context, steps }, use) => {
    await use(await installProvider(context, steps));
  },

  app: async ({ page }, use) => {
    await page.addInitScript({ content: pacerInitScript(streamMarkerHeader) });
    await use(page);
  },

  faults: async ({ page }, use) => {
    const entries: ConsoleEntry[] = [];
    const errors: PageFault[] = [];

    page.on("console", (message: ConsoleMessage) => {
      entries.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (cause) => {
      errors.push({ kind: "pageerror", text: cause.message });
    });

    await use({
      entries,
      errors,
      assertClean(): void {
        const reported = [
          ...entries
            .filter((entry) => entry.type === "error")
            .map((entry) => `console.error: ${entry.text}`),
          ...errors.map((entry) => `uncaught ${entry.text}`),
        ];
        expect(reported, "the page logged errors or threw").toEqual([]);
      },
    });
  },

  pacer: async ({ page }, use) => {
    await use({
      command: (command: PacerCommand) => pacerCommand(page, command),
      state: () => pacerState(page),
    });
  },
});

export { expect };
