/**
 * `cleanTrackInput` (DESIGN §3.9): lenient parsing of one `PlaybackPut.queue` item. `videoId` is trusted (the
 * contract's `TrackInput.videoId` already validated it); everything else arrives as `unknown`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TrackInput } from "../../contract/common.ts";
import { STRING_LIMITS } from "../../contract/limits.ts";
import { cleanTrackInput } from "./playback.tracks.ts";

const VIDEO_ID = "dQw4w9WgXcQ";

function input(fields: Partial<TrackInput> = {}): TrackInput {
  return { videoId: VIDEO_ID, ...fields };
}

describe("cleanTrackInput", () => {
  test("full valid metadata passes through unchanged", () => {
    const track = cleanTrackInput(
      input({
        title: "Never Gonna Give You Up",
        artistsText: "Rick Astley",
        artists: [{ id: "UCuAXFkgsw1L7xaCfnd5JJOw", name: "Rick Astley" }],
        albumId: "UCuAXFkgsw1L7xaCfnd5JJOw",
        albumTitle: "Whenever You Need Somebody",
        durationMs: 213_000,
        durationText: "3:33",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        explicit: true,
        videoType: "song",
      }),
    );
    assert.deepEqual(track, {
      videoId: VIDEO_ID,
      title: "Never Gonna Give You Up",
      artistsText: "Rick Astley",
      artists: [{ id: "UCuAXFkgsw1L7xaCfnd5JJOw", name: "Rick Astley" }],
      albumId: "UCuAXFkgsw1L7xaCfnd5JJOw",
      albumTitle: "Whenever You Need Somebody",
      durationMs: 213_000,
      durationText: "3:33",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      explicit: true,
      videoType: "song",
      metadataStub: false,
    });
  });

  test("no metadata at all becomes the canonical stub (API §4.1 example)", () => {
    assert.deepEqual(cleanTrackInput(input()), {
      videoId: VIDEO_ID,
      title: VIDEO_ID,
      artistsText: null,
      artists: [],
      albumId: null,
      albumTitle: null,
      durationMs: null,
      durationText: null,
      thumbnailUrl: null,
      explicit: false,
      videoType: null,
      metadataStub: true,
    });
  });

  test("an empty title is a stub even when other fields look valid", () => {
    const track = cleanTrackInput(input({ title: "", artistsText: "Rick Astley", durationMs: 1000 }));
    assert.equal(track.metadataStub, true);
    assert.equal(track.title, VIDEO_ID);
    assert.equal(track.artistsText, null);
    assert.equal(track.durationMs, null);
  });

  test("a title that is not a string is a stub, not a thrown error", () => {
    const track = cleanTrackInput(input({ title: 42 as unknown as string }));
    assert.equal(track.metadataStub, true);
    assert.equal(track.title, VIDEO_ID);
  });

  test("title is truncated to the limit without splitting a surrogate pair", () => {
    const surrogatePair = "😀"; // U+1F600, one code point, two UTF-16 units
    const title = "x".repeat(STRING_LIMITS.title - 1) + surrogatePair;
    const track = cleanTrackInput(input({ title }));
    assert.equal(track.title.length, STRING_LIMITS.title - 1);
    assert.ok(!track.title.endsWith("\ud83d"), "must not end on a lone high surrogate");
  });

  test("wrong types become null (or their safe default) instead of failing the request", () => {
    const track = cleanTrackInput(
      input({
        title: "Real title",
        artistsText: 123,
        albumId: "not a browse id!!",
        durationMs: "213000",
        thumbnailUrl: "ftp://example.com/thumb.jpg",
        explicit: "yes",
        videoType: "Song" /* uppercase: not in the pattern */,
      }),
    );
    assert.equal(track.artistsText, null);
    assert.equal(track.albumId, null);
    assert.equal(track.durationMs, null);
    assert.equal(track.thumbnailUrl, null);
    assert.equal(track.explicit, false);
    assert.equal(track.videoType, null);
  });

  test("a negative or fractional durationMs is invalid", () => {
    assert.equal(cleanTrackInput(input({ title: "t", durationMs: -1 })).durationMs, null);
    assert.equal(cleanTrackInput(input({ title: "t", durationMs: 1.5 })).durationMs, null);
  });

  test("artists[]: invalid items are dropped, the array itself never becomes null", () => {
    const track = cleanTrackInput(
      input({
        title: "t",
        artists: [
          { id: "UCabc", name: "Good" },
          { id: "not a browse id", name: "Bad id becomes null, item kept" },
          { id: null, name: "" }, // empty name → dropped
          "not an object",
          { name: "No id field" },
        ],
      }),
    );
    assert.deepEqual(track.artists, [
      { id: "UCabc", name: "Good" },
      { id: null, name: "Bad id becomes null, item kept" },
      { id: null, name: "No id field" },
    ]);
  });

  test("a non-array artists field becomes an empty array", () => {
    assert.deepEqual(cleanTrackInput(input({ title: "t", artists: "nope" as unknown as [] })).artists, []);
  });

  test("artists[] is capped at the trackArtists limit", () => {
    const many = Array.from({ length: STRING_LIMITS.trackArtists + 10 }, (_, i) => ({ id: null, name: `A${i}` }));
    const track = cleanTrackInput(input({ title: "t", artists: many }));
    assert.equal(track.artists.length, STRING_LIMITS.trackArtists);
  });

  test("a thumbnailUrl over the length limit is invalid rather than truncated", () => {
    const longUrl = `https://example.com/${"a".repeat(STRING_LIMITS.url)}`;
    assert.equal(cleanTrackInput(input({ title: "t", thumbnailUrl: longUrl })).thumbnailUrl, null);
  });
});
