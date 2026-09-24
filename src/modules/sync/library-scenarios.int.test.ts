/**
 * Runs `spec/sync-scenarios/library.json` against the real `like.set`/`bookmark.set` handlers, through the real
 * `POST /sync` route (PLAN T2.1 Приёмка "library.json: все сценарии лайков и закладок").
 *
 * (T2.2's playlist ops go through a synthetic `OpCtx` factory instead, since their kinds are not yet wired into
 * `/sync`; T2.1's own two kinds already are, so the full route is the more complete, and equally fast, path here.)
 *
 * **File format** (`spec/sync-scenarios/library.json`): `{ scenarios: Scenario[] }`, each
 * `Scenario = { name, steps: Step[], expectFinal?: { like?, bookmark? } }`, run against scenario-local
 * videoId/browseId keys (no interference between scenarios). Each
 * `Step = { device: 0|1|2, op: {kind, at, base?, ...fields}, capture?: string, expect: {status, code} }`:
 * - `device` selects one of three fixed test devices whose ids compare ordinally `"00000000-…" < "11111111-…" <
 *   "22222222-…"` (DESIGN §3.4's device tie-break);
 * - `op.base`, when present, is either `""` (the client had seen nothing) or the `capture` label of an earlier step
 *   in the same scenario (that step's resulting cursor) — never a raw cursor, since seq numbers are not known ahead
 *   of time;
 * - `expectFinal.like`/`.bookmark` are checked by a **partial** match against the stored row after every step of the
 *   scenario ran: only the fields the scenario names are asserted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { fromDbBool } from "../../db/codecs.ts";
import { newId } from "../../lib/ids.ts";
import { formatIsoOrNull } from "../../lib/time.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

type Step = Readonly<{
  device: 0 | 1 | 2;
  op: Readonly<{ kind: string; at: string; base?: string }> & Record<string, unknown>;
  capture?: string;
  expect: Readonly<{ status: string; code: string | null }>;
}>;

type Scenario = Readonly<{
  name: string;
  steps: readonly Step[];
  expectFinal?: Readonly<{
    like?: Readonly<{ videoId: string; liked: boolean; likedAt: string | null }>;
    bookmark?: Readonly<{ type: string; browseId: string }> & Record<string, unknown>;
  }>;
}>;

type LibraryScenarios = Readonly<{ scenarios: readonly Scenario[] }>;

const FIXTURE_URL = new URL("../../../spec/sync-scenarios/library.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as LibraryScenarios;

const DEVICE_IDS = [
  "00000000-0000-4000-8000-000000000000",
  "11111111-0000-4000-8000-000000000000",
  "22222222-0000-4000-8000-000000000000",
] as const;

let t: TestApp;
let account: TestAccount;
let tokens: readonly string[];

before(async () => {
  t = await createTestApp();
  account = await createAccount(t.ctx, { device: { id: DEVICE_IDS[0] } });
  const rest = await Promise.all(
    [DEVICE_IDS[1], DEVICE_IDS[2]].map(async (id) => {
      const device = await createDevice(t.db, account.user.id, { id });
      const session = await createSession(t.ctx, { userId: account.user.id, deviceId: device.id });
      return session.tokens.accessToken;
    }),
  );
  tokens = [account.session.tokens.accessToken, ...rest];
});

after(async () => {
  await t.close();
});

function postSync(token: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url: "/sync",
    headers: { ...bearer(token), "x-sync-protocol": "1", "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("spec/sync-scenarios/library.json", () => {
  test("the fixture parses and every scenario is well-formed", () => {
    assert.ok(fixture.scenarios.length > 0);
    for (const scenario of fixture.scenarios) assert.ok(scenario.steps.length > 0, scenario.name);
  });

  for (const scenario of fixture.scenarios) {
    test(scenario.name, async () => {
      const captures = new Map<string, string>();
      for (const step of scenario.steps) {
        const { kind, at, base, ...fields } = step.op;
        const opBody: Record<string, unknown> = { opId: newId(), kind, at, ...fields };
        if (base !== undefined)
          opBody.base = base === "" ? "" : (captures.get(base) ?? assert.fail(`no capture "${base}"`));

        const response = json(await postSync(tokens[step.device]!, { cursor: "", ops: [opBody] }));
        const result = (response.results as Record<string, unknown>[])[0];
        assert.equal(result?.status, step.expect.status, `${scenario.name}: ${JSON.stringify(step.op)}`);
        assert.equal(result.code, step.expect.code, `${scenario.name}: ${JSON.stringify(step.op)}`);
        if (step.capture) captures.set(step.capture, response.cursor as string);
      }

      const final = scenario.expectFinal;
      if (final?.like) {
        const row = await t.db.read((q) =>
          q
            .selectFrom("sync_likes")
            .select(["video_id", "liked", "liked_at"])
            .where("user_id", "=", account.user.id)
            .where("video_id", "=", final.like!.videoId)
            .executeTakeFirstOrThrow(),
        );
        assert.deepEqual(
          { videoId: row.video_id, liked: fromDbBool(row.liked), likedAt: formatIsoOrNull(row.liked_at) },
          final.like,
        );
      }
      if (final?.bookmark) {
        const row = await t.db.read((q) =>
          q
            .selectFrom("sync_bookmarks")
            .select(["type", "browse_id", "bookmarked", "bookmarked_at", "title", "subtitle", "thumbnail_url", "year"])
            .where("user_id", "=", account.user.id)
            .where("type", "=", final.bookmark!.type)
            .where("browse_id", "=", final.bookmark!.browseId)
            .executeTakeFirstOrThrow(),
        );
        const actual: Record<string, unknown> = {
          type: row.type,
          browseId: row.browse_id,
          bookmarked: fromDbBool(row.bookmarked),
          bookmarkedAt: formatIsoOrNull(row.bookmarked_at),
          title: row.title,
          subtitle: row.subtitle,
          thumbnailUrl: row.thumbnail_url,
          year: row.year,
        };
        for (const [key, expected] of Object.entries(final.bookmark)) {
          assert.deepEqual(actual[key], expected, `${scenario.name}: field "${key}"`);
        }
      }
    });
  }
});
