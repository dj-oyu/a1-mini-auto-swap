// AMS mapping domain rule (spec 9 / INV-MQTT-01): exactly 4 entries (print
// slots), each a tray index 0–3 or -1 for "unused". A 5-element mapping is a
// known firmware trap — it silently degrades to an external-spool print — so
// this is enforced everywhere a mapping crosses a boundary. Pure (core).

export const EMPTY_AMS_MAPPING: readonly number[] = Object.freeze([-1, -1, -1, -1]);

export function isValidAmsMapping(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => Number.isInteger(n) && n >= -1 && n <= 3)
  );
}

/**
 * Parse a DB-stored `jobs.ams_mapping` JSON column. `null` means "no mapping
 * confirmed yet" → all-unused. Anything else must be a valid 4-element
 * mapping: corrupt data throws (surfacing as a failed dispatch with a clear
 * error) instead of silently becoming an external-spool print.
 */
export function parseAmsMapping(json: string | null | undefined): number[] {
  if (json == null) return [...EMPTY_AMS_MAPPING];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error(`ams_mapping is not valid JSON: ${json}`);
  }
  if (!isValidAmsMapping(v)) {
    throw new Error(`ams_mapping must be 4 integers in -1..3 (INV-MQTT-01): ${json}`);
  }
  return v;
}
