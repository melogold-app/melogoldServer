/**
 * Shared helpers of the linking tests (no tests here; the `.test.ts` suffix keeps the file out of the image and under
 * the test lint rules). Every call goes through HTTP (`app.inject`) as a client would, except the database and live
 * probes the tests use to check what the API does not show.
 */
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { LiveEvent } from "../../contract/live.ts";
import type { LinkClaimed, LinkCreated, LinkDetails, LinkPollResponse } from "../../contract/linking.ts";
import { bearer } from "../../test/factories.ts";
import { json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

/** API §4.6 examples: the desktop that asks to be linked and the phone that claims an invite. */
export const DESKTOP = Object.freeze({
  hwid: "7c1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f",
  name: "DESKTOP-7Q2",
  platform: "windows",
  osVersion: "11 24H2",
  clientVersion: "0.4.0",
});
export const PHONE = Object.freeze({
  hwid: "3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1",
  name: "Google Pixel 8",
  platform: "android",
  osVersion: "16",
});

/** Address of the inject requests unless a test sets another one. */
export const LOCAL_IP = "127.0.0.1";

export type CallOptions = Readonly<{ token?: string; ip?: string }>;

export function post(
  t: TestApp,
  url: string,
  body: unknown,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(options.token === undefined ? {} : bearer(options.token)) },
    payload: JSON.stringify(body),
    remoteAddress: options.ip ?? LOCAL_IP,
  });
}

export function get(t: TestApp, url: string, token: string): Promise<LightMyRequestResponse> {
  return t.app.inject({ method: "GET", url, headers: bearer(token), remoteAddress: LOCAL_IP });
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is chosen at each call site, e.g. body<LinkCreated>(...)
function body<T>(response: LightMyRequestResponse, status: number): T {
  assert.equal(response.statusCode, status, response.body);
  return json(response) as T;
}

/** `POST /auth/link/requests` → 201 `LinkCreated`. */
export async function createRequest(t: TestApp, device: object = DESKTOP, ip: string = LOCAL_IP): Promise<LinkCreated> {
  return body<LinkCreated>(await post(t, "/auth/link/requests", { device }, { ip }), 201);
}

/** `POST /auth/me/links` → 201 `LinkCreated` (invite). */
export async function createInvite(t: TestApp, token: string, ip: string = LOCAL_IP): Promise<LinkCreated> {
  return body<LinkCreated>(await post(t, "/auth/me/links", {}, { token, ip }), 201);
}

/** `POST /auth/me/links/resolve` → 200 `LinkDetails`. */
export async function resolve(t: TestApp, token: string, code: object, ip: string = LOCAL_IP): Promise<LinkDetails> {
  return body<LinkDetails>(await post(t, "/auth/me/links/resolve", code, { token, ip }), 200);
}

/** `POST /auth/link/claim` → 200 `LinkClaimed`. */
export async function claim(
  t: TestApp,
  code: object,
  device: object = PHONE,
  ip: string = LOCAL_IP,
): Promise<LinkClaimed> {
  return body<LinkClaimed>(await post(t, "/auth/link/claim", { ...code, device }, { ip }), 200);
}

export type PollOptions = Readonly<{ knownStatus?: "pending" | "claimed"; waitSeconds?: number }>;

/** `POST /auth/link/poll` (default: no wait). */
export function pollRaw(t: TestApp, pollSecret: string, options: PollOptions = {}): Promise<LightMyRequestResponse> {
  const { knownStatus, waitSeconds = 0 } = options;
  return post(t, "/auth/link/poll", { pollSecret, waitSeconds, ...(knownStatus === undefined ? {} : { knownStatus }) });
}

export async function poll(t: TestApp, pollSecret: string, options: PollOptions = {}): Promise<LinkPollResponse> {
  return body<LinkPollResponse>(await pollRaw(t, pollSecret, options), 200);
}

export function approveRaw(t: TestApp, token: string, linkId: string, verifyCode: string) {
  return post(t, `/auth/me/links/${linkId}/approve`, { verifyCode }, { token });
}

export async function approve(t: TestApp, token: string, linkId: string, verifyCode: string): Promise<void> {
  assert.deepEqual(body(await approveRaw(t, token, linkId, verifyCode), 200), { linkId, status: "approved" });
}

export async function card(t: TestApp, token: string, linkId: string): Promise<LinkDetails> {
  return body<LinkDetails>(await get(t, `/auth/me/links/${linkId}`, token), 200);
}

/** A number of `verifyChoices` that is not the right one. */
export function wrongChoice(details: LinkDetails, right: string): string {
  const wrong = details.verifyChoices.find((choice) => choice !== right);
  assert.ok(wrong !== undefined);
  return wrong;
}

/** The stored row of a link (what the API does not show). */
export function linkRow(t: TestApp, linkId: string) {
  return t.db.read((q) => q.selectFrom("device_links").selectAll().where("id", "=", linkId).executeTakeFirstOrThrow());
}

/** Asserts that a final status erased the network hints and the new device's report (API §4.6 "Прочее"). */
export async function assertErased(t: TestApp, linkId: string): Promise<void> {
  const row = await linkRow(t, linkId);
  assert.deepEqual(
    {
      creator_net: row.creator_net,
      other_net: row.other_net,
      claimant_hwid_hash: row.claimant_hwid_hash,
      claimant_name: row.claimant_name,
      claimant_platform: row.claimant_platform,
      claimant_os_version: row.claimant_os_version,
      claimant_model: row.claimant_model,
      claimant_client_version: row.claimant_client_version,
    },
    {
      creator_net: null,
      other_net: null,
      claimant_hwid_hash: null,
      claimant_name: null,
      claimant_platform: null,
      claimant_os_version: null,
      claimant_model: null,
      claimant_client_version: null,
    },
    `link ${linkId} (${row.status})`,
  );
}

/** Live events delivered to one device of the user (a stream registered directly in the hub). */
export function captureLive(t: TestApp, userId: string, deviceId: string): LiveEvent[] {
  const events: LiveEvent[] = [];
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    send: (event) => {
      events.push(event);
    },
    close: () => undefined,
  });
  return events;
}

/** `type` and `payload` of live events, for comparison. */
export function eventsOf(events: readonly LiveEvent[]): { type: string; payload: unknown }[] {
  return events.map((event) => ({ type: event.type, payload: event.payload }));
}

/** The device rows of a user. */
export function devicesOf(t: TestApp, userId: string) {
  return t.db.read((q) => q.selectFrom("devices").selectAll().where("user_id", "=", userId).orderBy("id").execute());
}

/** Resolves after `ms` real milliseconds (lets a long-poll reach its wait). */
export function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Fails when `promise` has not settled within `ms` real milliseconds (a long-poll that was not woken). */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
