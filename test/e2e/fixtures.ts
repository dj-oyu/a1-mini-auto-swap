import { test as base, expect } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

// Shared E2E fixtures: a per-test state reset (the harness is shared) plus 3mf
// payload builders for upload tests.

/** Reset the harness DB (seeded) before every test so tests are isolated. */
export const test = base.extend<{ autoReset: void }>({
  autoReset: [
    async ({ request }, use) => {
      await request.post("/__dev/reset"); // seeded demo dataset, ids restart at 1
      await use();
    },
    { auto: true },
  ],
});

export { expect };

const PLATE_GCODE = ["; HEADER_BLOCK_START", "; name = plate_1", "; HEADER_BLOCK_END", "G28", ""].join("\n");

// A real (decodable) 1×1 PNG, so the browser doesn't fire <img> onerror and
// remove the thumbnail (which the 3D-preview test clicks).
const PNG_1x1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  ),
);

/** A valid .gcode.3mf carrying 2 filaments, a plate thumbnail, and a tetra mesh
 *  — enough to exercise filament-confirm, the thumbnail, and the 3D viewer. */
export function validThreemf(): Buffer {
  const settings = JSON.stringify({
    filament_colour: ["#ff0000", "#0000ff"],
    filament_type: ["PLA", "PETG"],
  });
  const model = `<model><resources><object id="1"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="2" v3="3"/></triangles>
  </mesh></object></resources><build><item objectid="1"/></build></model>`;
  return Buffer.from(
    zipSync({
      "Metadata/plate_1.gcode": strToU8(PLATE_GCODE),
      "Metadata/project_settings.config": strToU8(settings),
      "Metadata/plate_1.png": PNG_1x1,
      "3D/3dmodel.model": strToU8(model),
    }),
  );
}

/** Bytes that are not a valid zip → the upload endpoint rejects with 400. */
export function invalidThreemf(): Buffer {
  return Buffer.from("this is definitely not a 3mf zip archive");
}

/** A .gcode.3mf carrying TWO plates (an "export all plates" project) — the
 *  confirm modal must offer a plate picker instead of auto-selecting one. */
export function multiPlateThreemf(): Buffer {
  const settings = JSON.stringify({
    filament_colour: ["#ff0000"],
    filament_type: ["PLA"],
  });
  const model = `<model><resources><object id="1"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="2" v3="3"/></triangles>
  </mesh></object></resources><build><item objectid="1"/></build></model>`;
  return Buffer.from(
    zipSync({
      "Metadata/plate_1.gcode": strToU8(PLATE_GCODE),
      "Metadata/plate_1.json": strToU8(JSON.stringify({ prediction: 3600 })),
      "Metadata/plate_2.gcode": strToU8(PLATE_GCODE),
      "Metadata/plate_2.json": strToU8(JSON.stringify({ prediction: 1800 })),
      "Metadata/project_settings.config": strToU8(settings),
      "3D/3dmodel.model": strToU8(model),
    }),
  );
}
