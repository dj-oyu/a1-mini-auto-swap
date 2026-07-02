import { describe, expect, test } from "bun:test";
import {
  MqttPublisherClient,
  PrintfarmGateway,
  TOPICS,
  type MqttPublisher,
  type ProgressView,
  type QueueJobView,
} from "../../src/orchestrator/gateway.ts";
import type { Clock } from "../../src/core/ports.ts";
import { createLogger } from "../../src/obs/logger.ts";
import { MemorySink } from "../../src/obs/sinks.ts";

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cond()) return resolve();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      }
    }, 15);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error("waitFor timed out"));
    }, ms);
  });
}

class FakePublisher implements MqttPublisher {
  msgs: Array<{ topic: string; payload: any; retain: boolean }> = [];
  publish(topic: string, payload: string, opts?: { retain?: boolean }): void {
    this.msgs.push({ topic, payload: JSON.parse(payload), retain: opts?.retain ?? false });
  }
  last() {
    return this.msgs.at(-1)!;
  }
}
const clock: Clock = { now: () => 1_700_000_000_000 };

const JOB: QueueJobView = {
  id: 12,
  filename: "plate_03.gcode.3mf",
  status: "printing",
  project: "myproj",
  position: 1,
  attempts: 0,
  eta_epoch_ms: 1_700_000_600_000,
  substituted: false,
};

describe("PrintfarmGateway (spec 16, Tab5 contract)", () => {
  test("publishQueue → printfarm/queue retained, with stamped updated_at", () => {
    const pub = new FakePublisher();
    new PrintfarmGateway(pub, clock).publishQueue({ jobs: [JOB], stocker: { remaining: 7, capacity: 10 } });
    const m = pub.last();
    expect(m.topic).toBe(TOPICS.queue);
    expect(m.retain).toBe(true);
    expect(m.payload.jobs[0].filename).toBe("plate_03.gcode.3mf");
    expect(m.payload.stocker).toEqual({ remaining: 7, capacity: 10 });
    expect(m.payload.updated_at).toBe(1_700_000_000_000);
  });

  test("publishJobStatus → printfarm/queue/{id}/status retained", () => {
    const pub = new FakePublisher();
    new PrintfarmGateway(pub, clock).publishJobStatus(JOB);
    const m = pub.last();
    expect(m.topic).toBe("printfarm/queue/12/status");
    expect(m.retain).toBe(true);
    expect(m.payload).toEqual(JOB);
  });

  test("publishProgress → printfarm/current/progress retained, contract fields", () => {
    const pub = new FakePublisher();
    const progress: ProgressView = {
      job_id: 12,
      subtask_name: "plate_03.gcode.3mf",
      gcode_state: "RUNNING",
      percent: 42,
      layer: 88,
      total_layer: 210,
      remaining_min: 63,
      eta_epoch_ms: 1_700_000_600_000,
      project_eta_epoch_ms: 1_700_000_900_000,
    };
    new PrintfarmGateway(pub, clock).publishProgress(progress);
    const m = pub.last();
    expect(m.topic).toBe(TOPICS.progress);
    expect(m.retain).toBe(true);
    expect(m.payload).toEqual(progress);
  });

  test("notify → printfarm/event non-retained one-shot with ts", () => {
    const pub = new FakePublisher();
    new PrintfarmGateway(pub, clock).notify({
      type: "job_finished",
      jobId: 12,
      message: "✅ 完了",
    });
    const m = pub.last();
    expect(m.topic).toBe(TOPICS.event);
    expect(m.retain).toBe(false);
    expect(m.payload).toMatchObject({ type: "job_finished", job_id: 12, message: "✅ 完了", ts: 1_700_000_000_000 });
  });
});

describe("MqttPublisherClient (no broker present, Windows-dev-box robustness)", () => {
  test("connecting to an unreachable broker does not crash the process (error is handled, logged, rate-limited)", async () => {
    // Capture the gateway's own structured log (not console): inject a Logger
    // backed by a MemorySink so we assert on the written records.
    const mem = new MemorySink();
    const logger = createLogger({ level: "warn", sinks: [mem], clock });
    const warnings = () => mem.records().filter((r) => r.level === "warn");
    // Port with nothing listening: connection is refused immediately, which
    // used to emit an unhandled 'error' and crash the whole process.
    const client = new MqttPublisherClient("mqtt://127.0.0.1:59991", { logger });
    try {
      // Reaching this point at all (vs. the process dying) is the main
      // assertion; also confirm the failure was logged exactly once even
      // though mqtt.js will keep retrying (reconnectPeriod: 1000ms).
      await waitFor(() => warnings().length >= 1);
      expect(warnings()[0]!.msg).toContain("mqtt connection error");
      expect(warnings()[0]!.event).toBe("gateway_mqtt_error");
      // Let a second reconnect attempt (reconnectPeriod: 1000ms) land before
      // asserting it was suppressed — this is real elapsed time by necessity
      // (verifying a time-based rate limit), kept to the minimum needed.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(warnings().length).toBe(1); // suppressed: same error within the log interval
    } finally {
      await client.close();
    }
  }, 5000);
});
