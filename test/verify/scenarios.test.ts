import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadScenario } from "../../src/verify/scenario.ts";
import { runScenario } from "../../src/verify/runner.ts";
import { StubSut } from "../../src/verify/stub-sut.ts";

const dir = join(process.cwd(), "scenarios");

/** Run a scenario file end-to-end through the real orchestrator (DB + dispatcher
 *  + VirtualPrinter) via StubSut. This is the Phase 3 完了条件. */
async function run(file: string) {
  return runScenario(loadScenario(join(dir, file)), new StubSut());
}

describe("scenarios end-to-end (Phase 3 完了条件)", () => {
  test("S1 — single job runs to completion, all asserts + invariants pass", async () => {
    const r = await run("S1-single-job.yaml");
    if (!r.ok) console.error("S1 failure:", r.failure, r.steps.filter((s) => !s.ok));
    expect(r.ok).toBe(true);
    expect(r.expects.every((e) => e.ok)).toBe(true);
  });

  test("S2 — three jobs dispatch in position order, stocker steps 10->7", async () => {
    const r = await run("S2-multi-job-sequential.yaml");
    if (!r.ok) console.error("S2 failure:", r.failure, r.steps.filter((s) => !s.ok));
    expect(r.ok).toBe(true);
    expect(r.expects.every((e) => e.ok)).toBe(true);
  });
});
