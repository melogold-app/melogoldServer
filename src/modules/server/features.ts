/**
 * `ServerInfo.features` (API §4.2): an absent key means "not supported" (API §1.3), so a feature appears only when the
 * module that implements it declares it. In M0 every module is a stub and `features` is `{}`.
 *
 * A module declares its feature once, when its routes are registered:
 *
 * ```ts
 * ctx.features.declare("playback", FEATURE_V1);
 * ctx.features.declare("sync", () => syncFeature(implementedOpKinds(handlers)));
 * ctx.features.declare("registrationPow", () => (powRequiredNow() ? FEATURE_V1 : null));   // null → absent
 * ```
 *
 * A provider function is called on every `/server/info` request, so it must be cheap and must not throw.
 */
import { LINK_LONG_POLL_SECONDS } from "../../contract/limits.ts";
import { LINK_MODE_VALUES } from "../../contract/linking.ts";
import type { ServerFeatures } from "../../contract/server.ts";
import { SYNC_STREAM_VALUES } from "../../contract/sync.ts";
import { MIN_SYNC_PROTOCOL, SYNC_PROTOCOL } from "../../lib/protocol.ts";

export type FeatureKey = keyof ServerFeatures;
export type FeatureValue<K extends FeatureKey> = NonNullable<ServerFeatures[K]>;
/** A fixed value, or a function giving the current value (`null`: the feature is absent right now). */
export type FeatureProvider<K extends FeatureKey> = FeatureValue<K> | (() => FeatureValue<K> | null);

/** The order of the keys in `/server/info` (API §4.2). */
export const FEATURE_KEYS: readonly FeatureKey[] = Object.freeze([
  "sync",
  "playback",
  "deviceLinking",
  "recoveryCode",
  "export",
  "accountDeletion",
  "registrationPow",
]);

/** `{version: 1}`: `playback`, `recoveryCode`, `export`, `accountDeletion`, `registrationPow`. */
export const FEATURE_V1: Readonly<{ version: number }> = Object.freeze({ version: 1 });

/** `features.sync` for the kinds this server applies (`implementedOpKinds()` of `src/modules/sync/ops`). */
export function syncFeature(kinds: readonly string[]): FeatureValue<"sync"> {
  return {
    protocol: SYNC_PROTOCOL,
    minProtocol: MIN_SYNC_PROTOCOL,
    kinds: [...kinds],
    streams: [...SYNC_STREAM_VALUES],
  };
}

/** `features.deviceLinking` (API §4.2, §4.6). */
export function deviceLinkingFeature(linkTtlSeconds: number): FeatureValue<"deviceLinking"> {
  return {
    version: 1,
    modes: [...LINK_MODE_VALUES],
    ttlSeconds: linkTtlSeconds,
    longPollSeconds: LINK_LONG_POLL_SECONDS,
  };
}

export class FeatureAlreadyDeclaredError extends Error {
  constructor(key: FeatureKey) {
    super(`feature "${key}" is declared twice`);
    this.name = "FeatureAlreadyDeclaredError";
  }
}

/** `ctx.features`: what `/server/info` reports under `features`. */
export class FeatureRegistry {
  readonly #providers = new Map<FeatureKey, () => unknown>();

  /** Declares a feature; each key once. */
  declare<K extends FeatureKey>(key: K, provider: FeatureProvider<K>): void {
    if (this.#providers.has(key)) throw new FeatureAlreadyDeclaredError(key);
    this.#providers.set(key, typeof provider === "function" ? provider : () => provider);
  }

  has(key: FeatureKey): boolean {
    return this.#providers.has(key);
  }

  /** The current `features` object: declared keys whose provider gives a value, in {@link FEATURE_KEYS} order. */
  snapshot(): ServerFeatures {
    const features: ServerFeatures = {};
    for (const key of FEATURE_KEYS) {
      const value = this.#providers.get(key)?.();
      if (value !== undefined && value !== null) Object.assign(features, { [key]: value });
    }
    return features;
  }
}
