import { describe, expect, test } from "bun:test";
import {
  shouldEmitUploadProgress,
  throttleUploadProgress,
} from "../../src/orchestrator/upload-progress-throttle.ts";

describe("shouldEmitUploadProgress (pure decision)", () => {
  test("the first sample (lastSentAt === null) is always sent", () => {
    expect(shouldEmitUploadProgress(1_000, null, 1_000, 100_000)).toBe(true);
    // even at time 0 with zero bytes sent
    expect(shouldEmitUploadProgress(0, null, 0, 100_000)).toBe(true);
  });

  test("a sample less than intervalMs after the last sent is suppressed", () => {
    expect(shouldEmitUploadProgress(1_100, 1_000, 2_000, 100_000, 150)).toBe(false);
    expect(shouldEmitUploadProgress(1_149, 1_000, 2_000, 100_000, 150)).toBe(false);
  });

  test("a sample at/after intervalMs since the last sent is allowed", () => {
    expect(shouldEmitUploadProgress(1_150, 1_000, 2_000, 100_000, 150)).toBe(true);
    expect(shouldEmitUploadProgress(2_000, 1_000, 2_000, 100_000, 150)).toBe(true);
  });

  test("completion (bytesSent >= totalBytes) is always sent, even mid-interval", () => {
    expect(shouldEmitUploadProgress(1_050, 1_000, 100_000, 100_000, 150)).toBe(true);
    // an over-shoot bytesSent (defensive) still counts as complete
    expect(shouldEmitUploadProgress(1_050, 1_000, 100_001, 100_000, 150)).toBe(true);
  });

  test("default intervalMs is 150ms when not specified", () => {
    expect(shouldEmitUploadProgress(1_149, 1_000, 2_000, 100_000)).toBe(false);
    expect(shouldEmitUploadProgress(1_150, 1_000, 2_000, 100_000)).toBe(true);
  });
});

describe("throttleUploadProgress (Clock-injected wrapper)", () => {
  test("forwards the first sample, suppresses a too-soon one, forwards after the interval, and always forwards completion", () => {
    let now = 0;
    const clock = { now: () => now };
    const sent: Array<{ bytesSent: number; totalBytes: number }> = [];
    const wrapped = throttleUploadProgress((p) => sent.push(p), clock);

    wrapped({ bytesSent: 1_000, totalBytes: 100_000 }); // first — sent
    now = 50;
    wrapped({ bytesSent: 2_000, totalBytes: 100_000 }); // +50ms — suppressed
    now = 200;
    wrapped({ bytesSent: 3_000, totalBytes: 100_000 }); // +200ms since last sent — sent
    now = 210;
    wrapped({ bytesSent: 100_000, totalBytes: 100_000 }); // completion — always sent

    expect(sent).toEqual([
      { bytesSent: 1_000, totalBytes: 100_000 },
      { bytesSent: 3_000, totalBytes: 100_000 },
      { bytesSent: 100_000, totalBytes: 100_000 },
    ]);
  });

  test("a fresh call to the factory starts with no lastSentAt (does not inherit state)", () => {
    let now = 1_000;
    const clock = { now: () => now };
    const sentA: unknown[] = [];
    const sentB: unknown[] = [];

    const a = throttleUploadProgress((p) => sentA.push(p), clock);
    a({ bytesSent: 1, totalBytes: 100 });

    // a second transfer's throttle, created moments later, still sends its own first sample
    now = 1_010;
    const b = throttleUploadProgress((p) => sentB.push(p), clock);
    b({ bytesSent: 1, totalBytes: 100 });

    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(1);
  });
});
