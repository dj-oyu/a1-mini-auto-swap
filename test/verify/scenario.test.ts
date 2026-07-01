import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_WAIT_MS, loadScenario, parseScenario, parseStep } from "../../src/verify/scenario.ts";

describe("parseStep — DSL forms", () => {
  test("bare-string steps", () => {
    expect(parseStep("dispatch_all")).toEqual({ kind: "dispatch_all" });
    expect(parseStep("finish_current")).toEqual({ kind: "finish_current" });
    expect(parseStep("refill_stocker")).toEqual({ kind: "refill_stocker" });
    expect(() => parseStep("nope")).toThrow(/unknown bare step/);
  });

  test("action steps", () => {
    expect(parseStep({ upload: "plateA" })).toEqual({ kind: "upload", job: "plateA" });
    expect(parseStep({ confirm_filaments: "plateA" })).toEqual({ kind: "confirm_filaments", job: "plateA" });
    expect(parseStep({ retry: "plateA" })).toEqual({ kind: "retry", job: "plateA" });
    expect(parseStep({ resolve_pending: { type: "color_decision" } })).toEqual({
      kind: "resolve_pending",
      type: "color_decision",
    });
  });

  test("control step extracts method/path/body", () => {
    expect(parseStep({ control: { POST: "/__control/ams/0", body: { remaining_g: 0 } } })).toEqual({
      kind: "control",
      method: "POST",
      path: "/__control/ams/0",
      body: { remaining_g: 0 },
    });
  });

  test("wait_until job and pending forms", () => {
    expect(parseStep({ wait_until: { job: "plateA", state: "printing" } })).toEqual({
      kind: "wait_job",
      job: "plateA",
      state: "printing",
      timeoutMs: DEFAULT_WAIT_MS,
    });
    expect(parseStep({ wait_until: { pending_action: "color_decision", exists: true } })).toEqual({
      kind: "wait_pending",
      type: "color_decision",
      exists: true,
      timeoutMs: DEFAULT_WAIT_MS,
    });
    expect(parseStep({ wait_until: { job: "x", state: "y", timeout_ms: 500 } })).toMatchObject({
      timeoutMs: 500,
    });
  });

  test("assert forms", () => {
    expect(parseStep({ assert: { job: "plateA", state: "queued" } })).toEqual({
      kind: "assert_job",
      job: "plateA",
      state: "queued",
    });
    expect(parseStep({ assert: { stocker: { remaining: 9 } } })).toEqual({
      kind: "assert_stocker",
      remaining: 9,
    });
    expect(parseStep({ assert: { pending_action: "color_decision", exists: true } })).toEqual({
      kind: "assert_pending",
      type: "color_decision",
      exists: true,
    });
    expect(parseStep({ assert: { invariant: "INV-STOCKER-01" } })).toEqual({
      kind: "assert_invariant",
      id: "INV-STOCKER-01",
    });
    expect(parseStep({ assert: { printing_count: 1 } })).toEqual({
      kind: "assert_printing_count",
      count: 1,
    });
  });

  test("rejects multi-key and unknown steps", () => {
    expect(() => parseStep({ upload: "a", retry: "b" })).toThrow(/exactly one key/);
    expect(() => parseStep({ bogus: 1 })).toThrow(/unknown step key/);
  });
});

describe("parseScenario — the real scenario files parse against the DSL", () => {
  const dir = join(process.cwd(), "scenarios");

  test("S1-single-job.yaml", () => {
    const s = loadScenario(join(dir, "S1-single-job.yaml"));
    expect(s.name).toContain("単一ジョブ");
    expect(s.targets).toContain("INV-STOCKER-02");
    expect(s.steps.length).toBeGreaterThan(0);
    // every step parsed into a known kind (no throw above means all valid)
    expect(s.steps.some((st) => st.kind === "finish_current")).toBe(true);
    expect(s.steps.some((st) => st.kind === "assert_printing_count")).toBe(true);
  });

  test("S2-multi-job-sequential.yaml", () => {
    const s = loadScenario(join(dir, "S2-multi-job-sequential.yaml"));
    expect(s.targets).toContain("INV-DISPATCH-02");
    expect(s.steps.filter((st) => st.kind === "finish_current").length).toBe(3);
  });

  test("a minimal inline scenario round-trips", () => {
    const s = parseScenario("name: t\nsteps:\n  - dispatch_all\n");
    expect(s.name).toBe("t");
    expect(s.setup.jobs).toEqual([]);
    expect(s.steps).toEqual([{ kind: "dispatch_all" }]);
  });
});
