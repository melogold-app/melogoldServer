/**
 * Linking a device by QR code or user code through the server (API §4.6, DESIGN §4.10).
 *
 * | Mode      | QR shown by       | Second side attached by                 | Approves                  | Session goes to     |
 * | --------- | ----------------- | --------------------------------------- | ------------------------- | ------------------- |
 * | `request` | the new device    | `resolve` of a signed-in device         | that signed-in device     | the new device, by poll |
 * | `invite`  | a signed-in device| `claim` of the new device               | the inviting device       | the new device, by poll |
 *
 * States (DESIGN §4.10.3): `pending → claimed → approved → completed`; `claimed → denied` (deny, or a wrong
 * `verifyCode`); any unfinished → `cancelled`; an unfinished link past `expires_at` is `expired`, which is computed
 * and never stored. An unfinished link whose approving device is gone is `cancelled` too (device removal writes it,
 * {@link effectiveStatus} also covers a row whose device vanished without that path).
 *
 * Secrets (DESIGN §4.10.2), all stored as SHA-256: `linkToken` (QR), `userCode` (40 bits, manual entry) and
 * `pollSecret`, which only the new device knows: **no session is issued without it**.
 *
 * - Codes are drawn again when a unique secret collides (`INSERT … ON CONFLICT DO NOTHING RETURNING`).
 * - The approver picks one of three `verifyChoices`; a wrong number denies the link (M2).
 * - Completion is atomic and happens once, inside `poll` (DESIGN §4.10.6): `lockUser`, CAS `approved → completed`,
 *   approving device still there, device limit, upsert of the device (`linked_via = 'link'`), a new refresh token
 *   kept as `result_refresh_id`, erasure of `claimant_*` and `*_net`. For 60 s the same poll returns the same session
 *   again (m3).
 * - `sameNetwork` compares the networks of both sides (IPv4 whole, IPv6 /56); `null` with `LINK_NETWORK_HINT=false`.
 * - At most 20 active requests per network (API §1.10) and 3 active invites per user (a fourth cancels the oldest).
 *
 * SSE and waking the long-poll happen after commit only.
 */
import { hkdfSync, randomBytes, randomInt } from "node:crypto";
import type { AppContext } from "../../context.ts";
import type { AuthSession, DeviceDto, DeviceInput, UserDto } from "../../contract/common.ts";
import { CROCKFORD_ALPHABET, formatCodeGroups, USER_CODE_LENGTH } from "../../contract/common.ts";
import { LINK_LONG_POLL_SECONDS } from "../../contract/limits.ts";
import type {
  LinkClaimed,
  LinkCreated,
  LinkDecisionResponse,
  LinkDetails,
  LinkMode,
  LinkPollResponse,
  LinkStatus,
} from "../../contract/linking.ts";
import { lockUser } from "../../db/heads.ts";
import type { Queryable } from "../../db/index.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { SECOND_MS } from "../../lib/clock.ts";
import { constantTimeEqual, hmacSha256 } from "../../lib/crypto.ts";
import { UNFINISHED_LINK_STATUSES } from "../../lib/device-removal.ts";
import { newId } from "../../lib/ids.ts";
import { issueSession, sessionConfig, tokensForRefreshRow } from "../../lib/session.ts";
import type { IssuedSession } from "../../lib/session.ts";
import { formatIso, formatIsoOrNull } from "../../lib/time.ts";
import { hashToken, newLinkToken, newPollSecret } from "../../lib/tokens.ts";
import { approveLinkGate, recentUntil } from "../security/policy.ts";
import * as repo from "./linking.repository.ts";
import type { DeviceRow, LinkRow, RefreshTokenRow, UnfinishedLinkStatus, UserRow } from "./linking.repository.ts";
import { LinkWaiters } from "./long-poll.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/** API §1.10: at most 20 active `request` links per network (IPv4 whole, IPv6 /56). */
export const MAX_ACTIVE_REQUESTS_PER_NET = 20;
/** API §1.10, §4.6: at most 3 active invites per user; a fourth cancels the oldest. */
export const MAX_ACTIVE_INVITES_PER_USER = 3;
/** DESIGN §4.10.6 (m3): the same poll returns the same session again for 60 s after `completed`. */
export const COMPLETED_REPOLL_MS = 60 * SECOND_MS;
/** DESIGN §4.10.4: the approval card offers three numbers. */
export const VERIFY_CHOICES_COUNT = 3;
/** New secrets drawn after a unique collision before giving up with a 500. */
export const CODE_ATTEMPTS = 5;
/** A poll that loses the completion race this often in a row answers `503 server_busy`. */
const COMPLETION_ATTEMPTS = 3;
/** Re-runs of a decision whose CAS lost a race (the status is read again). */
const DECISION_ATTEMPTS = 3;
/** HKDF `info` of the key behind `verifyChoices` (derived from the refresh-token subkey). */
const VERIFY_CHOICES_INFO = "melogold/link-verify-choices/v1";

const UNFINISHED: readonly string[] = UNFINISHED_LINK_STATUSES;

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------------------------------

/** A new `UserCode` (API §1.6): 8 Crockford characters, 40 bits, without separator (`randomBytes % 32` is unbiased). */
export function newUserCode(): string {
  let code = "";
  for (const byte of randomBytes(USER_CODE_LENGTH)) code += CROCKFORD_ALPHABET.charAt(byte % 32);
  return code;
}

/** A new `VerifyCode` (API §1.6): two digits, uniform over 00..99. */
export function newVerifyCode(): string {
  return String(randomInt(0, 100)).padStart(2, "0");
}

/** The key of {@link verifyChoices}: HKDF of the refresh-token subkey, so the choices survive restarts. */
export function verifyChoicesKey(refreshTokenKey: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", refreshTokenKey, new Uint8Array(0), VERIFY_CHOICES_INFO, 32));
}

/**
 * The three numbers of the approval card (DESIGN §4.10.4): `verifyCode` and two other distinct codes, the right one
 * at a uniformly chosen position. Deterministic per link (the card shows the same numbers on every read) and keyed
 * with a server secret, so the card does not reveal which number is right.
 */
export function verifyChoices(key: Uint8Array, linkId: string, verifyCode: string): string[] {
  let counter = 0;
  let pool: number[] = [];
  const nextByte = (): number => {
    if (pool.length === 0) {
      pool = [...hmacSha256(key, `${linkId}|${verifyCode}|${counter}`)];
      counter += 1;
    }
    return pool.shift() ?? 0;
  };
  const others: string[] = [];
  while (others.length < VERIFY_CHOICES_COUNT - 1) {
    const byte = nextByte();
    if (byte >= 200) continue; // 200 = 2 × 100: unbiased modulo
    const candidate = String(byte % 100).padStart(2, "0");
    if (candidate !== verifyCode && !others.includes(candidate)) others.push(candidate);
  }
  let byte = nextByte();
  while (byte >= 255) byte = nextByte(); // 255 = 85 × 3
  const position = byte % VERIFY_CHOICES_COUNT;
  return [...others.slice(0, position), verifyCode, ...others.slice(position)];
}

/** A refresh token the repeated poll may re-sign. */
function isCurrentToken(token: RefreshTokenRow, now: number): boolean {
  return token.rotated_to_id === null && token.revoked_at === null && token.expires_at > now;
}

/** Whether an unfinished link has lost its approving device (the approver was set: always for an invite). */
function approverGone(link: Pick<LinkRow, "mode" | "status" | "approver_device_id">): boolean {
  return link.approver_device_id === null && (link.mode === "invite" || link.status !== "pending");
}

/**
 * The status clients see (DESIGN §4.10.3): the stored one, except that an unfinished link whose approving device is
 * gone is `cancelled`, and an unfinished link past `expires_at` is `expired`.
 */
export function effectiveStatus(
  link: Pick<LinkRow, "mode" | "status" | "approver_device_id" | "expires_at">,
  now: number,
): LinkStatus {
  const status = link.status as LinkStatus;
  if (!UNFINISHED.includes(status)) return status;
  if (approverGone(link)) return "cancelled";
  if (link.expires_at <= now) return "expired";
  return status;
}

/** `sameNetwork` (DESIGN §4.10.5): both networks known and the hint enabled. */
export function sameNetwork(link: Pick<LinkRow, "creator_net" | "other_net">, networkHint: boolean): boolean | null {
  if (!networkHint || link.creator_net === null || link.other_net === null) return null;
  return link.creator_net === link.other_net;
}

/** API §4.1 `UserDto`. */
export function userDto(user: UserRow): UserDto {
  return {
    id: user.id,
    login: user.login,
    createdAt: formatIso(user.created_at),
    passwordChangedAt: formatIso(user.password_changed_at),
    recoveryCodeStatus: {
      createdAt: formatIso(user.recovery_code_created_at),
      confirmed: user.recovery_code_confirmed_at !== null,
    },
  };
}

/** API §4.1 `DeviceDto` of the device that receives the session (`isCurrent`). */
export function deviceDto(device: DeviceRow, now: number, newDeviceRestrictHours: number): DeviceDto {
  const until = recentUntil(
    { id: device.id, linkedVia: device.linked_via, createdAt: device.created_at },
    { now, newDeviceRestrictHours },
  );
  return {
    id: device.id,
    name: device.custom_name ?? device.reported_name,
    reportedName: device.reported_name,
    customName: device.custom_name,
    platform: device.platform,
    osVersion: device.os_version,
    model: device.model,
    clientVersion: device.client_version,
    linkedVia: device.linked_via,
    linkedByDeviceId: device.linked_by_device_id,
    createdAt: formatIso(device.created_at),
    lastSeenAt: formatIso(device.last_seen_at),
    lastSyncAt: formatIsoOrNull(device.last_sync_at),
    recentUntil: formatIsoOrNull(until),
    isCurrent: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------------

/** Sources of randomness (tests replace them to force collisions or known numbers). */
export type LinkSecrets = Readonly<{
  userCode: () => string;
  linkToken: () => string;
  pollSecret: () => string;
  verifyCode: () => string;
}>;

export const DEFAULT_LINK_SECRETS: LinkSecrets = Object.freeze({
  userCode: newUserCode,
  linkToken: newLinkToken,
  pollSecret: newPollSecret,
  verifyCode: newVerifyCode,
});

export type LinkingServiceOptions = Readonly<{
  waiters?: LinkWaiters;
  secrets?: Partial<LinkSecrets>;
}>;

/** `linkToken` xor `userCode` (the schema guarantees exactly one). */
export type LinkCode = Readonly<{ linkToken?: string | undefined; userCode?: string | undefined }>;

export type PollInput = Readonly<{
  pollSecret: string;
  /** 0..25 s, default 25. */
  waitSeconds?: number | undefined;
  knownStatus?: "pending" | "claimed" | undefined;
  /** Aborts the wait when the client goes away. */
  signal?: AbortSignal;
}>;

type Refusal = Readonly<{ kind: "refuse"; error: AppError }>;

function refuse(error: AppError): Refusal {
  return { kind: "refuse", error };
}

/** Link data the approver side sees about the other side. */
type LinkParties = Readonly<{ user: UserRow | undefined; approver: DeviceRow | undefined }>;

export type LinkingService = ReturnType<typeof createLinkingService>;

export function createLinkingService(ctx: AppContext, options: LinkingServiceOptions = {}) {
  const waiters = options.waiters ?? new LinkWaiters();
  const secrets: LinkSecrets = { ...DEFAULT_LINK_SECRETS, ...options.secrets };
  const session = sessionConfig(ctx.env, ctx.keys);
  const choicesKey = verifyChoicesKey(ctx.keys.refreshToken);
  const ttlMs = ctx.env.LINK_TTL_SECONDS * SECOND_MS;
  const hint = ctx.env.LINK_NETWORK_HINT;

  /** The network to store for the network hint: none when the hint is off (the `lan` mode hides addresses). */
  const hintNet = (net: string): string | null => (hint ? net : null);

  function findByCode(q: Queryable, code: LinkCode): Promise<LinkRow | undefined> {
    if (code.linkToken !== undefined) return repo.findLinkByTokenHash(q, hashToken(code.linkToken));
    if (code.userCode !== undefined) return repo.findLinkByCodeHash(q, hashToken(code.userCode));
    return Promise.resolve(undefined);
  }

  /** Inserts a link, drawing new secrets while a unique one collides. */
  async function insertWithFreshSecrets(
    q: Queryable,
    base: Omit<repo.NewLinkRow, "id" | "token_hash" | "code_hash" | "poll_secret_hash">,
    withPollSecret: boolean,
  ): Promise<Readonly<{ id: string; linkToken: string; userCode: string; pollSecret: string | null }>> {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const id = newId();
      const linkToken = secrets.linkToken();
      const userCode = secrets.userCode();
      const pollSecret = withPollSecret ? secrets.pollSecret() : null;
      const inserted = await repo.insertLink(q, {
        ...base,
        id,
        token_hash: hashToken(linkToken),
        code_hash: hashToken(userCode),
        poll_secret_hash: pollSecret === null ? null : hashToken(pollSecret),
      });
      if (inserted) return { id, linkToken, userCode, pollSecret };
    }
    throw new Error(`device link secrets collided ${CODE_ATTEMPTS} times in a row`);
  }

  function linkCreated(
    mode: LinkMode,
    inserted: Readonly<{ id: string; linkToken: string; userCode: string; pollSecret: string | null }>,
    expiresAt: number,
  ): LinkCreated {
    return {
      linkId: inserted.id,
      mode,
      serverId: ctx.serverId,
      linkToken: inserted.linkToken,
      userCode: formatCodeGroups(inserted.userCode),
      pollSecret: inserted.pollSecret,
      expiresAt: formatIso(expiresAt),
      longPollSeconds: LINK_LONG_POLL_SECONDS,
    };
  }

  async function parties(q: Queryable, link: LinkRow): Promise<LinkParties> {
    const user = link.user_id === null ? undefined : await repo.findUser(q, link.user_id);
    const approver =
      link.user_id === null || link.approver_device_id === null
        ? undefined
        : await repo.findDevice(q, link.user_id, link.approver_device_id);
    return { user, approver };
  }

  /** `LinkDetails` of a link that belongs to the caller's account (resolve, GET, the approval card). */
  async function details(q: Queryable, link: LinkRow, now: number): Promise<LinkDetails> {
    const status = effectiveStatus(link, now);
    // Final and expired links show nothing about the other side (a final status erased it anyway).
    const final = !UNFINISHED.includes(status);
    let device: LinkDetails["device"] = null;
    if (!final && link.claimant_name !== null && link.claimant_platform !== null) {
      const alreadyLinked =
        link.user_id !== null && link.claimant_hwid_hash !== null
          ? (await repo.findDeviceIdByHwid(q, link.user_id, link.claimant_hwid_hash)) !== undefined
          : false;
      device = {
        name: link.claimant_name,
        platform: link.claimant_platform,
        osVersion: link.claimant_os_version,
        model: link.claimant_model,
        clientVersion: link.claimant_client_version,
        alreadyLinked,
      };
    }
    return {
      linkId: link.id,
      mode: link.mode,
      status,
      createdAt: formatIso(link.created_at),
      expiresAt: formatIso(link.expires_at),
      device,
      sameNetwork: final ? null : sameNetwork(link, hint),
      verifyChoices:
        status === "claimed" && link.verify_code !== null ? verifyChoices(choicesKey, link.id, link.verify_code) : [],
    };
  }

  /** Wakes the polls of these links and tells their approving devices (other than `except`) about the new status. */
  function announce(
    links: readonly Pick<LinkRow, "id" | "user_id" | "approver_device_id">[],
    status: "claimed" | "cancelled" | "completed" | null,
    exceptDeviceId?: string,
  ): void {
    for (const link of links) {
      waiters.wake(link.id);
      if (status === null || link.user_id === null || link.approver_device_id === null) continue;
      if (link.approver_device_id === exceptDeviceId) continue;
      ctx.live.publish(
        link.user_id,
        "link.updated",
        { linkId: link.id, status },
        { onlyDeviceId: link.approver_device_id },
      );
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The new device's side: /auth/link/*
  // -------------------------------------------------------------------------------------------------------------------

  /** `POST /auth/link/requests`: mode `request`, the new device shows the QR code. */
  async function createRequest(device: DeviceInput, net: string): Promise<LinkCreated> {
    const now = ctx.clock.now();
    const expiresAt = now + ttlMs;
    const out = await ctx.db.write(async (q) => {
      const active = await repo.countActiveRequestsFromNet(q, net, now);
      if (active.count >= MAX_ACTIVE_REQUESTS_PER_NET) {
        const until = active.oldestExpiresAt ?? now + ttlMs;
        const retryAfterSeconds = Math.max(1, Math.ceil((until - now) / SECOND_MS));
        return refuse(new AppError("rate_limited", { details: { retryAfterSeconds } }));
      }
      const inserted = await insertWithFreshSecrets(
        q,
        {
          mode: "request",
          status: "pending",
          user_id: null,
          approver_device_id: null,
          claimant_hwid_hash: hashToken(device.hwid),
          claimant_name: device.name,
          claimant_platform: device.platform,
          claimant_os_version: device.osVersion ?? null,
          claimant_model: device.model ?? null,
          claimant_client_version: device.clientVersion ?? null,
          // The network of a request is kept even without the hint: it enforces the 20-per-IP limit.
          creator_net: net,
          created_at: now,
          expires_at: expiresAt,
        },
        true,
      );
      return { kind: "created", inserted } as const;
    });
    if (out.kind === "refuse") throw out.error;
    return linkCreated("request", out.inserted, expiresAt);
  }

  /** `POST /auth/link/claim`: mode `invite`, the new device attaches itself to an invite it scanned or typed. */
  async function claim(code: LinkCode, device: DeviceInput, net: string): Promise<LinkClaimed> {
    const now = ctx.clock.now();
    const out = await ctx.db.write(async (q) => {
      for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
        const link = await findByCode(q, code);
        if (!link) return refuse(new AppError("link_not_found"));
        if (link.mode !== "invite") return refuse(new AppError("link_wrong_mode"));
        if (link.claimed_at !== null) return refuse(new AppError("link_already_claimed"));
        if (effectiveStatus(link, now) !== "pending" || link.user_id === null) {
          return refuse(new AppError("link_expired"));
        }
        const { user, approver } = await parties(q, link);
        if (!user || !approver) return refuse(new AppError("link_expired"));
        const pollSecret = secrets.pollSecret();
        const verifyCode = secrets.verifyCode();
        const claimed = await repo.claimLink(
          q,
          link.id,
          {
            userId: user.id,
            approverDeviceId: approver.id,
            verifyCode,
            otherNet: hintNet(net),
            pollSecretHash: hashToken(pollSecret),
            claimant: {
              hwidHash: hashToken(device.hwid),
              name: device.name,
              platform: device.platform,
              osVersion: device.osVersion ?? null,
              model: device.model ?? null,
              clientVersion: device.clientVersion ?? null,
            },
          },
          now,
        );
        // Lost the race to another claimer: read the link again (READ COMMITTED sees the winner).
        if (!claimed) continue;
        const response: LinkClaimed = {
          linkId: claimed.id,
          status: "claimed",
          pollSecret,
          account: { login: user.login },
          approverDevice: { name: approver.custom_name ?? approver.reported_name, platform: approver.platform },
          verifyCode,
          expiresAt: formatIso(claimed.expires_at),
          longPollSeconds: LINK_LONG_POLL_SECONDS,
        };
        return { kind: "claimed", link: claimed, response } as const;
      }
      return refuse(new AppError("link_already_claimed"));
    });
    if (out.kind === "refuse") throw out.error;
    announce([out.link], "claimed");
    return out.response;
  }

  /** The poll answer for a link that is `pending` or `claimed`. */
  function pendingAnswer(link: LinkRow, status: "pending" | "claimed", found: LinkParties): LinkPollResponse {
    const { user, approver } = found;
    const answer: LinkPollResponse = {
      linkId: link.id,
      status,
      expiresAt: formatIso(link.expires_at),
      account: null,
      approverDevice: null,
      verifyCode: null,
      session: null,
    };
    if (status !== "claimed" || user === undefined || approver === undefined) return answer;
    return {
      ...answer,
      account: { login: user.login },
      approverDevice: { name: approver.custom_name ?? approver.reported_name, platform: approver.platform },
      verifyCode: link.verify_code,
    };
  }

  function completedAnswer(
    link: LinkRow,
    user: UserRow,
    approver: DeviceRow | undefined,
    device: DeviceRow,
    issued: IssuedSession,
    now: number,
  ): LinkPollResponse {
    const authSession: AuthSession = {
      user: userDto(user),
      device: deviceDto(device, now, ctx.env.NEW_DEVICE_RESTRICT_HOURS),
      tokens: { ...issued.tokens },
      serverId: ctx.serverId,
      serverTime: formatIso(now),
      recoveryCode: null,
      signedOutDevices: 0,
    };
    return {
      linkId: link.id,
      status: "completed",
      expiresAt: formatIso(link.expires_at),
      account: { login: user.login },
      approverDevice: approver
        ? { name: approver.custom_name ?? approver.reported_name, platform: approver.platform }
        : null,
      verifyCode: link.verify_code,
      session: authSession,
    };
  }

  /** The same session again within 60 s of `completed` (m3), re-signed from `result_refresh_id`. */
  async function repeatedCompletion(q: Queryable, link: LinkRow, now: number): Promise<LinkPollResponse | null> {
    if (link.completed_at === null || now >= link.completed_at + COMPLETED_REPOLL_MS) return null;
    if (link.user_id === null || link.result_refresh_id === null) return null;
    const token = await repo.findRefreshToken(q, link.result_refresh_id);
    // Only a token that is still current: not rotated, not revoked, not expired (DESIGN §4.10.6).
    if (token === undefined || !isCurrentToken(token, now)) return null;
    const user = await repo.findUser(q, token.user_id);
    const device = await repo.findDevice(q, token.user_id, token.device_id);
    if (!user || !device) return null;
    const approver =
      link.approver_device_id === null ? undefined : await repo.findDevice(q, user.id, link.approver_device_id);
    const issued = tokensForRefreshRow(token, user.auth_version, session, now);
    return completedAnswer(link, user, approver, device, issued, now);
  }

  type Completion =
    | Readonly<{ kind: "lost" }>
    | Readonly<{ kind: "cancelled"; link: LinkRow }>
    | Readonly<{
        kind: "completed";
        link: LinkRow;
        user: UserRow;
        approver: DeviceRow;
        device: DeviceRow;
        issued: IssuedSession;
      }>;

  /** DESIGN §4.10.6: the atomic, exactly-once completion of an approved link. */
  async function complete(link: LinkRow): Promise<LinkPollResponse | null> {
    const userId = link.user_id;
    if (userId === null) return null;
    const now = ctx.clock.now();
    const limit = ctx.env.MAX_DEVICES_PER_USER;
    const out = await ctx.db.write(async (q): Promise<Completion> => {
      await lockUser(q, userId);
      const completed = await repo.completeLink(q, link.id, userId, now);
      if (!completed) return { kind: "lost" };
      const approver =
        completed.approver_device_id === null
          ? undefined
          : await repo.findDevice(q, userId, completed.approver_device_id);
      const hwidHash = completed.claimant_hwid_hash;
      const name = completed.claimant_name;
      const platform = completed.claimant_platform;
      if (!approver || hwidHash === null || name === null || platform === null) {
        await repo.cancelCompletedLink(q, completed.id, now);
        return { kind: "cancelled", link: completed };
      }
      const existing = await repo.findDeviceIdByHwid(q, userId, hwidHash);
      if (existing === undefined && limit !== null) {
        const count = await repo.countDevices(q, userId);
        // Thrown inside the transaction: the link stays approved, so the poll succeeds once a slot is free.
        if (count >= limit) {
          throw new AppError("device_limit_reached", { details: { deviceLimit: limit, deviceCount: count } });
        }
      }
      const user = await repo.findUser(q, userId);
      if (!user) throw new AppError("link_not_found");
      const device = await repo.upsertLinkedDevice(q, {
        id: newId(),
        userId,
        hwidHash,
        reportedName: name,
        platform,
        osVersion: completed.claimant_os_version,
        model: completed.claimant_model,
        clientVersion: completed.claimant_client_version,
        linkedByDeviceId: approver.id,
        now,
      });
      const issued = await issueSession(
        q,
        {
          userId,
          deviceId: device.id,
          authVersion: user.auth_version,
          now,
          // A device the account already had with this hwid starts a new token family (like login, DESIGN §4.6).
          replaceDeviceTokens: existing !== undefined,
        },
        session,
      );
      await repo.setLinkResult(q, completed.id, device.id, issued.refreshId);
      return { kind: "completed", link: completed, user, approver, device, issued };
    });
    switch (out.kind) {
      case "lost":
        return null;
      case "cancelled":
        announce([out.link], null);
        throw new AppError("link_cancelled");
      case "completed": {
        ctx.live.publish(userId, "devices.updated", { reason: "device_added", deviceId: out.device.id });
        announce([out.link], "completed");
        return completedAnswer(out.link, out.user, out.approver, out.device, out.issued, now);
      }
    }
  }

  /**
   * `POST /auth/link/poll`: the status for the new device, waiting while it equals `knownStatus`; completes an
   * approved link and returns the session.
   */
  async function poll(input: PollInput): Promise<LinkPollResponse> {
    const pollSecretHash = hashToken(input.pollSecret);
    const deadline = performance.now() + (input.waitSeconds ?? LINK_LONG_POLL_SECONDS) * SECOND_MS;
    let lostCompletions = 0;
    for (;;) {
      const now = ctx.clock.now();
      const state = await ctx.db.read(async (q) => {
        const link = await repo.findLinkByPollSecretHash(q, pollSecretHash);
        if (!link) return undefined;
        const status = effectiveStatus(link, now);
        if (status === "completed") return { link, status, repeated: await repeatedCompletion(q, link, now) };
        if (status === "pending" || status === "claimed") return { link, status, found: await parties(q, link) };
        return { link, status };
      });
      if (!state) throw new AppError("link_not_found");
      const { link, status } = state;
      switch (status) {
        case "pending":
        case "claimed": {
          const { found } = state;
          if (status !== input.knownStatus || waiters.closed || ctx.lifecycle.isDraining()) {
            return pendingAnswer(link, status, found);
          }
          const remaining = Math.min(deadline - performance.now(), link.expires_at - ctx.clock.now());
          if (remaining <= 0 && link.expires_at > ctx.clock.now()) return pendingAnswer(link, status, found);
          const outcome = await waiters.wait(link.id, remaining, input.signal);
          if (outcome === "aborted") return pendingAnswer(link, status, found);
          continue;
        }
        case "approved": {
          const answer = await complete(link);
          if (answer) return answer;
          lostCompletions += 1;
          if (lostCompletions >= COMPLETION_ATTEMPTS) {
            throw new AppError("server_busy", { details: { retryAfterSeconds: 1 } });
          }
          continue;
        }
        case "completed": {
          if (state.repeated) return state.repeated;
          throw new AppError("link_expired");
        }
        case "denied":
          throw new AppError("link_denied");
        case "cancelled":
          throw new AppError("link_cancelled");
        case "expired":
          throw new AppError("link_expired");
      }
    }
  }

  /** `POST /auth/link/cancel`: the new device gives up; 204 also when the link is already final or expired. */
  async function cancelByPollSecret(pollSecret: string): Promise<void> {
    const now = ctx.clock.now();
    const out = await ctx.db.write(async (q) => {
      const link = await repo.findLinkByPollSecretHash(q, hashToken(pollSecret));
      if (!link) return refuse(new AppError("link_not_found"));
      const cancelled = await repo.cancelLinks(q, [link.id], now);
      return { kind: "done", cancelled } as const;
    });
    if (out.kind === "refuse") throw out.error;
    announce(out.cancelled, "cancelled");
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The signed-in device's side: /auth/me/links*
  // -------------------------------------------------------------------------------------------------------------------

  /** `POST /auth/me/links`: mode `invite`, the signed-in device shows the QR code. */
  async function createInvite(auth: RequestAuth, net: string): Promise<LinkCreated> {
    const now = ctx.clock.now();
    const expiresAt = now + ttlMs;
    const out = await ctx.db.write(async (q) => {
      const active = await repo.listActiveInvites(q, auth.userId, now);
      const excess = active.length - (MAX_ACTIVE_INVITES_PER_USER - 1);
      const cancelled =
        excess > 0
          ? await repo.cancelLinks(
              q,
              active.slice(0, excess).map((link) => link.id),
              now,
            )
          : [];
      const inserted = await insertWithFreshSecrets(
        q,
        {
          mode: "invite",
          status: "pending",
          user_id: auth.userId,
          approver_device_id: auth.deviceId,
          creator_net: hintNet(net),
          created_at: now,
          expires_at: expiresAt,
        },
        false,
      );
      return { inserted, cancelled };
    });
    announce(out.cancelled, "cancelled", auth.deviceId);
    return linkCreated("invite", out.inserted, expiresAt);
  }

  /** `POST /auth/me/links/resolve`: mode `request`, the signed-in device attaches itself to a new device's QR code. */
  async function resolve(auth: RequestAuth, code: LinkCode, net: string): Promise<LinkDetails> {
    const now = ctx.clock.now();
    const out = await ctx.db.write(async (q) => {
      for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
        const link = await findByCode(q, code);
        if (!link) return refuse(new AppError("link_not_found"));
        if (link.mode !== "request") return refuse(new AppError("link_wrong_mode"));
        if (link.claimed_at !== null) {
          // A repeated resolve of the same device gets the same answer (API §1.8); anybody else is refused.
          if (link.user_id === auth.userId && link.approver_device_id === auth.deviceId) {
            return { kind: "details", details: await details(q, link, now), changed: null } as const;
          }
          return refuse(new AppError("link_already_claimed"));
        }
        if (effectiveStatus(link, now) !== "pending") return refuse(new AppError("link_expired"));
        const claimed = await repo.claimLink(
          q,
          link.id,
          {
            userId: auth.userId,
            approverDeviceId: auth.deviceId,
            verifyCode: secrets.verifyCode(),
            otherNet: hintNet(net),
          },
          now,
        );
        if (!claimed) continue;
        return { kind: "details", details: await details(q, claimed, now), changed: claimed } as const;
      }
      return refuse(new AppError("link_already_claimed"));
    });
    if (out.kind === "refuse") throw out.error;
    if (out.changed) announce([out.changed], null);
    return out.details;
  }

  /** A link of the caller's account, or `404 link_not_found` (another account's link is never revealed). */
  function ownLink(link: LinkRow | undefined, auth: RequestAuth): link is LinkRow {
    return link?.user_id === auth.userId;
  }

  /** `GET /auth/me/links/{linkId}`: the approval card. */
  async function get(auth: RequestAuth, linkId: string): Promise<LinkDetails> {
    const now = ctx.clock.now();
    const out = await ctx.db.read(async (q) => {
      const link = await repo.findLinkById(q, linkId);
      if (!ownLink(link, auth)) return undefined;
      return details(q, link, now);
    });
    if (!out) throw new AppError("link_not_found");
    return out;
  }

  type Decision =
    | Refusal
    | Readonly<{ kind: "retry" }>
    | Readonly<{ kind: "decided"; response: LinkDecisionResponse; changed: LinkRow | null; mismatch: boolean }>;

  /**
   * Runs a decision whose CAS may lose a race to the other side: the transaction then commits nothing and the
   * decision runs again on the new status.
   */
  async function decide(
    fn: (q: Queryable, now: number) => Promise<Decision>,
  ): Promise<Extract<Decision, { kind: "decided" }>> {
    for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
      const now = ctx.clock.now();
      const out = await ctx.db.write((q) => fn(q, now));
      if (out.kind === "refuse") throw out.error;
      if (out.kind === "decided") return out;
    }
    throw new AppError("server_busy", { details: { retryAfterSeconds: 1 } });
  }

  /** `POST /auth/me/links/{linkId}/approve` with the number the new device shows. */
  async function approve(auth: RequestAuth, linkId: string, verifyCode: string): Promise<LinkDecisionResponse> {
    const limit = ctx.env.MAX_DEVICES_PER_USER;
    const out = await decide(async (q, now) => {
      const link = await repo.findLinkById(q, linkId);
      if (!ownLink(link, auth)) return refuse(new AppError("link_not_found"));
      const status = effectiveStatus(link, now);
      const mine = link.approver_device_id === auth.deviceId;
      const approved = { linkId: link.id, status: "approved" } as const;
      // A repeated approve in the reached status gets the same answer (API §1.8).
      if (mine && (status === "approved" || status === "completed")) {
        return { kind: "decided", response: approved, changed: null, mismatch: false };
      }
      if (mine && status === "denied" && link.deny_reason === "verify_mismatch") {
        return refuse(new AppError("link_verify_mismatch"));
      }
      if (status === "expired") return refuse(new AppError("link_expired"));
      if (status === "cancelled") return refuse(new AppError("link_cancelled"));
      if (status !== "claimed" || !mine) return refuse(new AppError("link_not_claimed"));
      const gate = approveLinkGate();
      if (gate.outcome !== "allow") return refuse(new AppError("link_not_claimed"));

      if (link.verify_code === null || !constantTimeEqual(verifyCode, link.verify_code)) {
        const denied = await repo.denyLink(q, link.id, "verify_mismatch", ["claimed"], now);
        if (!denied) return { kind: "retry" };
        return { kind: "decided", response: { linkId: link.id, status: "denied" }, changed: link, mismatch: true };
      }
      if (limit !== null && link.claimant_hwid_hash !== null) {
        const existing = await repo.findDeviceIdByHwid(q, auth.userId, link.claimant_hwid_hash);
        if (existing === undefined) {
          const count = await repo.countDevices(q, auth.userId);
          if (count >= limit) {
            return refuse(
              new AppError("device_limit_reached", { details: { deviceLimit: limit, deviceCount: count } }),
            );
          }
        }
      }
      if (!(await repo.approveLink(q, link.id, auth.deviceId, now))) return { kind: "retry" };
      return { kind: "decided", response: approved, changed: link, mismatch: false };
    });
    if (out.changed) announce([out.changed], null);
    if (out.mismatch) throw new AppError("link_verify_mismatch");
    return out.response;
  }

  /** `POST /auth/me/links/{linkId}/deny`: any device of the account refuses an unfinished link. */
  async function deny(auth: RequestAuth, linkId: string): Promise<LinkDecisionResponse> {
    const out = await decide(async (q, now) => {
      const link = await repo.findLinkById(q, linkId);
      if (!ownLink(link, auth)) return refuse(new AppError("link_not_found"));
      const status = effectiveStatus(link, now);
      const denied = { linkId: link.id, status: "denied" } as const;
      if (status === "denied") return { kind: "decided", response: denied, changed: null, mismatch: false };
      if (!UNFINISHED.includes(status)) return refuse(new AppError("link_expired"));
      const from = [status as UnfinishedLinkStatus];
      if (!(await repo.denyLink(q, link.id, "user", from, now))) return { kind: "retry" };
      return { kind: "decided", response: denied, changed: link, mismatch: false };
    });
    if (out.changed) announce([out.changed], null);
    return out.response;
  }

  /** `POST /auth/me/links/{linkId}/cancel`: any device of the account withdraws a link; 204 when already final. */
  async function cancel(auth: RequestAuth, linkId: string): Promise<void> {
    const now = ctx.clock.now();
    const out = await ctx.db.write(async (q) => {
      const link = await repo.findLinkById(q, linkId);
      if (!ownLink(link, auth)) return refuse(new AppError("link_not_found"));
      return { kind: "done", cancelled: await repo.cancelLinks(q, [link.id], now) } as const;
    });
    if (out.kind === "refuse") throw out.error;
    announce(out.cancelled, "cancelled", auth.deviceId);
  }

  /** Shutdown: every waiting poll answers now (`preClose`). */
  function close(): void {
    waiters.close();
  }

  return Object.freeze({
    createRequest,
    claim,
    poll,
    cancelByPollSecret,
    createInvite,
    resolve,
    get,
    approve,
    deny,
    cancel,
    close,
    waiters,
  });
}
