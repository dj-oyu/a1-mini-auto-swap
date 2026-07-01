import type { Scenario, Step } from "./types.ts";
import type { Sut } from "./sut.ts";

export interface StepLog {
  index: number;
  kind: Step["kind"];
  ok: boolean;
  detail?: string;
}

export interface ExpectLog {
  invariant: string;
  ok: boolean;
  detail?: string;
}

export interface RunResult {
  scenario: string;
  ok: boolean;
  steps: StepLog[];
  expects: ExpectLog[];
  failure?: string;
}

/**
 * Execute a parsed scenario against a Sut. Never throws — the outcome (incl.
 * the first failing step/expect) is returned as a RunResult. Steps run in
 * order; the run stops at the first failing step, then `expect` invariants are
 * evaluated only if all steps passed.
 */
export async function runScenario(scenario: Scenario, sut: Sut): Promise<RunResult> {
  const steps: StepLog[] = [];
  const expects: ExpectLog[] = [];
  let ok = true;
  let failure: string | undefined;

  try {
    await sut.setup(scenario.setup);

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!;
      try {
        const detail = await execStep(step, sut);
        steps.push({ index: i, kind: step.kind, ok: true, detail });
      } catch (e) {
        ok = false;
        failure = `step #${i} (${step.kind}): ${(e as Error).message}`;
        steps.push({ index: i, kind: step.kind, ok: false, detail: (e as Error).message });
        break;
      }
    }

    if (ok) {
      for (const ex of scenario.expect) {
        const r = await sut.checkInvariant(ex.invariant);
        expects.push({ invariant: ex.invariant, ok: r.ok, detail: r.detail });
        if (!r.ok) {
          ok = false;
          failure ??= `expect ${ex.invariant} failed: ${r.detail ?? ""}`;
        }
      }
    }
  } catch (e) {
    ok = false;
    failure = `setup: ${(e as Error).message}`;
  } finally {
    await sut.teardown();
  }

  return { scenario: scenario.name, ok, steps, expects, failure };
}

async function execStep(step: Step, sut: Sut): Promise<string | undefined> {
  switch (step.kind) {
    case "upload":
      await sut.upload(step.job);
      return;
    case "confirm_filaments":
      await sut.confirmFilaments(step.job);
      return;
    case "dispatch_all":
      await sut.dispatchAll();
      return;
    case "control":
      await sut.control(step.method, step.path, step.body);
      return;
    case "resolve_pending":
      await sut.resolvePending(step.type);
      return;
    case "retry":
      await sut.retry(step.job);
      return;
    case "refill_stocker":
      await sut.refillStocker();
      return;
    case "finish_current":
      await sut.finishCurrent();
      return;

    case "wait_job":
      await waitFor(
        async () => (await sut.jobState(step.job)) === step.state,
        step.timeoutMs,
        `job ${step.job} did not reach state '${step.state}'`,
      );
      return;
    case "wait_pending":
      await waitFor(
        async () => (await sut.pendingActionExists(step.type)) === step.exists,
        step.timeoutMs,
        `pending_action '${step.type}' exists!=${step.exists}`,
      );
      return;

    case "assert_job": {
      const s = await sut.jobState(step.job);
      if (s !== step.state) throw new Error(`job ${step.job} is '${s}', expected '${step.state}'`);
      return `${step.job}=${s}`;
    }
    case "assert_stocker": {
      const r = await sut.stockerRemaining();
      if (r !== step.remaining) throw new Error(`stocker.remaining is ${r}, expected ${step.remaining}`);
      return `remaining=${r}`;
    }
    case "assert_pending": {
      const e = await sut.pendingActionExists(step.type);
      if (e !== step.exists) throw new Error(`pending_action '${step.type}' exists=${e}, expected ${step.exists}`);
      return;
    }
    case "assert_invariant": {
      const r = await sut.checkInvariant(step.id);
      if (!r.ok) throw new Error(`invariant ${step.id} violated: ${r.detail ?? ""}`);
      return step.id;
    }
    case "assert_printing_count": {
      const c = await sut.printingCount();
      if (c !== step.count) throw new Error(`printing_count is ${c}, expected ${step.count}`);
      return `printing=${c}`;
    }
    default: {
      const _exhaustive: never = step;
      throw new Error(`unhandled step: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, msg: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${msg} (timeout ${timeoutMs}ms)`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
