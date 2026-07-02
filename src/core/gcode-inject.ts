// G-code injection primitives (spec 7). Pure string functions — the 3MF
// archive plumbing (unzip, MD5 sidecar, repackage) is the injection/ adapter.

/** Marker at the end of the slicer's MACHINE_START_GCODE block (spec 7). */
export const MACHINE_START_MARKER = "; MACHINE_START_GCODE_END";

export interface InjectResult {
  text: string;
  warnings: string[];
}

/**
 * Append the end/swap sequence after the plate's final G-code line (spec 7,
 * INV-INJECT-04). The original last line is preserved; the snippet follows it.
 */
export function injectEndSequence(gcode: string, snippet: string): string {
  const body = gcode.replace(/\s+$/, "");
  return `${body}\n${snippet.trim()}\n`;
}

/**
 * Inject the start sequence right after MACHINE_START_MARKER; if the marker is
 * absent (old output) prepend it and warn (spec 7, INV-INJECT-05).
 */
export function injectStartSequence(gcode: string, snippet: string): InjectResult {
  const idx = gcode.indexOf(MACHINE_START_MARKER);
  if (idx >= 0) {
    const at = idx + MACHINE_START_MARKER.length;
    return { text: `${gcode.slice(0, at)}\n${snippet.trim()}${gcode.slice(at)}`, warnings: [] };
  }
  return {
    text: `${snippet.trim()}\n${gcode}`,
    warnings: [`marker "${MACHINE_START_MARKER}" not found; prepended start sequence`],
  };
}

/**
 * Resolve `{name}` placeholders from header vars. A known placeholder (key present
 * in `vars`) is always substituted so no raw known placeholder survives
 * (INV-INJECT-02, the crash-inducing case). Unknown placeholders are left intact
 * with a warning rather than failing (spec 7).
 */
export function resolvePlaceholders(snippet: string, vars: Record<string, string>): InjectResult {
  const warnings: string[] = [];
  const text = snippet.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key]!;
    warnings.push(`unknown placeholder ${match} left as-is`);
    return match;
  });
  return { text, warnings };
}
