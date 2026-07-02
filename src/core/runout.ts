// Filament-runout resolution (spec 14). Pure decision function: given the
// effective policy and current AMS state, decide whether to auto-switch to an
// alternate slot (and whether that substitutes the color) or escalate to a
// pending action. Applying the decision (MQTT resume, DB writes, notify) is the
// caller's job — this stays pure and fully unit-testable.
//
// Tiers (spec 14):
//   Tier 0  AMS Filament Backup (firmware, not modeled here)
//   Tier 1  same_color_only     — same type AND same color
//   Tier 2  allow_material_match — same type, color may differ (=> substitution)
//   Tier 3  manual              — always a pending action

import { sameColor } from "./color.ts";

export type RunoutPolicy = "manual" | "same_color_only" | "allow_material_match";

export interface AmsTray {
  slot: number;
  color: string;
  type: string;
  remaining_g: number;
}

export interface RunoutContext {
  policy: RunoutPolicy;
  runoutSlot: number;
  trays: AmsTray[];
  /** slots at/below this are not viable alternates (INV-RUNOUT-07) */
  minThresholdG: number;
}

export type RunoutResolution =
  | { kind: "pending"; reason: "manual_policy" | "no_candidate" }
  | { kind: "switch"; toSlot: number; substitutedColor: string | null };

export function resolveRunout(ctx: RunoutContext): RunoutResolution {
  if (ctx.policy === "manual") {
    return { kind: "pending", reason: "manual_policy" }; // INV-RUNOUT-01 (no auto-switch)
  }

  const runout = ctx.trays.find((t) => t.slot === ctx.runoutSlot);
  if (!runout) return { kind: "pending", reason: "no_candidate" };

  const candidates = ctx.trays.filter(
    (t) => t.slot !== ctx.runoutSlot && t.remaining_g > ctx.minThresholdG, // INV-RUNOUT-07
  );

  let match: AmsTray | undefined;
  if (ctx.policy === "same_color_only") {
    // Tier 1: same type AND same color (INV-RUNOUT-03) — notation-insensitive
    match = candidates.find((t) => t.type === runout.type && sameColor(t.color, runout.color));
  } else {
    // Tier 2: same type, most remaining first; color may differ (INV-RUNOUT-04)
    match = candidates
      .filter((t) => t.type === runout.type)
      .sort((a, b) => b.remaining_g - a.remaining_g)[0];
  }

  if (!match) return { kind: "pending", reason: "no_candidate" }; // INV-RUNOUT-05

  // substitution recorded iff the landed color ACTUALLY differs — notation
  // variance alone must not raise a false ⚠色代替 (INV-RUNOUT-06)
  const substitutedColor = sameColor(match.color, runout.color) ? null : match.color;
  return { kind: "switch", toSlot: match.slot, substitutedColor };
}
