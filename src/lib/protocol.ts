/**
 * Protocol versions (API §1.1, §4.2). There is no version in the URL: clients compare these with
 * `/server/info` (`apiVersion`/`minApiVersion`, `features.sync.protocol`/`minProtocol`) and send `X-Sync-Protocol`.
 */

/** HTTP API version (`ServerInfo.apiVersion`). */
export const API_VERSION = 1;
/** Oldest HTTP API version this server still serves (`ServerInfo.minApiVersion`). */
export const MIN_API_VERSION = 1;

/** Sync and playback protocol (`features.sync.protocol`); `X-Sync-Protocol` must be in [min, current]. */
export const SYNC_PROTOCOL = 1;
/** `features.sync.minProtocol`. */
export const MIN_SYNC_PROTOCOL = 1;
