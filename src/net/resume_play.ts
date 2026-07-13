// Active-play resume marker.
//
// On mobile (notably iOS), the OS evicts a backgrounded WebView under memory
// pressure; when the player foregrounds the app it RELOADS index.html. The
// client is a single-page app whose boot path lands a restored session on the
// home / character-select chrome, never back in the world, so the player is
// silently dropped out of the game and (if the token also fails revalidation)
// all the way to the login screen. Reported as "it randomly returns me to the
// login screen".
//
// This module persists "actively in-world playing character N" so the boot path
// can re-enter the world instead of the home screen. It is FRESHNESS-SCOPED: the
// marker is only honored for a bounded window after it was last stamped, so a
// cold open of a long-closed tab still lands on home as before, and only a
// genuine reload-during-play resumes. The window comfortably covers a
// background/eviction round trip; a session that re-enters within the server's
// linkdead grace resumes seamlessly, and past it a fresh join is still correct.
//
// This is client-only (src/net), so wall-clock time is allowed: the pure helpers
// take `now` as a parameter (unit-testable), and the thin storage wrappers read
// the clock and localStorage at the impure boundary, matching the Api
// saveSession/clearSession idiom.

export const RESUME_KEY = 'woc_active_play';

// Honor the marker only if it was stamped within this window. Re-stamped while
// the app is being backgrounded (the pre-eviction moment), so even a long play
// session resumes; a marker older than this falls through to the normal home
// landing.
export const RESUME_MAX_AGE_MS = 30 * 60 * 1000;

export interface PlayMarker {
  characterId: number;
  savedAt: number;
}

export function serializeMarker(marker: PlayMarker): string {
  return JSON.stringify(marker);
}

// Parse a stored marker, rejecting anything malformed (a positive integer
// characterId and a finite savedAt are required).
export function parseMarker(raw: string | null): PlayMarker | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { characterId?: unknown; savedAt?: unknown };
    const characterId = v.characterId;
    const savedAt = v.savedAt;
    if (typeof characterId !== 'number' || !Number.isInteger(characterId) || characterId <= 0) {
      return null;
    }
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
    return { characterId, savedAt };
  } catch {
    return null;
  }
}

// The pure resume decision: given a parsed marker and the current time, return
// the character id to resume, or null when there is no marker or it is stale.
// The negative-age guard covers a backwards clock change (never resume on a
// marker that claims to be from the future).
export function freshMarkerCharacterId(
  marker: PlayMarker | null,
  now: number,
  maxAgeMs = RESUME_MAX_AGE_MS,
): number | null {
  if (!marker) return null;
  const age = now - marker.savedAt;
  if (age < 0 || age > maxAgeMs) return null;
  return marker.characterId;
}

// localStorage is unavailable in private mode / SSR / some WebViews; every
// wrapper fails soft so a storage error can never break boot or play.
function readRaw(): string | null {
  try {
    return localStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

function writeRaw(marker: PlayMarker): void {
  try {
    localStorage.setItem(RESUME_KEY, serializeMarker(marker));
  } catch {
    // ignore: resume is a best-effort convenience, never load-bearing
  }
}

export function readPlayMarker(): PlayMarker | null {
  return parseMarker(readRaw());
}

// Stamp the marker for the character just entered (or refresh its timestamp).
export function savePlayMarker(characterId: number, now: number): void {
  writeRaw({ characterId, savedAt: now });
}

// Re-stamp the existing marker's savedAt without changing the character, so a
// long play session stays inside the resume window right up to the moment the
// app is backgrounded. No-op when no marker is stored.
export function refreshPlayMarker(now: number): void {
  const existing = readPlayMarker();
  if (!existing) return;
  writeRaw({ characterId: existing.characterId, savedAt: now });
}

export function clearPlayMarker(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // ignore
  }
}
