/** `ServerInfo.features` (API §4.2): only declared features appear, in the documented order, with valid shapes. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeviceLinkingFeature, FeatureVersion, SyncFeature } from "../../contract/server.ts";
import { SYNC_OP_KINDS } from "../../contract/sync.ts";
import {
  deviceLinkingFeature,
  FEATURE_KEYS,
  FEATURE_V1,
  FeatureAlreadyDeclaredError,
  FeatureRegistry,
  syncFeature,
} from "./features.ts";

describe("FeatureRegistry", () => {
  test("nothing declared: {} (M0, every module is a stub)", () => {
    assert.deepEqual(new FeatureRegistry().snapshot(), {});
  });

  test("declared features in the order of API §4.2; a provider returning null hides its key", () => {
    const registry = new FeatureRegistry();
    let powRequired = false;
    registry.declare("registrationPow", () => (powRequired ? FEATURE_V1 : null));
    registry.declare("playback", FEATURE_V1);
    registry.declare("sync", () => syncFeature(["like.set"]));
    assert.deepEqual(Object.keys(registry.snapshot()), ["sync", "playback"]);
    powRequired = true;
    assert.deepEqual(Object.keys(registry.snapshot()), ["sync", "playback", "registrationPow"]);
    assert.ok(registry.has("sync"));
    assert.ok(!registry.has("export"));
    assert.throws(() => registry.declare("playback", FEATURE_V1), FeatureAlreadyDeclaredError);
    assert.deepEqual(FEATURE_KEYS, [
      "sync",
      "playback",
      "deviceLinking",
      "recoveryCode",
      "export",
      "accountDeletion",
      "registrationPow",
    ]);
  });

  test("feature values match the contract and the example of API §4.2", () => {
    assert.deepEqual(SyncFeature.parse(syncFeature(SYNC_OP_KINDS)), {
      protocol: 1,
      minProtocol: 1,
      kinds: [...SYNC_OP_KINDS],
      streams: ["library", "history"],
    });
    assert.deepEqual(DeviceLinkingFeature.parse(deviceLinkingFeature(300)), {
      version: 1,
      modes: ["request", "invite"],
      ttlSeconds: 300,
      longPollSeconds: 25,
    });
    assert.deepEqual(FeatureVersion.parse(FEATURE_V1), { version: 1 });
  });
});
