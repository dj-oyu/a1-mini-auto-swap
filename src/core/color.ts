// Filament color normalization (pure). The same physical color arrives in
// different notations depending on the source: 3MF project_settings.config
// uses "#RRGGBB", the AMS MQTT wire reports tray_color as "RRGGBBAA" (no '#',
// trailing alpha — docs/bambu-protocol-notes.md), and case varies by tool.
// All domain color comparisons (amsMatches, resolveRunout) go through
// sameColor so notation variance never causes a false mismatch — which would
// surface as a spurious blocking_job escalation (INV-PENDING-02) or a false
// ⚠色代替 substitution record (INV-RUNOUT-06).

/** Canonical form: "#RRGGBB" uppercase. Accepts "#rgb"/"#rrggbb"/"rrggbb"/
 *  "rrggbbaa" (alpha dropped). Non-hex tokens pass through trimmed+uppercased
 *  (compared as opaque strings rather than throwing). */
export function normalizeColor(raw: string): string {
  const s = raw.trim().replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{3}$/.test(s)) {
    return "#" + s.split("").map((c) => c + c).join("");
  }
  if (/^[0-9A-F]{6}$/.test(s)) return "#" + s;
  if (/^[0-9A-F]{8}$/.test(s)) return "#" + s.slice(0, 6); // AMS RRGGBBAA
  return raw.trim().toUpperCase();
}

export function sameColor(a: string, b: string): boolean {
  return normalizeColor(a) === normalizeColor(b);
}
