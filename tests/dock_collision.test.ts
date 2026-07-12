import { afterEach, describe, expect, it } from 'vitest';
import { isBlocked, resolveMovement, resolvePosition } from '../src/sim/colliders';
import { BUILTIN_WORLD, PROPS, setActiveWorldContent } from '../src/sim/data';
import type { WorldContent } from '../src/sim/types';

// Issue #1500: the Deepfen Shallows fishing dock had no collision on its deck.
// buildProps (src/render/props.ts) renders three `dockPlatform` deck sections
// the player sees, but colliders.ts only built a collider for the stone hut, so
// the wooden deck was walk-through unlike every other structure. These pin the
// deck now blocking, at the sim collision layer that all three hosts share.

const SEED = 4242;

function world(extra: Partial<WorldContent>): WorldContent {
  // A fresh object per test: the collider grid cache is keyed per content.
  return { ...BUILTIN_WORLD, ...extra };
}

afterEach(() => {
  setActiveWorldContent(null);
});

describe('fishing dock deck collision', () => {
  const d = PROPS.docks.find((dock) => Math.round(dock.x) === -66 && Math.round(dock.z) === 305);
  if (!d) throw new Error('Deepfen Shallows dock missing from the built-in world');

  // Deck union center in the dock's local frame: buildProps steps three sections
  // out along local -z, union z from -6.38 to 0.02 (see world_audio.ts DOCK_*).
  // Local (0, lz) rotates to world (x + lz*sin, z + lz*cos) (colliders' rotY).
  const deckLz = (-6.38 + 0.02) / 2;
  const cx = d.x + deckLz * Math.sin(d.rot);
  const cz = d.z + deckLz * Math.cos(d.rot);

  it('blocks a mover standing on the deck (was walk-through before the fix)', () => {
    // The deterministic decoration field is identical in both worlds, so a
    // stray rock at the same spot would trip the dock-removed control below
    // rather than masking the deck collider.
    setActiveWorldContent(world({ props: { ...BUILTIN_WORLD.props, docks: [] } }));
    expect(isBlocked(SEED, cx, cz, 0.5)).toBe(false);

    setActiveWorldContent(world({}));
    expect(isBlocked(SEED, cx, cz, 0.5)).toBe(true);
  });

  it('pushes the mover out of the deck instead of leaving it inside', () => {
    setActiveWorldContent(world({}));
    const res = resolvePosition(SEED, cx, cz, 0.5);
    expect(Math.hypot(res.x - cx, res.z - cz)).toBeGreaterThan(0.5);
  });

  it('a walk straight across the deck is stopped, not passed through', () => {
    setActiveWorldContent(world({}));
    // Approach perpendicular to the deck's long axis, through its center:
    // local +x maps to world (cos rot, -sin rot).
    const nx = Math.cos(d.rot);
    const nz = -Math.sin(d.rot);
    const fromX = cx - nx * 3;
    const fromZ = cz - nz * 3;
    const toX = cx + nx * 3;
    const toZ = cz + nz * 3;
    const res = resolveMovement(SEED, fromX, fromZ, toX, toZ, 0.5);
    // Never reaches the far side: the deck stops it well short.
    expect(Math.hypot(res.x - toX, res.z - toZ)).toBeGreaterThan(1);
  });

  it('does not block open shore off to the side of the deck', () => {
    setActiveWorldContent(world({}));
    // 5yd along the deck's local +x, clear of both deck and stone hut.
    const nx = Math.cos(d.rot);
    const nz = -Math.sin(d.rot);
    expect(isBlocked(SEED, cx + nx * 5, cz + nz * 5, 0.5)).toBe(false);
  });
});
