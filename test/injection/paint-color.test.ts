import { describe, expect, test } from "bun:test";
import { decodePaintColor, PAINT_DEPTH_CAP } from "../../src/injection/paint-color.ts";

// Unit tests for the pure `paint_color` decoder. Strings are hand-constructed
// from the BambuStudio bit format (ported in paint-color.ts), NOT from our own
// encoder, so they independently pin the layout:
//   • hex string is consumed in REVERSED order, each hex digit = one nibble;
//   • node nibble `code`: split = code & 0b11, special = code >> 2;
//   • leaf state = code>>2 (0..2), or (code==0xC) marker + extension nibbles;
//   • split children serialized/decoded high-index → low-index.

type Vec3 = [number, number, number];
const P0: Vec3 = [0, 0, 0];
const P1: Vec3 = [2, 0, 0];
const P2: Vec3 = [0, 2, 0];

/** Collect all emitted sub-triangles for a paint string. */
function collect(paint: string, base = 5, depthCap = PAINT_DEPTH_CAP) {
  const tris: { positions: number[]; extruder: number }[] = [];
  const stats = decodePaintColor(P0, P1, P2, paint, base, (positions, extruder) => tris.push({ positions, extruder }), depthCap);
  return { tris, stats };
}

describe("decodePaintColor — leaf states", () => {
  test('whole-triangle leaf state 1 ("4")', () => {
    const { tris, stats } = collect("4");
    expect(stats.ok).toBe(true);
    expect(stats.consumedAll).toBe(true);
    expect(stats.leaves).toBe(1);
    expect(tris.length).toBe(1);
    expect(tris[0]!.extruder).toBe(1); // state 1 → filament 1
    expect(tris[0]!.positions).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]); // P0,P1,P2 untouched
    expect(stats.maxState).toBe(1);
  });

  test('whole-triangle leaf state 2 ("8")', () => {
    const { tris, stats } = collect("8");
    expect(stats.ok).toBe(true);
    expect(tris.length).toBe(1);
    expect(tris[0]!.extruder).toBe(2);
  });

  test('state 0 resolves to the object base extruder ("0" is not stored, but the marker path is)', () => {
    // A bare "0" nibble = split 0, code>>2 = 0 → state 0 → base extruder.
    const { tris, stats } = collect("0", 6);
    expect(stats.ok).toBe(true);
    expect(tris[0]!.extruder).toBe(6); // base
  });

  test('leaf state 3 via the 0b11 marker + one extension nibble ("0C")', () => {
    // n=3: first nibble 0b1100 (=0xC), then final nibble 0 → state = 0 + 15*0 + 3.
    const { tris, stats } = collect("0C");
    expect(stats.ok).toBe(true);
    expect(stats.consumedAll).toBe(true);
    expect(tris.length).toBe(1);
    expect(tris[0]!.extruder).toBe(3);
    expect(stats.maxState).toBe(3);
  });

  test('leaf state 18 via marker + one 0xF extension block ("0FC")', () => {
    // n=18: 0xC marker, one 0xF block (num=1), final nibble 0 → 0 + 15*1 + 3.
    const { tris, stats } = collect("0FC");
    expect(stats.ok).toBe(true);
    expect(stats.consumedAll).toBe(true);
    expect(tris[0]!.extruder).toBe(18);
    expect(stats.maxState).toBe(18);
  });
});

describe("decodePaintColor — splits", () => {
  test('one-level 1-split, two leaves in reverse order ("481")', () => {
    // root nibble 1 (split=1, special=0); children high→low: child1=state2 (8),
    // child0=state1 (4). Consumption [1,8,4] ⇒ reversed string "481".
    const { tris, stats } = collect("481");
    expect(stats.ok).toBe(true);
    expect(stats.consumedAll).toBe(true);
    expect(stats.leaves).toBe(2);
    expect(tris.length).toBe(2);
    // emit order = decode order = child1 (state2) then child0 (state1)
    expect(tris.map((t) => t.extruder)).toEqual([2, 1]);
    // geometry: special=0 ⇒ L=(P0,P1,P2); m21 = mid(P2,P1) = (1,1,0).
    // child1 = [m21,P2,P0], child0 = [P0,P1,m21].
    expect(tris[0]!.positions).toEqual([1, 1, 0, 0, 2, 0, 0, 0, 0]);
    expect(tris[1]!.positions).toEqual([0, 0, 0, 2, 0, 0, 1, 1, 0]);
  });

  test('one-level 3-split, four leaves ("84843")', () => {
    // root nibble 3 (split=3); children high→low states [1,2,1,2] (4,8,4,8).
    const { tris, stats } = collect("84843");
    expect(stats.ok).toBe(true);
    expect(stats.consumedAll).toBe(true);
    expect(stats.leaves).toBe(4);
    expect(tris.length).toBe(4);
    expect(tris.map((t) => t.extruder)).toEqual([1, 2, 1, 2]);
    // 3-split midpoints: m10=mid(P1,P0)=(1,0,0), m21=mid(P2,P1)=(1,1,0), m02=mid(P0,P2)=(0,1,0)
    // child3 = [m10,m21,m02] emitted first.
    expect(tris[0]!.positions).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 0]);
  });
});

describe("decodePaintColor — robustness", () => {
  test("depth cap collapses a split to one triangle but still consumes the whole string", () => {
    // Same "481" but cap at depth 0 ⇒ do not subdivide geometry; emit ONE
    // triangle coloured by the first (DFS) leaf state (2), bits fully consumed.
    const { tris, stats } = collect("481", 5, 0);
    expect(stats.ok).toBe(true);
    expect(stats.consumedAll).toBe(true);
    expect(stats.leaves).toBe(2); // still parsed both leaves
    expect(stats.emitted).toBe(1); // but emitted only one (capped)
    expect(tris.length).toBe(1);
    expect(tris[0]!.extruder).toBe(2); // dominant / first leaf state
    expect(tris[0]!.positions).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]); // whole triangle
  });

  test("a short/truncated string overruns and is reported (not ok)", () => {
    // "1" alone: root says split=1 (needs 2 children) but the stream ends.
    const { stats } = collect("1");
    expect(stats.overran).toBe(true);
    expect(stats.ok).toBe(false);
  });

  test("dangling nibbles (extra unconsumed data) is reported (not ok)", () => {
    // "44": a leaf ("4") fully decodes at nibble 0, leaving a trailing nibble.
    const { stats } = collect("44");
    expect(stats.overran).toBe(false);
    expect(stats.consumedAll).toBe(false);
    expect(stats.ok).toBe(false);
  });

  test("empty / non-hex string yields nothing, never throws", () => {
    expect(collect("").tris.length).toBe(0);
    expect(collect("zz").tris.length).toBe(0);
    expect(collect("").stats.ok).toBe(false);
  });

  test("default depth cap is a named constant", () => {
    expect(PAINT_DEPTH_CAP).toBe(4);
  });
});
