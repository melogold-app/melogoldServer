/**
 * Remote control over HTTP (API §4.9 "Пульт", server task 0004), both dialects: `GET /playback/devices` with presence
 * from the streams of the hub, `POST /playback/commands` delivering `playback.command` only to the target's `remote=1`
 * streams, the errors, the repeat of a `commandId`, validation per action, `volume` in `/playback/state` and the rate
 * limit. The real `?remote=1` stream is checked in `live/sse.int.test.ts`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../contract/live.ts";
import type { AppContext } from "../../context.ts";
import { newId } from "../../lib/ids.ts";
import { formatIso } from "../../lib/time.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { COMMAND_REPEAT_WINDOW_MS } from "./remote.service.ts";

const XSP = { "x-sync-protocol": "1" };
const TRACK = { videoId: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", artistsText: "Rick Astley" };

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

/** A fake stream of one device: `remote` like `?remote=1`. */
function stream(ctx: AppContext, userId: string, deviceId: string, remote: boolean) {
  const events: LiveEvent[] = [];
  const registration = ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    remote,
    send: (event) => events.push(event),
    close: () => undefined,
  });
  return { events, commands: () => events.filter((event) => event.type === "playback.command"), ...registration };
}

type Setup = Readonly<{
  account: TestAccount;
  /** The controlling phone (the account's first device). */
  phone: Readonly<{ id: string; token: string }>;
  laptop: Readonly<{ id: string; token: string }>;
  tv: Readonly<{ id: string; token: string }>;
}>;

async function setup(): Promise<Setup> {
  const account = await createAccount(t.ctx);
  const extra = async (name: string, platform: string) => {
    const device = await createDevice(t.db, account.user.id, { now: t.clock.now(), name, platform });
    const session = await createSession(t.ctx, { userId: account.user.id, deviceId: device.id, now: t.clock.now() });
    return { id: device.id, token: session.tokens.accessToken };
  };
  return {
    account,
    phone: { id: account.device.id, token: account.session.tokens.accessToken },
    laptop: await extra("MacBook Air", "macos"),
    tv: await extra("Living room", "windows"),
  };
}

function devices(token: string) {
  return t.app.inject({ method: "GET", url: "/playback/devices", headers: { ...bearer(token), ...XSP } });
}

function command(token: string, body: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/playback/commands",
    headers: { ...bearer(token), ...XSP, "content-type": "application/json" },
    payload: JSON.stringify({ commandId: newId(), ...body }),
  });
}

function putState(token: string, body: Record<string, unknown>) {
  return t.app.inject({
    method: "PUT",
    url: "/playback/state",
    headers: { ...bearer(token), ...XSP, "content-type": "application/json" },
    payload: JSON.stringify({
      sessionId: "e2a1b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
      queueVersion: 1,
      at: formatIso(t.clock.now()),
      index: 0,
      positionMs: 1000,
      durationMs: 213_000,
      playing: true,
      queue: [TRACK],
      ...body,
    }),
  });
}

describe("GET /playback/devices", () => {
  test("the other devices with online/controllable from the streams; playing and volume of the author", async () => {
    const s = await setup();
    const laptopStream = stream(t.ctx, s.account.user.id, s.laptop.id, true);
    const tvStream = stream(t.ctx, s.account.user.id, s.tv.id, false);
    try {
      const put = await putState(s.laptop.token, { volume: 40 });
      assert.equal(put.statusCode, 200, put.body);

      const response = await devices(s.phone.token);
      assert.equal(response.statusCode, 200, response.body);
      const body = json(response);
      assert.equal(body.serverTime, formatIso(t.clock.now()));
      const list = body.devices as Record<string, unknown>[];
      assert.ok(!list.some((device) => device.deviceId === s.phone.id), "not the caller");
      const laptop = list.find((device) => device.deviceId === s.laptop.id);
      const tv = list.find((device) => device.deviceId === s.tv.id);
      assert.ok(laptop && tv);
      assert.deepEqual(
        { name: laptop.name, platform: laptop.platform, online: laptop.online, controllable: laptop.controllable },
        { name: "MacBook Air", platform: "macos", online: true, controllable: true },
      );
      assert.equal(laptop.volume, 40);
      const playing = laptop.playing as Record<string, unknown>;
      assert.equal(playing.playing, true);
      assert.equal((playing.track as Record<string, unknown>).videoId, TRACK.videoId);
      assert.deepEqual(
        { online: tv.online, controllable: tv.controllable, playing: tv.playing, volume: tv.volume },
        { online: true, controllable: false, playing: null, volume: null },
      );

      tvStream.unregister();
      laptopStream.unregister();
      const offline = (json(await devices(s.phone.token)).devices as Record<string, unknown>[]).map((device) => [
        device.online,
        device.controllable,
      ]);
      assert.deepEqual(offline, [
        [false, false],
        [false, false],
      ]);
    } finally {
      laptopStream.unregister();
      tvStream.unregister();
    }
  });

  test("a device with a plain and a remote=1 stream is controllable; another account's streams do not count", async () => {
    const s = await setup();
    const stranger = await setup();
    const plain = stream(t.ctx, s.account.user.id, s.laptop.id, false);
    const remote = stream(t.ctx, s.account.user.id, s.laptop.id, true);
    const foreign = stream(t.ctx, stranger.account.user.id, stranger.tv.id, true);
    try {
      const list = json(await devices(s.phone.token)).devices as Record<string, unknown>[];
      const laptop = list.find((device) => device.deviceId === s.laptop.id);
      assert.equal(laptop?.controllable, true);
      assert.ok(!list.some((device) => device.deviceId === stranger.tv.id));
    } finally {
      plain.unregister();
      remote.unregister();
      foreign.unregister();
    }
  });

  test("401 without a token, 400 without X-Sync-Protocol", async () => {
    assert.equal((await t.app.inject({ method: "GET", url: "/playback/devices", headers: XSP })).statusCode, 401);
    const s = await setup();
    const response = await t.app.inject({ method: "GET", url: "/playback/devices", headers: bearer(s.phone.token) });
    assert.equal(response.statusCode, 400);
  });
});

describe("POST /playback/commands", () => {
  test("202 delivered: playback.command only to the target's remote=1 streams, with the sender's name", async () => {
    const s = await setup();
    const target = stream(t.ctx, s.account.user.id, s.laptop.id, true);
    const targetPlain = stream(t.ctx, s.account.user.id, s.laptop.id, false);
    const bystander = stream(t.ctx, s.account.user.id, s.tv.id, true);
    const sender = stream(t.ctx, s.account.user.id, s.phone.id, true);
    try {
      const commandId = newId();
      const response = await command(s.phone.token, { commandId, targetDeviceId: s.laptop.id, action: "pause" });
      assert.equal(response.statusCode, 202, response.body);
      assert.deepEqual(json(response), { delivered: true });

      assert.equal(target.commands().length, 1);
      assert.deepEqual(target.commands()[0]?.payload, {
        commandId,
        fromDeviceId: s.phone.id,
        fromDeviceName: s.account.device.name,
        action: "pause",
        positionMs: null,
        volume: null,
        queue: null,
        index: null,
      });
      assert.deepEqual(targetPlain.events, []);
      assert.deepEqual(bystander.events, []);
      assert.deepEqual(sender.events, []);
    } finally {
      target.unregister();
      targetPlain.unregister();
      bystander.unregister();
      sender.unregister();
    }
  });

  test("seek, volume and play_queue carry only their own fields; the queue is cleaned", async () => {
    const s = await setup();
    const target = stream(t.ctx, s.account.user.id, s.laptop.id, true);
    try {
      const to = { targetDeviceId: s.laptop.id };
      assert.equal(
        (await command(s.phone.token, { ...to, action: "seek", positionMs: 61_000, volume: 5 })).statusCode,
        202,
      );
      assert.equal((await command(s.phone.token, { ...to, action: "volume", volume: 0 })).statusCode, 202);
      const queue = [
        { ...TRACK, thumbnailUrl: "javascript:alert(1)" },
        { videoId: "a1B2c3D4e5F", title: "Song" },
      ];
      assert.equal((await command(s.phone.token, { ...to, action: "play_queue", queue, index: 1 })).statusCode, 202);

      const [seek, volume, playQueue] = target.commands().map((event) => event.payload);
      assert.deepEqual([seek?.action, seek?.positionMs, seek?.volume], ["seek", 61_000, null]);
      assert.deepEqual([volume?.action, volume?.volume, volume?.positionMs], ["volume", 0, null]);
      assert.equal(playQueue?.action, "play_queue");
      assert.equal(playQueue.index, 1);
      const cleaned = playQueue.queue as Record<string, unknown>[];
      assert.deepEqual(
        cleaned.map((track) => [track.videoId, track.title, track.artistsText, track.thumbnailUrl]),
        [
          [TRACK.videoId, TRACK.title, TRACK.artistsText, null],
          ["a1B2c3D4e5F", "Song", null, null],
        ],
      );
    } finally {
      target.unregister();
    }
  });

  test("400 invalid_request: a missing field of the action, index outside the queue, volume above 100", async () => {
    const s = await setup();
    const target = stream(t.ctx, s.account.user.id, s.laptop.id, true);
    try {
      const to = { targetDeviceId: s.laptop.id };
      for (const body of [
        { ...to, action: "seek" },
        { ...to, action: "volume" },
        { ...to, action: "volume", volume: 101 },
        { ...to, action: "play_queue", index: 0 },
        { ...to, action: "play_queue", queue: [TRACK] },
        { ...to, action: "play_queue", queue: [TRACK], index: 1 },
        { ...to, action: "shuffle" },
        { ...to, action: "pause", commandId: "not-a-uuid" },
      ]) {
        const response = await command(s.phone.token, body);
        assert.equal(response.statusCode, 400, JSON.stringify(body));
        assert.equal(json(response).code, "invalid_request");
      }
      assert.deepEqual(target.events, []);
    } finally {
      target.unregister();
    }
  });

  test("404 device_not_found: the caller itself, another account's device, an unknown id", async () => {
    const s = await setup();
    const stranger = await setup();
    const own = stream(t.ctx, s.account.user.id, s.phone.id, true);
    const foreign = stream(t.ctx, stranger.account.user.id, stranger.laptop.id, true);
    try {
      for (const targetDeviceId of [s.phone.id, stranger.laptop.id, newId()]) {
        const response = await command(s.phone.token, { targetDeviceId, action: "play" });
        assert.equal(response.statusCode, 404, targetDeviceId);
        assert.equal(json(response).code, "device_not_found");
      }
      assert.deepEqual(foreign.events, []);
      assert.deepEqual(own.events, []);
    } finally {
      own.unregister();
      foreign.unregister();
    }
  });

  test("409 device_offline without a stream, 409 remote_control_disabled with plain streams only", async () => {
    const s = await setup();
    const offline = await command(s.phone.token, { targetDeviceId: s.laptop.id, action: "next" });
    assert.equal(offline.statusCode, 409);
    assert.equal(json(offline).code, "device_offline");

    const plain = stream(t.ctx, s.account.user.id, s.laptop.id, false);
    try {
      const disabled = await command(s.phone.token, { targetDeviceId: s.laptop.id, action: "next" });
      assert.equal(disabled.statusCode, 409);
      assert.equal(json(disabled).code, "remote_control_disabled");
      assert.deepEqual(plain.events, []);
    } finally {
      plain.unregister();
    }
  });

  test("a repeated commandId within 60 s answers the same without delivering again; later it is new", async () => {
    const s = await setup();
    const target = stream(t.ctx, s.account.user.id, s.laptop.id, true);
    try {
      const body = { commandId: newId(), targetDeviceId: s.laptop.id, action: "toggle" };
      assert.deepEqual(json(await command(s.phone.token, body)), { delivered: true });
      target.unregister();
      const repeat = await command(s.phone.token, body);
      assert.equal(repeat.statusCode, 202, "the first answer even though the target left");
      assert.deepEqual(json(repeat), { delivered: true });
      assert.equal(target.commands().length, 1);

      t.clock.advance(COMMAND_REPEAT_WINDOW_MS);
      const later = await command(s.phone.token, body);
      assert.equal(later.statusCode, 409);
      assert.equal(json(later).code, "device_offline");
    } finally {
      target.unregister();
    }
  });

  test("the same commandId of another account is its own command", async () => {
    const first = await setup();
    const second = await setup();
    const a = stream(t.ctx, first.account.user.id, first.laptop.id, true);
    const b = stream(t.ctx, second.account.user.id, second.laptop.id, true);
    try {
      const commandId = newId();
      assert.equal(
        (await command(first.phone.token, { commandId, targetDeviceId: first.laptop.id, action: "stop" })).statusCode,
        202,
      );
      assert.equal(
        (await command(second.phone.token, { commandId, targetDeviceId: second.laptop.id, action: "stop" })).statusCode,
        202,
      );
      assert.equal(a.commands().length, 1);
      assert.equal(b.commands().length, 1);
    } finally {
      a.unregister();
      b.unregister();
    }
  });

  test("GET /server/info: features.remote", async () => {
    const info = json(await t.app.inject({ method: "GET", url: "/server/info" }));
    assert.deepEqual((info.features as Record<string, unknown>).remote, { version: 1 });
  });
});

describe("volume in /playback/state", () => {
  test("PUT stores volume, GET returns it; an out-of-range volume is 400", async () => {
    const s = await setup();
    const put = await putState(s.laptop.token, { volume: 65 });
    assert.equal(put.statusCode, 200, put.body);
    const get = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(s.phone.token), ...XSP },
    });
    const state = json(get).state as Record<string, unknown>;
    assert.equal(state.volume, 65);

    for (const volume of [-1, 101, 50.5]) {
      const bad = await putState(s.laptop.token, { volume });
      assert.equal(bad.statusCode, 400, String(volume));
    }
  });

  test("without volume the state has volume null", async () => {
    const s = await setup();
    assert.equal((await putState(s.tv.token, {})).statusCode, 200);
    const get = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(s.phone.token), ...XSP },
    });
    assert.equal((json(get).state as Record<string, unknown>).volume, null);
  });
});

describe("rate limits", () => {
  test("POST /playback/commands: 10 per second per sending device", async () => {
    const limited = await createTestApp({ env: { RATE_LIMIT_ENABLED: "true" } });
    try {
      const account = await createAccount(limited.ctx);
      const device = await createDevice(limited.db, account.user.id, { now: limited.clock.now(), name: "TV" });
      const target = limited.ctx.live.register({
        userId: account.user.id,
        deviceId: device.id,
        authVersion: 1,
        expiresAt: Number.MAX_SAFE_INTEGER,
        remote: true,
        send: () => undefined,
        close: () => undefined,
      });
      const send = () =>
        limited.app.inject({
          method: "POST",
          url: "/playback/commands",
          headers: { ...bearer(account.session.tokens.accessToken), ...XSP, "content-type": "application/json" },
          payload: JSON.stringify({ commandId: newId(), targetDeviceId: device.id, action: "next" }),
        });
      try {
        for (let i = 0; i < 10; i++) assert.equal((await send()).statusCode, 202, `command ${i + 1}`);
        const over = await send();
        assert.equal(over.statusCode, 429);
        assert.equal(json(over).code, "rate_limited");
      } finally {
        target.unregister();
      }
    } finally {
      await limited.close();
    }
  });
});
