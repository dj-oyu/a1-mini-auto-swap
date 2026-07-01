import { describe, expect, test } from "bun:test";
import { parseScenario } from "../../src/verify/scenario.ts";
import { runScenario } from "../../src/verify/runner.ts";
import { FakeSut } from "./fake-sut.ts";

const NORMAL = `
name: engine smoke - single job completes
targets: [INV-STOCKER-01]
setup:
  jobs: [{ id: plateA }]
  stocker: { capacity: 10, remaining: 10 }
steps:
  - upload: plateA
  - confirm_filaments: plateA
  - assert: { job: plateA, state: queued }
  - dispatch_all
  - wait_until: { job: plateA, state: printing }
  - assert: { printing_count: 1 }
  - assert: { stocker: { remaining: 10 } }
  - finish_current
  - wait_until: { job: plateA, state: success }
  - assert: { stocker: { remaining: 9 } }
  - assert: { invariant: INV-STOCKER-01 }
expect:
  - INV-STOCKER-01: "remaining >= 0"
`;

describe("runScenario — normal path", () => {
  test("all steps and expects pass against the fake", async () => {
    const result = await runScenario(parseScenario(NORMAL), new FakeSut());
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.expects).toEqual([{ invariant: "INV-STOCKER-01", ok: true, detail: undefined }]);
  });

  test("sequential multi-job dispatches in position order, stocker steps down", async () => {
    const yaml = `
name: three jobs sequential
setup:
  jobs: [{ id: A }, { id: B }, { id: C }]
  stocker: { capacity: 10, remaining: 10 }
steps:
  - upload: A
  - upload: B
  - upload: C
  - confirm_filaments: A
  - confirm_filaments: B
  - confirm_filaments: C
  - dispatch_all
  - wait_until: { job: A, state: printing }
  - assert: { printing_count: 1 }
  - finish_current
  - wait_until: { job: B, state: printing }
  - assert: { stocker: { remaining: 9 } }
  - finish_current
  - wait_until: { job: C, state: printing }
  - finish_current
  - wait_until: { job: C, state: success }
  - assert: { stocker: { remaining: 7 } }
  - assert: { printing_count: 0 }
`;
    const result = await runScenario(parseScenario(yaml), new FakeSut());
    expect(result.ok).toBe(true);
  });
});

describe("runScenario — failures are reported, not thrown", () => {
  test("a failing assert stops the run and names the step", async () => {
    const yaml = `
name: bad stocker assert
setup:
  jobs: [{ id: plateA }]
  stocker: { capacity: 10, remaining: 10 }
steps:
  - upload: plateA
  - confirm_filaments: plateA
  - dispatch_all
  - finish_current
  - assert: { stocker: { remaining: 5 } }
`;
    const result = await runScenario(parseScenario(yaml), new FakeSut());
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("assert_stocker");
    expect(result.failure).toContain("expected 5");
    // steps after the failing one do not run
    expect(result.steps.at(-1)!.ok).toBe(false);
  });

  test("a wait_until that never resolves fails with a timeout", async () => {
    const yaml = `
name: wait timeout
setup:
  jobs: [{ id: plateA }]
steps:
  - upload: plateA
  - wait_until: { job: plateA, state: printing, timeout_ms: 100 }
`;
    const result = await runScenario(parseScenario(yaml), new FakeSut());
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("timeout");
  });

  test("a failing expect invariant marks the run failed", async () => {
    // Seed the stocker below zero so INV-STOCKER-01 (remaining >= 0) is violated.
    const yaml = `
name: negative stocker
setup:
  jobs: [{ id: A }]
  stocker: { capacity: 1, remaining: -1 }
expect:
  - INV-STOCKER-01: "remaining >= 0"
`;
    const result = await runScenario(parseScenario(yaml), new FakeSut());
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("INV-STOCKER-01");
    expect(result.expects[0]).toEqual({ invariant: "INV-STOCKER-01", ok: false, detail: "remaining=-1" });
  });
});
