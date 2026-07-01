// Project color-consistency policy (spec 12). Pure decision: when a plate
// finishes with a color substitution, decide what happens to the same project's
// remaining plates. Applying it (propagate substitution / create color_decision
// pending) is the caller's job.

import type { ColorConsistencyPolicy } from "./types.ts";

export type ColorDecision =
  | { kind: "none" } // no project, or no substitution — nothing to decide
  | { kind: "propagate" } // apply the substitute color to remaining queued plates
  | { kind: "block" }; // strict: stop the project, ask a human (color_decision)

export interface ColorContext {
  hasProject: boolean;
  policy: ColorConsistencyPolicy;
}

/**
 * @param substituted whether the finished plate actually substituted a color
 */
export function resolveColorConsistency(ctx: ColorContext, substituted: boolean): ColorDecision {
  if (!ctx.hasProject || !substituted) return { kind: "none" }; // INV-PROJECT-03
  return ctx.policy === "propagate" ? { kind: "propagate" } : { kind: "block" };
}
