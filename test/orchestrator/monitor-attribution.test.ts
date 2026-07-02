// Monitor must attribute a FINISH/FAILED report STRICTLY by the job-{id}.
// subtask prefix. A non-queue artifact (eject / dry-rehearsal) whose terminal
// report arrives while a real job is 'printing' must NOT be misattributed to
// that job (審 2026-07-02: the old `?? printing[0]` fallback fired onFinished
// on an unrelated print → bad stocker accounting + false completion).
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Monitor } from "../../src/orchestrator/monitor.ts";
import type { PrinterStatus } from "../../src/orchestrator/mqtt-client.ts";

function status(gcodeState: string, subtaskName: string): PrinterStatus {
  return { gcodeState, subtaskName, mcRemainingTime: 0, mcPercent: 0, layerNum: 0, totalLayerNum: 0, hms: [] };
}

function harness(printingIds: number[]) {
  const client = new EventEmitter();
  const store = { listByStatus: (s: string) => (s === "printing" ? printingIds.map((id) => ({ id })) : []) };
  const calls: Array<{ fn: string; id: number }> = [];
  const dispatcher = {
    onFinished: async (id: number) => void calls.push({ fn: "onFinished", id }),
    onFailed: async (id: number) => void calls.push({ fn: "onFailed", id }),
  };
  const monitor = new Monitor(client as never, store as never, dispatcher as never);
  monitor.start();
  const emit = async (s: PrinterStatus) => {
    client.emit("status", s);
    await new Promise((r) => setTimeout(r, 0)); // let the serialized chain run
  };
  return { emit, calls, monitor };
}

describe("Monitor attribution (strict job-{id}. prefix)", () => {
  test("a matching job's FINISH completes that job", async () => {
    const h = harness([7]);
    await h.emit(status("FINISH", "job-7.gcode.3mf"));
    expect(h.calls).toEqual([{ fn: "onFinished", id: 7 }]);
  });

  test("an eject FINISH does NOT complete an unrelated printing job", async () => {
    const h = harness([7]); // job 7 is printing (a real queue job)
    await h.emit(status("FINISH", "eject.gcode.3mf")); // eject's terminal report
    expect(h.calls).toEqual([]); // job 7 is NOT touched
  });

  test("a dry-rehearsal FAILED does NOT fail an unrelated printing job", async () => {
    const h = harness([7]);
    await h.emit(status("FAILED", "dry-rehearsal.gcode.3mf"));
    expect(h.calls).toEqual([]);
  });

  test("picks the right job when several are (defensively) printing", async () => {
    const h = harness([5, 8]);
    await h.emit(status("FINISH", "job-8.gcode.3mf"));
    expect(h.calls).toEqual([{ fn: "onFinished", id: 8 }]);
  });
});
