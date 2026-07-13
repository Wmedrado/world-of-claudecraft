import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPlayMarker,
  freshMarkerCharacterId,
  parseMarker,
  RESUME_KEY,
  RESUME_MAX_AGE_MS,
  readPlayMarker,
  refreshPlayMarker,
  savePlayMarker,
  serializeMarker,
} from '../src/net/resume_play';

// minimal localStorage stub (the test env is plain node, no DOM)
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

beforeEach(() => installStorage());

describe('parseMarker', () => {
  it('round-trips a valid marker', () => {
    const m = { characterId: 42, savedAt: 1_000_000 };
    expect(parseMarker(serializeMarker(m))).toEqual(m);
  });

  it('rejects null / empty / malformed json', () => {
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker('')).toBeNull();
    expect(parseMarker('{not json')).toBeNull();
  });

  it('rejects a non-positive or non-integer characterId', () => {
    expect(parseMarker(JSON.stringify({ characterId: 0, savedAt: 1 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ characterId: -3, savedAt: 1 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ characterId: 4.5, savedAt: 1 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ characterId: '7', savedAt: 1 }))).toBeNull();
  });

  it('rejects a missing or non-finite savedAt', () => {
    expect(parseMarker(JSON.stringify({ characterId: 7 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ characterId: 7, savedAt: 'x' }))).toBeNull();
    // JSON cannot carry Infinity, but a hand-built object shape must still reject it.
    expect(parseMarker('{"characterId":7,"savedAt":null}')).toBeNull();
  });
});

describe('freshMarkerCharacterId', () => {
  const now = 10_000_000;

  it('returns the id for a marker inside the freshness window', () => {
    expect(freshMarkerCharacterId({ characterId: 9, savedAt: now - 1000 }, now)).toBe(9);
    // exactly at the boundary is still honored
    expect(freshMarkerCharacterId({ characterId: 9, savedAt: now - RESUME_MAX_AGE_MS }, now)).toBe(
      9,
    );
  });

  it('returns null for a stale marker (older than the window)', () => {
    expect(
      freshMarkerCharacterId({ characterId: 9, savedAt: now - RESUME_MAX_AGE_MS - 1 }, now),
    ).toBeNull();
  });

  it('returns null for a null marker', () => {
    expect(freshMarkerCharacterId(null, now)).toBeNull();
  });

  it('returns null on a backwards clock (marker from the future)', () => {
    expect(freshMarkerCharacterId({ characterId: 9, savedAt: now + 5000 }, now)).toBeNull();
  });
});

describe('storage wrappers', () => {
  it('save then read a marker at the given time', () => {
    savePlayMarker(123, 555);
    expect(readPlayMarker()).toEqual({ characterId: 123, savedAt: 555 });
    expect(localStorage.getItem(RESUME_KEY)).not.toBeNull();
  });

  it('refresh re-stamps savedAt but keeps the character', () => {
    savePlayMarker(123, 555);
    refreshPlayMarker(9_999);
    expect(readPlayMarker()).toEqual({ characterId: 123, savedAt: 9_999 });
  });

  it('refresh is a no-op when no marker is stored', () => {
    refreshPlayMarker(9_999);
    expect(readPlayMarker()).toBeNull();
  });

  it('clear removes the marker', () => {
    savePlayMarker(123, 555);
    clearPlayMarker();
    expect(readPlayMarker()).toBeNull();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it('a stale saved marker is rejected by the freshness gate end-to-end', () => {
    savePlayMarker(77, 0);
    // A read gives the marker back verbatim, but the fresh gate rejects it.
    expect(readPlayMarker()).toEqual({ characterId: 77, savedAt: 0 });
    expect(freshMarkerCharacterId(readPlayMarker(), RESUME_MAX_AGE_MS + 1)).toBeNull();
  });

  it('fails soft when localStorage throws (private mode / SSR)', () => {
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    // None of these may throw.
    expect(() => savePlayMarker(1, 1)).not.toThrow();
    expect(readPlayMarker()).toBeNull();
    expect(() => refreshPlayMarker(1)).not.toThrow();
    expect(() => clearPlayMarker()).not.toThrow();
  });
});
