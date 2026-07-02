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
 * Extract a merged whole-archive mesh from a `.gcode.3mf` / `.3mf`, or null when
 * the archive carries no parseable geometry. Never throws into the caller.
 *
 * When the archive is a Bambu "production extension" file (it has a `<build>`),
 * every build item is placed with its composed component∘build-item transform so
 * a multi-object file (e.g. 4/26 letters) spreads across its real plater
 * positions instead of stacking every object at the origin. Falls back to the
 * transform-less union of all `<mesh>` bodies only for simple archives that have
 * NO `<build>` (e.g. a single inline-mesh 3mf), so those still render.
 */
export function extractMesh(threemf: Buffer): Mesh | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(threemf);
  } catch {
    return null;
  }

  // Preferred: transform-aware scene assembly (production extension).
  const rootBytes = files["3D/3dmodel.model"];
  if (rootBytes) {
    try {
      const root = parseRootModel(strFromU8(rootBytes));
      const scene = assembleScene(root, files, null); // null ⇒ ALL build items
      if (scene) return { positions: scene.positions, indices: scene.indices };
    } catch {
      /* fall through to the untransformed union */
    }
  }

  // Fallback: no <build> → union every mesh in local coordinates.
  return mergeAllMeshesUntransformed(files);
}

/** Union every `<mesh>` in every `*.model` part in LOCAL coordinates (no
 *  build/component transforms). Only used for archives without a `<build>`. */
function mergeAllMeshesUntransformed(files: Record<string, Uint8Array>): Mesh | null {
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
      pushMesh(mesh[1]!, positions, indices, []);
    }
  }

  if (positions.length === 0 || indices.length === 0) return null;
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Per-plate mesh extraction (task #23 stage 1). Bambu writes the "production
// extension": 3D/3dmodel.model holds a <build> of <item objectid=.. transform=..>
// placements referencing <object> resources whose geometry lives in EXTERNAL
// part files (3D/Objects/object_N.model, each up to tens of MB) via
// <component p:path=.. objectid=.. transform=..>. The plate→object assignment
// lives in Metadata/model_settings.config (<plate><metadata key="plater_id"/>
// … <model_instance><metadata key="object_id"/>). Unlike extractMesh() above,
// this restricts geometry to a single plate's objects and APPLIES the build +
// component transforms so the preview matches what actually prints.
// ---------------------------------------------------------------------------

export interface PlateMesh {
  /** flat [x0,y0,z0, …] in world (build) coordinates */
  positions: number[];
  /** flat triangle vertex indices into positions */
  indices: number[];
  /** axis-aligned bounds of the merged geometry */
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /**
   * Per-object index ranges into `indices` (start + count, both multiples of 3).
   * Each group is one placed object. `extruder` (1-based) is resolved from
   * model_settings when available (null when unknown, e.g. whole-scene fallback);
   * the viewer colours the group with `filamentColours[extruder-1]`.
   * STAGE-3 SEAM: the per-triangle `paint_color` attribute (Bambu multi-material
   * parts) can still further subdivide a group's colour; not decoded here.
   */
  groups: { objectId: number; extruder: number | null; start: number; count: number }[];
  /** 0-based filament palette (`#RRGGBB`) from project_settings.config, so the
   *  client can colour each group by extruder and re-colour on slot changes. */
  filamentColours: string[];
}

/** Read a string attribute from a start tag (colon-safe, e.g. "p:path"). */
function strAttr(tag: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${esc}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1]! : null;
}

/** Parse a 3MF 12-float transform ("m00 m01 m02 m10 … m30 m31 m32"). Returns
 *  null (⇒ identity) for anything that isn't 12 finite numbers. */
function parseTransform(s: string | null): number[] | null {
  if (!s) return null;
  const nums = s.trim().split(/\s+/).map(Number);
  if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/** Apply a 12-float 3MF transform to a point (row-vector × 4×3 matrix). */
function applyTransform(t: number[] | null, x: number, y: number, z: number): [number, number, number] {
  if (!t) return [x, y, z];
  return [
    x * t[0]! + y * t[3]! + z * t[6]! + t[9]!,
    x * t[1]! + y * t[4]! + z * t[7]! + t[10]!,
    x * t[2]! + y * t[5]! + z * t[8]! + t[11]!,
  ];
}

interface RootObject {
  components: { path: string; objectid: number | null; transform: number[] | null }[];
  inlineMesh?: string;
}

/** Parse 3D/3dmodel.model into its build placements + resource objects. */
function parseRootModel(xml: string): { build: Map<number, number[] | null>; resources: Map<number, RootObject> } {
  const build = new Map<number, number[] | null>();
  const buildBlock = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
  if (buildBlock) {
    const ire = /<item\b[^>]*?\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = ire.exec(buildBlock[1]!)) !== null) {
      const oid = intAttr(m[0], "objectid");
      if (oid != null) build.set(oid, parseTransform(strAttr(m[0], "transform")));
    }
  }

  const resources = new Map<number, RootObject>();
  const resBlock = /<resources\b[^>]*>([\s\S]*?)<\/resources>/.exec(xml);
  const scope = resBlock ? resBlock[1]! : xml;
  const ore = /<object\b[^>]*?>([\s\S]*?)<\/object>/g;
  let o: RegExpExecArray | null;
  while ((o = ore.exec(scope)) !== null) {
    const openTag = /<object\b[^>]*?>/.exec(o[0])![0];
    const id = intAttr(openTag, "id");
    if (id == null) continue;
    const inner = o[1]!;
    const components: RootObject["components"] = [];
    const cre = /<component\b[^>]*?\/?>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cre.exec(inner)) !== null) {
      const raw = strAttr(cm[0], "p:path") ?? strAttr(cm[0], "path");
      if (!raw) continue;
      components.push({
        path: raw.replace(/^\/+/, ""),
        objectid: intAttr(cm[0], "objectid"),
        transform: parseTransform(strAttr(cm[0], "transform")),
      });
    }
    const meshM = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/.exec(inner);
    resources.set(id, { components, inlineMesh: meshM ? meshM[1]! : undefined });
  }
  return { build, resources };
}

/** plater_id → build object ids, from Metadata/model_settings.config. */
function parsePlateAssignments(xml: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const pre = /<plate>([\s\S]*?)<\/plate>/g;
  let p: RegExpExecArray | null;
  while ((p = pre.exec(xml)) !== null) {
    const block = p[1]!;
    const pid = /key="plater_id"\s+value="(\d+)"/.exec(block);
    if (!pid) continue;
    const ids: number[] = [];
    const ore = /key="object_id"\s+value="(\d+)"/g;
    let om: RegExpExecArray | null;
    while ((om = ore.exec(block)) !== null) ids.push(Number(om[1]));
    map.set(Number(pid[1]), ids);
  }
  return map;
}

/** model_settings.config `<object id> → extruder` (1-based). The id space is the
 *  build object id (verified on real Bambu files: build objectid == the
 *  model_settings <object id> used by plate assignment), so groups map directly. */
function parseObjectExtruders(xml: string): Map<number, number> {
  const map = new Map<number, number>();
  const ore = /<object\b[^>]*?\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g;
  let o: RegExpExecArray | null;
  while ((o = ore.exec(xml)) !== null) {
    // the object's own extruder is the FIRST extruder metadata before any <part>
    const head = o[2]!.split("<part")[0]!;
    const ext = /key="extruder"\s+value="(\d+)"/.exec(head);
    if (ext) map.set(Number(o[1]), Number(ext[1]));
  }
  return map;
}

/** 0-based filament palette from project_settings.config (`filament_colour`). */
function parseFilamentColours(cfg: Uint8Array | undefined): string[] {
  if (!cfg) return [];
  try {
    const json = JSON.parse(strFromU8(cfg)) as { filament_colour?: string[] };
    return Array.isArray(json.filament_colour) ? json.filament_colour : [];
  } catch {
    return [];
  }
}

/** Trailing integer of a plate id ("plate_24" → 24, "24" → 24). */
function platerIdOf(plateId: string): number | null {
  const m = /(\d+)\s*$/.exec(plateId ?? "");
  return m ? Number(m[1]) : null;
}

/** Find the <mesh> body for a given object id in an external part file (falls
 *  back to the first mesh in the file when the id can't be matched). */
function findMeshBody(xml: string, objectid: number | null): string | null {
  if (objectid != null) {
    const ore = /<object\b[^>]*?>([\s\S]*?)<\/object>/g;
    let o: RegExpExecArray | null;
    while ((o = ore.exec(xml)) !== null) {
      const openTag = /<object\b[^>]*?>/.exec(o[0])![0];
      if (intAttr(openTag, "id") === objectid) {
        const mm = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/.exec(o[1]!);
        if (mm) return mm[1]!;
      }
    }
  }
  const mm = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/.exec(xml);
  return mm ? mm[1]! : null;
}

/** Parse a <mesh> body, apply `transforms` (in order) to each vertex, and
 *  append the result to `positions`/`indices`. Returns triangles appended. */
function pushMesh(
  body: string,
  positions: number[],
  indices: number[],
  transforms: (number[] | null)[],
): number {
  const base = positions.length / 3;
  const verts = /<vertices\b[^>]*>([\s\S]*?)<\/vertices>/.exec(body);
  if (!verts) return 0;
  let added = 0;
  const vre = /<vertex\b[^>]*?\/?>/g;
  let v: RegExpExecArray | null;
  while ((v = vre.exec(verts[1]!)) !== null) {
    let x = numAttr(v[0], "x");
    let y = numAttr(v[0], "y");
    let z = numAttr(v[0], "z");
    if (x == null || y == null || z == null) continue;
    for (const t of transforms) [x, y, z] = applyTransform(t, x, y, z);
    positions.push(x, y, z);
    added++;
  }
  let tris = 0;
  const tblock = /<triangles\b[^>]*>([\s\S]*?)<\/triangles>/.exec(body);
  if (tblock) {
    const tre = /<triangle\b[^>]*?\/?>/g;
    let t: RegExpExecArray | null;
    while ((t = tre.exec(tblock[1]!)) !== null) {
      const a = intAttr(t[0], "v1");
      const b = intAttr(t[0], "v2");
      const c = intAttr(t[0], "v3");
      if (a == null || b == null || c == null) continue;
      if (a >= added || b >= added || c >= added) continue;
      indices.push(base + a, base + b, base + c);
      tris++;
    }
  }
  return tris;
}

interface Scene {
  positions: number[];
  indices: number[];
  groups: PlateMesh["groups"];
}

/**
 * Assemble a transformed triangle scene from a parsed root model. Each target
 * build object is placed via its composed component∘build-item transform, so
 * objects land at their real plater positions (no origin stacking). `parts`
 * supplies the external `*.model` bytes (keyed by archive path). Returns null
 * when the archive has no `<build>` (⇒ caller falls back) or yields no geometry.
 *
 * `targetObjectIds`: the build object ids to include; `null` ⇒ every build item.
 */
function assembleScene(
  root: ReturnType<typeof parseRootModel>,
  parts: Record<string, Uint8Array>,
  targetObjectIds: number[] | null,
): Scene | null {
  if (root.build.size === 0) return null; // no production-extension build
  const targetIds = targetObjectIds ?? [...root.build.keys()];
  if (targetIds.length === 0) return null;

  const positions: number[] = [];
  const indices: number[] = [];
  const groups: PlateMesh["groups"] = [];
  for (const oid of targetIds) {
    const res = root.resources.get(oid);
    if (!res) continue;
    const itemT = root.build.get(oid) ?? null;
    const start = indices.length;
    if (res.inlineMesh) pushMesh(res.inlineMesh, positions, indices, [itemT]);
    for (const comp of res.components) {
      const bytes = parts[comp.path];
      if (!bytes) continue;
      let body: string | null;
      try {
        body = findMeshBody(strFromU8(bytes), comp.objectid);
      } catch {
        continue;
      }
      if (body) pushMesh(body, positions, indices, [comp.transform, itemT]);
    }
    if (indices.length > start) {
      groups.push({ objectId: oid, extruder: null, start, count: indices.length - start });
    }
  }

  if (positions.length === 0 || indices.length === 0) return null;
  return { positions, indices, groups };
}

/** Axis-aligned bounds over a flat [x,y,z,…] position buffer. */
function computeBbox(positions: number[]): PlateMesh["bbox"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const val = positions[i + k]!;
      if (val < min[k]!) min[k] = val;
      if (val > max[k]!) max[k] = val;
    }
  }
  return { min, max };
}

/**
 * Extract the merged, transform-applied geometry for a single plate from a
 * Bambu `.3mf` / `.gcode.3mf`, or null when nothing renderable is found. Reads
 * only the parts belonging to the target plate (fflate `filter`) so a 26-plate
 * archive never decompresses all ~800MB of geometry. Never throws internally.
 *
 * `plateId` is a "plate_N" id (or bare "N"); it maps to model_settings'
 * plater_id. A single-plate export keeps its ORIGINAL number (e.g. plate_24) —
 * when the id doesn't match but the archive has exactly one plate, that plate
 * is used; with no plate config at all, every build item is rendered.
 */
export function extractPlateMesh(threemf: Buffer, plateId: string): PlateMesh | null {
  let head: Record<string, Uint8Array>;
  try {
    head = unzipSync(threemf, {
      filter: (f) => f.name === "3D/3dmodel.model" || (f.name.startsWith("Metadata/") && f.name.endsWith(".config")),
    });
  } catch {
    return null;
  }
  const rootBytes = head["3D/3dmodel.model"];
  if (!rootBytes) return null;

  let root: ReturnType<typeof parseRootModel>;
  try {
    root = parseRootModel(strFromU8(rootBytes));
  } catch {
    return null;
  }

  // Resolve the plate's build object ids.
  let targetIds: number[] | null = null;
  const settings = head["Metadata/model_settings.config"];
  if (settings) {
    const plates = parsePlateAssignments(strFromU8(settings));
    const num = platerIdOf(plateId);
    if (num != null && plates.has(num)) targetIds = plates.get(num)!;
    else if (plates.size === 1) targetIds = [...plates.values()][0]!; // single-plate export fallback
  }
  if (!targetIds || targetIds.length === 0) targetIds = [...root.build.keys()]; // no config → whole scene
  if (targetIds.length === 0) return null;

  // Second pass: decompress only the external part files this plate needs.
  const needed = new Set<string>();
  for (const oid of targetIds) {
    for (const comp of root.resources.get(oid)?.components ?? []) needed.add(comp.path);
  }
  // The root model is already decompressed (head); add only the needed parts.
  const parts: Record<string, Uint8Array> = { "3D/3dmodel.model": rootBytes };
  if (needed.size) {
    try {
      Object.assign(parts, unzipSync(threemf, { filter: (f) => needed.has(f.name) }));
    } catch {
      return null;
    }
  }

  const scene = assembleScene(root, parts, targetIds);
  if (!scene) return null;

  // Colouring (stage 2): resolve each object's base extruder from model_settings
  // and expose the filament palette so the viewer can paint per-object.
  const extruders = settings ? parseObjectExtruders(strFromU8(settings)) : new Map<number, number>();
  for (const g of scene.groups) g.extruder = extruders.get(g.objectId) ?? null;
  const filamentColours = parseFilamentColours(head["Metadata/project_settings.config"]);

  return {
    positions: scene.positions,
    indices: scene.indices,
    bbox: computeBbox(scene.positions),
    groups: scene.groups,
    filamentColours,
  };
}
