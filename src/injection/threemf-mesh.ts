import { strFromU8, unzipSync } from "fflate";

// 3MF mesh extraction for the 3D preview (spec 17 §9 / MVP #6). Parses the
// `<mesh>` geometry out of every `*.model` part in the archive and merges it
// into one indexed triangle soup for Three.js. This is a *verification* preview,
// not a print-accurate render: build-item/component transforms are intentionally
// ignored (the client auto-centers + fits, and lets the user rotate), so a model
// reachable only via instanced components shows one copy in local coordinates.
// Multi-material per-triangle segmentation is likewise out of scope here.

export interface Mesh {
  /** flat [x0,y0,z0, x1,y1,z1, …] */
  positions: number[];
  /** flat triangle vertex indices into positions */
  indices: number[];
}

/** Read a numeric attribute from a start tag; NaN-safe (returns null). */
function numAttr(tag: string, name: string): number | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
function intAttr(tag: string, name: string): number | null {
  const n = numAttr(tag, name);
  return n != null && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Extract a merged mesh from a `.gcode.3mf` / `.3mf`, or null when the archive
 * carries no parseable geometry. Never throws into the caller.
 */
export function extractMesh(threemf: Buffer): Mesh | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(threemf);
  } catch {
    return null;
  }
  const modelNames = Object.keys(files).filter((n) => /\.model$/i.test(n));
  const positions: number[] = [];
  const indices: number[] = [];

  for (const name of modelNames) {
    let xml: string;
    try {
      xml = strFromU8(files[name]!);
    } catch {
      continue;
    }
    const meshRe = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/g;
    let mesh: RegExpExecArray | null;
    while ((mesh = meshRe.exec(xml)) !== null) {
      const body = mesh[1]!;
      const base = positions.length / 3;

      const verts = /<vertices\b[^>]*>([\s\S]*?)<\/vertices>/.exec(body);
      if (!verts) continue;
      let added = 0;
      const vre = /<vertex\b[^>]*?\/?>/g;
      let v: RegExpExecArray | null;
      while ((v = vre.exec(verts[1]!)) !== null) {
        const x = numAttr(v[0], "x");
        const y = numAttr(v[0], "y");
        const z = numAttr(v[0], "z");
        if (x == null || y == null || z == null) continue;
        positions.push(x, y, z);
        added++;
      }

      const tris = /<triangles\b[^>]*>([\s\S]*?)<\/triangles>/.exec(body);
      if (tris) {
        const tre = /<triangle\b[^>]*?\/?>/g;
        let t: RegExpExecArray | null;
        while ((t = tre.exec(tris[1]!)) !== null) {
          const a = intAttr(t[0], "v1");
          const b = intAttr(t[0], "v2");
          const c = intAttr(t[0], "v3");
          // guard against indices outside the vertices we just read
          if (a == null || b == null || c == null) continue;
          if (a >= added || b >= added || c >= added) continue;
          indices.push(base + a, base + b, base + c);
        }
      }
    }
  }

  if (positions.length === 0 || indices.length === 0) return null;
  return { positions, indices };
}
