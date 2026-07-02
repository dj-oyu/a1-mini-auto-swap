// Pure decoder for the Bambu/Orca per-triangle `paint_color` multi-material
// painting attribute (task #23 stage 3). Leaf module: NO I/O, no external deps,
// fully deterministic — given a triangle's 3 corner positions and its
// `paint_color` hex string, it yields the coloured sub-triangles the slicer
// would paint.
//
// ── Format (ported VERBATIM from bambulab/BambuStudio, branch master) ──────────
// The attribute encodes BambuStudio's `TriangleSelector` recursive-subdivision
// bitstream, packed into a hex STRING. Three source functions define it:
//
// 1. hex STRING ⇄ bit vector — `FacetsAnnotation::set_triangle_from_string`
//    (src/libslic3r/Model.cpp): the string is walked in REVERSE (last char
//    first) and each hex digit contributes 4 bits LSB-first:
//        for (auto it = str.crbegin(); it != str.crend(); ++it)
//            for (int i = 0; i < 4; ++i)
//                m_data.second.push_back(bool(dec & (1 << i)));
//    ⇒ the nibbles are consumed in reversed-string order, each nibble value ==
//    the hex digit. So we can work directly on a reversed array of nibbles.
//
// 2. bit vector → tree — `TriangleSelector::deserialize`
//    (src/libslic3r/TriangleSelector.cpp): reads one nibble `code` per node:
//        int num_of_split_sides = code & 0b11;               // 0 ⇒ leaf
//        int special_side       = code >> 2;                 // split: which side
//    Leaf state:
//        if ((code & 0b1100) == 0b1100) {                    // marker ⇒ state>=3
//            next_code = next_nibble(); num = 0;
//            while (next_code == 0b1111) { num++; next_code = next_nibble(); }
//            state = next_code + 15 * num + 3;
//        } else state = code >> 2;                            // states 0,1,2
//    A split node has `num_of_split_sides + 1` children, serialized/deserialized
//    in REVERSE order (child index `split` down to 0) — see `serialize`'s
//    `for (child_idx = split_sides; child_idx >= 0; --child_idx)`.
//
// 3. subdivision geometry — `TriangleSelector::perform_split`
//    (src/libslic3r/TriangleSelector.cpp): child vertices are edge midpoints.
//    The node's corners are first rotated to start at `special_side`
//    (L0=corner[special], L1=corner[special+1], L2=corner[special+2]); the 1/2/3
//    -sided split layouts below reproduce push_triangle's exact vertex order
//    (so winding — hence outward normals — is preserved).
//
// ── State → colour ────────────────────────────────────────────────────────────
// Confirmed via `MultiMaterialSegmentation.cpp`: painted facets are collected by
// `get_facets_strict(EnforcerBlockerType(extruder_idx))` for extruder_idx in
// 0..filament_colour.size(). So state 0 = the object's BASE extruder (unpainted),
// states 1..N = filament N. Resolved extruder colour = filamentColours[ext-1].

/** Max recursion depth. Beyond this a pathological string stops subdividing:
 *  the still-split node is emitted as ONE triangle coloured by its first
 *  (dominant, DFS-order) leaf state. The bitstream is STILL fully consumed so
 *  structural validation (exact consumption) holds. */
export const PAINT_DEPTH_CAP = 4;

type Vec3 = [number, number, number];
type Tri = [Vec3, Vec3, Vec3];

export interface PaintDecodeStats {
  /** parsed cleanly: never read past the end AND consumed every nibble exactly. */
  ok: boolean;
  /** the read cursor landed exactly at the end of the string's nibbles. */
  consumedAll: boolean;
  /** the parse tried to read past the end of the stream (⇒ wrong/short string). */
  overran: boolean;
  /** number of leaf sub-triangles the tree describes. */
  leaves: number;
  /** number of triangles actually emitted (≤ leaves, capped subtrees collapse). */
  emitted: number;
  /** largest leaf state seen — for filament-range validation (0..palette length). */
  maxState: number;
}

/** Parse a hex string into the nibble array in DECODE-CONSUMPTION order (reversed
 *  string, each nibble = the hex digit's value). Returns null on a bad char. */
function hexToNibbles(hex: string): number[] | null {
  const n = hex.length;
  const out: number[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const ch = hex.charCodeAt(n - 1 - k); // reversed: last char consumed first
    let d: number;
    if (ch >= 48 && ch <= 57) d = ch - 48; // '0'-'9'
    else if (ch >= 65 && ch <= 70) d = ch - 55; // 'A'-'F'
    else if (ch >= 97 && ch <= 102) d = ch - 87; // 'a'-'f' (lenient)
    else return null;
    out[k] = d;
  }
  return out;
}

function mid(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/**
 * Reproduce `perform_split`'s child triangles for a `split`-sided split with the
 * given `special` side, as an array of `split+1` child triangles (index order
 * matching push_triangle, so children[i] is BambuStudio's child i). Corners are
 * rotated to start at `special` exactly as the C++ does.
 */
function computeChildren(tri: Tri, split: number, special: number): Tri[] {
  const L0 = tri[special % 3]!;
  const L1 = tri[(special + 1) % 3]!;
  const L2 = tri[(special + 2) % 3]!;
  switch (split) {
    case 1: {
      const m21 = mid(L2, L1);
      return [
        [L0, L1, m21],
        [m21, L2, L0],
      ];
    }
    case 2: {
      const m10 = mid(L1, L0);
      const m02 = mid(L0, L2);
      return [
        [L0, m10, m02],
        [m10, L1, m02],
        [L1, L2, m02],
      ];
    }
    case 3: {
      // special is always 0 for a 3-split (set_division), rotation is identity.
      const m10 = mid(L1, L0);
      const m21 = mid(L2, L1);
      const m02 = mid(L0, L2);
      return [
        [L0, m10, m02],
        [m10, L1, m21],
        [m21, L2, m02],
        [m10, m21, m02],
      ];
    }
    default:
      return [];
  }
}

/**
 * Decode one triangle's `paint_color` string. Calls `emit(positions9, extruder)`
 * for every coloured sub-triangle, where `extruder` is 1-based (state 0 resolves
 * to `baseExtruder`, states ≥1 are the filament index; the caller colours it
 * `filamentColours[extruder-1]`). Returns parse statistics for validation.
 *
 * Deterministic, allocation-light, never throws. A faithful decoder consumes the
 * whole string exactly (`stats.consumedAll`); a wrong bit layout overruns or
 * leaves dangling nibbles on some strings.
 */
export function decodePaintColor(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  paintColor: string,
  baseExtruder: number,
  emit: (positions: number[], extruder: number) => void,
  depthCap: number = PAINT_DEPTH_CAP,
): PaintDecodeStats {
  const stats: PaintDecodeStats = {
    ok: false,
    consumedAll: false,
    overran: false,
    leaves: 0,
    emitted: 0,
    maxState: 0,
  };
  const nibbles = hexToNibbles(paintColor);
  if (!nibbles || nibbles.length === 0) return stats;

  let i = 0;
  let overran = false;
  const next = (): number => {
    if (i >= nibbles.length) {
      overran = true;
      return 0;
    }
    return nibbles[i++]!;
  };
  const resolve = (state: number): number => (state === 0 ? baseExtruder : state);
  const emitTri = (tri: Tri, ext: number): void => {
    emit([tri[0][0], tri[0][1], tri[0][2], tri[1][0], tri[1][1], tri[1][2], tri[2][0], tri[2][1], tri[2][2]], ext);
    stats.emitted++;
  };

  // Recursive node parse (mirrors serialize's structure). `tri` is the node's
  // geometry, or null when an ancestor was depth-capped (we keep parsing to
  // consume bits but emit nothing here). Returns the first DFS-order leaf state.
  const node = (tri: Tri | null, depth: number): number => {
    const code = next();
    const split = code & 0b11;
    if (split === 0) {
      let state: number;
      if ((code & 0b1100) === 0b1100) {
        let ext = next();
        let num = 0;
        while (ext === 0b1111) {
          num++;
          ext = next();
        }
        state = ext + 15 * num + 3;
      } else {
        state = code >> 2;
      }
      stats.leaves++;
      if (state > stats.maxState) stats.maxState = state;
      if (tri) emitTri(tri, resolve(state));
      return state;
    }
    const special = code >> 2;
    const children = tri && depth < depthCap ? computeChildren(tri, split, special) : null;
    let firstState = -1;
    for (let c = split; c >= 0; c--) {
      const childTri = children ? children[c]! : null;
      const s = node(childTri, depth + 1);
      if (firstState < 0) firstState = s;
    }
    // Depth-capped node that still owns geometry: emit it once, dominant colour.
    if (tri && !children) emitTri(tri, resolve(firstState < 0 ? 0 : firstState));
    return firstState < 0 ? 0 : firstState;
  };

  node([p0, p1, p2], 0);

  stats.overran = overran;
  stats.consumedAll = !overran && i === nibbles.length;
  stats.ok = stats.consumedAll;
  return stats;
}
