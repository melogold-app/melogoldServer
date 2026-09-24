"""End-to-end check of a live Melogold server (Python 3 standard library only): two devices of one account, SSE,
library/playlists/history sync, playback handoff, revocation, and the test account deleted at the end.

    python3 scripts/live-check.py https://music.example.com

Needs open registration (or `first` on an empty server). On macOS with the python.org build, point it at the system
certificates: SSL_CERT_FILE=/etc/ssl/cert.pem python3 scripts/live-check.py …"""
import hashlib
import json
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

BASE = sys.argv[1].rstrip("/")
LOGIN = "e2e" + secrets.token_hex(4)
PASSWORD = "проверка связи " + secrets.token_hex(4)
VIDEO_A, VIDEO_B, VIDEO_C = "dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0"
passed = []


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def call(method, path, body=None, token=None, sync=False, expect=None):
    headers = {"accept": "application/json", "user-agent": "melogold-e2e/1"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    if sync:
        headers["x-sync-protocol"] = "1"
    request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    payload = json.loads(raw) if raw else None
    if expect is not None and status != expect:
        raise AssertionError(f"{method} {path}: expected {expect}, got {status}: {payload}")
    return status, payload


def check(name, condition, detail=""):
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    passed.append(name)
    print("  ✓", name)


def device(name, platform):
    return {"hwid": secrets.token_hex(32), "name": name, "platform": platform, "clientVersion": "e2e"}


def solve_pow(challenge, bits):
    nonce = 0
    while True:
        digest = hashlib.sha256(f"{challenge}:{nonce}".encode()).digest()
        value = int.from_bytes(digest, "big")
        if value >> (256 - bits) == 0 if bits else True:
            return str(nonce)
        nonce += 1


class Events(threading.Thread):
    """Reads the SSE stream of one device into a list."""

    def __init__(self, token):
        super().__init__(daemon=True)
        self.token, self.events, self.closed = token, [], False

    def run(self):
        request = urllib.request.Request(
            BASE + "/auth/me/events",
            headers={"authorization": f"Bearer {self.token}", "accept": "text/event-stream"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                for raw in response:
                    line = raw.decode().rstrip("\n")
                    if line.startswith("data: "):
                        self.events.append(json.loads(line[6:]))
        except Exception:
            pass
        self.closed = True

    def wait_for(self, kind, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for event in self.events:
                if event["type"] == kind:
                    return event
            time.sleep(0.2)
        raise AssertionError(f"no {kind} event; got {[e['type'] for e in self.events]}")


print(f"Server {BASE}")
_, info = call("GET", "/server/info", expect=200)
check("server info: sync with 14 op kinds, playback, linking", len(info["features"]["sync"]["kinds"]) == 14
      and "playback" in info["features"] and info["secureTransport"] is True)

# Registration (with proof of work when the server asks for it)
_, challenge = call("GET", "/auth/register/challenge", expect=200)
register = {"login": LOGIN, "password": PASSWORD, "device": device("E2E Pixel", "android")}
if challenge["bits"] > 0:
    register["pow"] = {"challenge": challenge["challenge"], "nonce": solve_pow(challenge["challenge"], challenge["bits"])}
status, session_a = call("POST", "/auth/register", register)
check("register device A", status == 201 and session_a["recoveryCode"], f"{status} {session_a}")
token_a = session_a["tokens"]["accessToken"]

# Second device of the same account
status, session_b = call("POST", "/auth/login", {"login": LOGIN, "password": PASSWORD,
                                                 "device": device("E2E Laptop", "linux")})
check("login device B", status == 200, f"{status} {session_b}")
token_b = session_b["tokens"]["accessToken"]

events_a, events_b = Events(token_a), Events(token_b)
events_a.start()
events_b.start()
events_b.wait_for("system.connected")
events_a.wait_for("system.connected")
check("SSE open on both devices", True)

_, devices = call("GET", "/auth/me/devices", token=token_a, expect=200)
check("device list shows both", len(devices["devices"]) == 2, devices)

# Library: A likes a track; B hears sync.changed and pulls it
_, first = call("POST", "/sync", {"cursor": ""}, token=token_a, sync=True, expect=200)
cursor_a = first["cursor"]
like = {"opId": str(uuid.uuid4()), "kind": "like.set", "at": now_iso(), "videoId": VIDEO_A, "liked": True,
        "tracks": [{"videoId": VIDEO_A, "title": "Never Gonna Give You Up", "artistsText": "Rick Astley",
                    "durationMs": 213000, "videoType": "atv"}]}
_, pushed = call("POST", "/sync", {"cursor": cursor_a, "ops": [like]}, token=token_a, sync=True, expect=200)
check("A: like.set applied", pushed["results"][0]["status"] == "applied", pushed["results"])
cursor_a = pushed["cursor"]
events_b.wait_for("sync.changed")
_, pulled = call("POST", "/sync", {"cursor": ""}, token=token_b, sync=True, expect=200)
check("B: sync.changed, then the like and the track come down",
      any(l["videoId"] == VIDEO_A and l["liked"] for l in pulled["likes"])
      and any(t["videoId"] == VIDEO_A and t["title"] == "Never Gonna Give You Up" for t in pulled["tracks"]))
cursor_b = pulled["cursor"]

# Playlists: B creates one with two tracks; A pulls it
playlist_id = str(uuid.uuid4())
create = {"opId": str(uuid.uuid4()), "kind": "playlist.create", "at": now_iso(), "playlistId": playlist_id,
          "name": "Проверка связи", "videoIds": [VIDEO_B, VIDEO_C],
          "tracks": [{"videoId": VIDEO_B, "title": "Despacito"}, {"videoId": VIDEO_C, "title": "Gangnam Style"}]}
_, pushed = call("POST", "/sync", {"cursor": cursor_b, "ops": [create]}, token=token_b, sync=True, expect=200)
check("B: playlist.create applied", pushed["results"][0]["status"] == "applied", pushed["results"])
cursor_b = pushed["cursor"]
events_a.wait_for("sync.changed")
_, pulled = call("POST", "/sync", {"cursor": cursor_a}, token=token_a, sync=True, expect=200)
items = [i for i in pulled["items"] if i["playlistId"] == playlist_id and i["present"]]
check("A: the playlist and its two tracks in order",
      any(p["id"] == playlist_id and p["name"] == "Проверка связи" for p in pulled["playlists"])
      and [i["videoId"] for i in sorted(items, key=lambda i: i["sortKey"])] == [VIDEO_B, VIDEO_C], pulled)
cursor_a = pulled["cursor"]

# History: A plays a track; B sees the play
played = {"opId": str(uuid.uuid4()), "kind": "play.add", "at": now_iso(), "videoId": VIDEO_A,
          "playedAt": now_iso(), "playTimeMs": 200000, "history": True, "playtime": True}
_, pushed = call("POST", "/sync", {"cursor": cursor_a, "ops": [played]}, token=token_a, sync=True, expect=200)
check("A: play.add applied", pushed["results"][0]["status"] == "applied", pushed["results"])
_, replay = call("POST", "/sync", {"cursor": pushed["cursor"], "ops": [played]}, token=token_a, sync=True, expect=200)
check("A: the same play again is a replay", replay["results"][0]["replayed"] is True, replay["results"])
time.sleep(2.5)
_, pulled = call("POST", "/sync", {"cursor": cursor_b}, token=token_b, sync=True, expect=200)
check("B: the play and the listening time come down",
      any(p["videoId"] == VIDEO_A for p in pulled["plays"])
      and any(s["videoId"] == VIDEO_A and s["totalPlayTimeMs"] >= 200000 for s in pulled["playStats"]), pulled)

# Playback: A plays; B sees it and takes it over ("listen here"); A's next update loses
session_a_id, session_b_id = str(uuid.uuid4()), str(uuid.uuid4())
put_a = {"sessionId": session_a_id, "queueVersion": 1, "at": now_iso(), "index": 0, "positionMs": 42000,
         "durationMs": 213000, "playing": True,
         "queue": [{"videoId": VIDEO_A, "title": "Never Gonna Give You Up", "artistsText": "Rick Astley"}]}
_, result = call("PUT", "/playback/state", put_a, token=token_a, sync=True, expect=200)
check("A: playback state applied", result["applied"] is True, result)
events_b.wait_for("playback.updated")
_, state = call("GET", "/playback/state", token=token_b, sync=True, expect=200)
check("B: sees what A plays", state["state"] and state["state"]["queue"][0]["videoId"] == VIDEO_A
      and state["state"]["positionMs"] == 42000, state)
device_a_id = session_a["device"]["id"]
put_b = {"sessionId": session_b_id, "queueVersion": 1, "at": now_iso(), "index": 0, "positionMs": 45000,
         "durationMs": 213000, "playing": True, "queue": put_a["queue"],
         "handoffFrom": {"deviceId": device_a_id, "sessionId": session_a_id}}
_, result = call("PUT", "/playback/state", put_b, token=token_b, sync=True, expect=200)
check("B: 'listen here' takes playback over", result["applied"] is True, result)
put_a["at"], put_a["positionMs"] = now_iso(), 50000
_, result = call("PUT", "/playback/state", put_a, token=token_a, sync=True, expect=200)
check("A: its next update is refused as handed_off", result["applied"] is False and result["reason"] == "handed_off",
      result)

# Revocation: A signs B out; B's stream gets session.invalidated and its token stops working
device_b_id = session_b["device"]["id"]
status, body = call("POST", f"/auth/me/devices/{device_b_id}/revoke", {"password": PASSWORD}, token=token_a)
check("A revokes B", status == 204, f"{status} {body}")
invalidated = events_b.wait_for("session.invalidated")
check("B: session.invalidated{device_revoked}", invalidated["payload"]["reason"] == "device_revoked", invalidated)
status, body = call("GET", "/auth/me", token=token_b)
check("B: the old token is refused (session_revoked)", status == 401 and body["code"] == "session_revoked", body)

# Clean up: the test account goes
status, body = call("POST", "/auth/me/delete", {"password": PASSWORD}, token=token_a)
check("test account deleted", status in (200, 204), f"{status} {body}")

print(f"\nAll {len(passed)} checks passed ({LOGIN}).")
