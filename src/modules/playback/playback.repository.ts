/**
 * `playback_state` (API §9.2 `0004_playback`, docs/database.md): one row per user, no `lockUser` — concurrent writes
 * are resolved by CAS on `rev` (docs/database.md §2.6), exactly like `refresh_tokens`.
 */
import { z } from "zod";
import { TrackDto } from "../../contract/common.ts";
import { fromDbBool, jsonCodec, toDbBool } from "../../db/codecs.ts";
import type { Queryable } from "../../db/index.ts";
import type { NewPlaybackRow, StoredPlayback } from "./playback.rules.ts";

const queueCodec = jsonCodec(z.array(TrackDto), "playback_state.queue");

function fromRow(row: {
  rev: number;
  cleared: 0 | 1;
  device_id: string;
  device_name: string | null;
  session_id: string;
  queue_version: number;
  queue: string;
  idx: number;
  position_ms: number;
  duration_ms: number | null;
  playing: 0 | 1;
  state_at: number;
  updated_at: number;
  handoff_device_id: string | null;
  handoff_session_id: string | null;
  handoff_at: number | null;
}): StoredPlayback {
  return Object.freeze({
    rev: row.rev,
    cleared: fromDbBool(row.cleared),
    deviceId: row.device_id,
    deviceName: row.device_name,
    sessionId: row.session_id,
    queueVersion: row.queue_version,
    queue: queueCodec.decode(row.queue),
    index: row.idx,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    playing: fromDbBool(row.playing),
    stateAt: row.state_at,
    updatedAt: row.updated_at,
    handoffDeviceId: row.handoff_device_id,
    handoffSessionId: row.handoff_session_id,
    handoffAt: row.handoff_at,
  });
}

/** The current row of the user, decoded; `null` when there is none yet (never created a state). */
export async function readPlaybackState(q: Queryable, userId: string): Promise<StoredPlayback | null> {
  const row = await q.selectFrom("playback_state").selectAll().where("user_id", "=", userId).executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** `customName ?? reportedName` of a device (API §4.1 `DeviceDto.name`), or `null` if the device row is gone. */
export async function deviceDisplayName(q: Queryable, deviceId: string): Promise<string | null> {
  const row = await q
    .selectFrom("devices")
    .select(["custom_name", "reported_name"])
    .where("id", "=", deviceId)
    .executeTakeFirst();
  if (!row) return null;
  return row.custom_name ?? row.reported_name;
}

function updateValues(row: NewPlaybackRow, cleared: boolean) {
  return {
    rev: row.rev,
    cleared: toDbBool(cleared),
    device_id: row.deviceId,
    device_name: row.deviceName,
    session_id: row.sessionId,
    queue_version: row.queueVersion,
    queue: queueCodec.encode([...row.queue]),
    idx: row.index,
    position_ms: row.positionMs,
    duration_ms: row.durationMs,
    playing: toDbBool(row.playing),
    state_at: row.stateAt,
    updated_at: row.updatedAt,
    handoff_device_id: row.handoffDeviceId,
    handoff_session_id: row.handoffSessionId,
    handoff_at: row.handoffAt,
  };
}

/**
 * CAS write of an existing row (docs/database.md §2.6): `UPDATE … WHERE user_id = ? AND rev = ?`.
 * @param expectedRev the `rev` last read (the attempt's optimistic lock).
 * @returns whether this attempt won the race (`numUpdatedRows === 1`).
 */
export async function casUpdatePlaybackState(
  q: Queryable,
  userId: string,
  expectedRev: number,
  row: NewPlaybackRow,
  cleared: boolean,
): Promise<boolean> {
  const result = await q
    .updateTable("playback_state")
    .set(updateValues(row, cleared))
    .where("user_id", "=", userId)
    .where("rev", "=", expectedRev)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * CAS creation of the first row of a user: `INSERT … ON CONFLICT (user_id) DO NOTHING RETURNING` (docs/database.md
 * §3, no constraint is ever caught inside the transaction).
 * @returns whether this attempt created the row (`false`: a concurrent attempt won the race).
 */
export async function casInsertPlaybackState(
  q: Queryable,
  userId: string,
  row: NewPlaybackRow,
  cleared: boolean,
): Promise<boolean> {
  const inserted = await q
    .insertInto("playback_state")
    .values({ user_id: userId, ...updateValues(row, cleared) })
    .onConflict((conflict) => conflict.column("user_id").doNothing())
    .returning("user_id")
    .executeTakeFirst();
  return inserted !== undefined;
}

/**
 * One retention batch (DESIGN §3.12.3 "Строки старше 30 дней удаляет retention", docs/database.md §4.4): deletes at
 * most `limit` rows whose `updated_at` is older than `cutoffMs`, portably (`playback_state_updated` index).
 * @returns the number of rows deleted (< `limit` tells {@link import("../../db/batch.ts").deleteInBatches} to stop).
 */
export async function deletePlaybackStateOlderThan(q: Queryable, cutoffMs: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("playback_state")
    .where((eb) =>
      eb(
        "user_id",
        "in",
        eb.selectFrom("playback_state").select("user_id").where("updated_at", "<", cutoffMs).limit(limit),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
