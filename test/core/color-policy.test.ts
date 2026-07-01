import { describe, expect, test } from "bun:test";
import { resolveColorConsistency } from "../../src/core/color-policy.ts";

describe("resolveColorConsistency (spec 12)", () => {
  test("strict + substitution => block (color_decision) (INV-PROJECT-01)", () => {
    expect(resolveColorConsistency({ hasProject: true, policy: "strict" }, true)).toEqual({ kind: "block" });
  });

  test("propagate + substitution => propagate (INV-PROJECT-02)", () => {
    expect(resolveColorConsistency({ hasProject: true, policy: "propagate" }, true)).toEqual({
      kind: "propagate",
    });
  });

  test("no project => none, regardless of policy/substitution (INV-PROJECT-03)", () => {
    expect(resolveColorConsistency({ hasProject: false, policy: "strict" }, true)).toEqual({ kind: "none" });
  });

  test("no substitution => none (nothing to decide)", () => {
    expect(resolveColorConsistency({ hasProject: true, policy: "strict" }, false)).toEqual({ kind: "none" });
  });
});
