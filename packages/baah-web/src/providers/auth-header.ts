/**
 * How a vendor's key travels, in one place.
 *
 * ## Why this is its own module and not a line in each of the two loaders
 *
 * `probe.ts` and `models.ts` both build a header set with the key in it, and both
 * derived the header name from the auth style with a ternary. The ternary was the
 * same **and it was wrong in both places**: it put the raw key in `authorization`.
 *
 * That is not a cosmetic defect. RFC 6750 §2.1 defines `Authorization` as a
 * **scheme** plus a credential — `Authorization: Bearer <token>` — and every one of
 * the six §9-measured OpenAI-compatible operators answers a bare token with `401`.
 * The two-request probe then classifies `401` as `key-rejected` and tells the user
 * their key is wrong. It is not. The header was malformed, and the wizard diagnosed
 * a provider policy as a user error — the one misdiagnosis `probe.ts`'s own module
 * header exists to prevent.
 *
 * Two copies of one ternary is two places for the same bug, and the second copy is
 * invisible: a reader who fixes `models.ts` has no reason to look at `probe.ts`.
 *
 * ## The three styles, and why only one takes a scheme
 *
 * | style | header | value |
 * |---|---|---|
 * | `bearer` | `authorization` | `Bearer <key>` — the scheme is part of the grammar |
 * | `x-api-key` | `x-api-key` | the raw key |
 * | `x-goog-api-key` | `x-goog-api-key` | the raw key |
 *
 * The two keyed styles are the opposite case and are **not** a bug to fix: Anthropic
 * and Google both document the bare key in their own header. Prefixing those with
 * `Bearer ` would break them. The asymmetry is the reason this is a function with a
 * `switch` rather than a `prefix = auth === "bearer" ? "Bearer " : ""` next to a
 * caller-chosen name — a scheme prefix is correct for exactly one of the three, and
 * which one is the thing a reader must not have to re-derive.
 */

/** How a vendor authenticates. Never a query parameter (`AGENTS.md` §2). */
export type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key";

/**
 * The header name an auth style sends its credential in.
 *
 * **A function, not a map literal with a cast.** `auth === "bearer" ? "authorization"
 * : auth` type-checks because the two keyed styles happen to be spelled like header
 * names, and that coincidence is the entire bug this module exists to remove: the
 * next style someone adds whose header is *not* its own name would compile and send
 * nothing.
 */
export function authHeaderName(auth: AuthStyle): string {
  switch (auth) {
    case "bearer":
      return "authorization";
    case "x-api-key":
      return "x-api-key";
    case "x-goog-api-key":
      return "x-goog-api-key";
  }
}

/**
 * The header value for an auth style.
 *
 * `bearer` gets RFC 6750's scheme; the two keyed styles get the raw key, which is
 * what their providers document.
 */
export function authHeaderValue(auth: AuthStyle, apiKey: string): string {
  switch (auth) {
    case "bearer":
      return `Bearer ${apiKey}`;
    case "x-api-key":
    case "x-goog-api-key":
      return apiKey;
  }
}
