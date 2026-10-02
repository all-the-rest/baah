/**
 * The provider layer: which vendors exist, how to build them, how to test one,
 * and what models they offer.
 *
 * Four modules, one per question:
 *
 * | module       | question                                          |
 * | ------------ | ------------------------------------------------- |
 * | `catalog.ts` | which providers may this app offer? (`Plan.md` §9) |
 * | `factories.ts` | how is a vendor id turned into a `LanguageModel`? |
 * | `probe.ts`   | what happened when we called it?                   |
 * | `models.ts`  | what models does the endpoint actually serve?      |
 *
 * All four sit above `@all-the.rest/baah-core`'s registry and below the
 * composition root; none of them knows about a turn, a session or the UI.
 */

export {
  PROVIDER_CATALOG,
  findProvider,
  isKnownProvider,
  parseCatalogId,
  providerChoices,
  type ProviderEntry,
} from "./catalog.ts";

export {
  catalogVendorIds,
  createDefaultProviderFactories,
  createDefaultProviderRegistry,
} from "./factories.ts";

export {
  ConnectionProbeError,
  probeConnection,
  probeFromSettings,
  type ConnectionProbeOptions,
  type ConnectionProbeReport,
  type ConnectionProbeRequest,
  type EndpointObservation,
  type ProbeFetch,
  type ProbeFromSettingsOptions,
  type ProbeOutcome,
  type ProbeRequestInit,
  type ProbeVerdict,
} from "./probe.ts";

export {
  ModelListError,
  listModels,
  listModelsFromSettings,
  type ModelInfo,
  type ModelList,
  type ModelListFetch,
  type ModelListOptions,
  type ModelListRequest,
  type ModelRequestInit,
} from "./models.ts";
