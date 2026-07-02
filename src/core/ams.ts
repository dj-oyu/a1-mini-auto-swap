// AMS / filament matching (spec 6 ④ / 13 filament_confirm). Pure — a shared
// domain service so the "does the loaded AMS satisfy the job's demand" rule
// lives in one place (used by confirm-filaments auto-queue, runout Tier checks).

import { sameColor } from "./color.ts";

export interface FilamentReq {
  slot: number;
  color: string;
  type: string;
}

export interface LoadedTray {
  slot: number;
  color: string;
  type: string;
}

/** True iff every required filament is present in a loaded tray with the same
 *  slot, color, and type — the exact-match condition for advisory auto-queue
 *  (INV-PENDING-01). */
export function amsMatches(required: FilamentReq[], loaded: LoadedTray[]): boolean {
  return required.every((r) =>
    loaded.some((t) => t.slot === r.slot && sameColor(t.color, r.color) && t.type === r.type),
  );
}
