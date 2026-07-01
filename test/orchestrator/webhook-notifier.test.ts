import { describe, expect, test } from "bun:test";
import { WebhookNotifier } from "../../src/orchestrator/webhook-notifier.ts";
import type { NotifyEvent } from "../../src/core/ports.ts";

function capture() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("ok");
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const WEBHOOK = "https://discord.test/webhook/abc";

describe("WebhookNotifier (spec 15)", () => {
  test("POSTs an embed with title + message to the webhook url", async () => {
    const { calls, fetchImpl } = capture();
    const n = new WebhookNotifier({ url: WEBHOOK, fetchImpl });
    await n.send({ type: "job_failed", jobId: 12, message: "HMS 0x0C000001" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK);
    const embed = calls[0]!.body.embeds[0];
    expect(embed.title).toContain("失敗");
    expect(embed.description).toBe("HMS 0x0C000001");
  });

  test("includes a deep link to the job/project (INV-PENDING-04)", async () => {
    const { calls, fetchImpl } = capture();
    const n = new WebhookNotifier({ url: WEBHOOK, baseUrl: "https://host:3000", fetchImpl });
    await n.send({ type: "pending_action", jobId: 7, severity: "blocking_job", message: "color_decision" });
    expect(calls[0]!.body.embeds[0].url).toBe("https://host:3000/queue/7");

    await n.send({ type: "pending_action", projectId: 3, message: "x" });
    expect(calls[1]!.body.embeds[0].url).toBe("https://host:3000/projects/3");
  });

  test("omits the deep link when no baseUrl is configured", async () => {
    const { calls, fetchImpl } = capture();
    await new WebhookNotifier({ url: WEBHOOK, fetchImpl }).send({ type: "job_finished", jobId: 1 });
    expect(calls[0]!.body.embeds[0].url).toBeUndefined();
  });

  test("notify() is fire-and-forget: a rejecting webhook never throws (best-effort)", () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const n = new WebhookNotifier({ url: WEBHOOK, fetchImpl: failing });
    expect(() => n.notify({ type: "job_finished", jobId: 1 })).not.toThrow();
  });

  test("timeout guard aborts a hung webhook (INV-NOTIFY-02)", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    const n = new WebhookNotifier({ url: WEBHOOK, fetchImpl: hang, timeoutMs: 20 });

    let aborted = false;
    try {
      await n.send({ type: "job_finished", jobId: 1 });
    } catch (e) {
      aborted = (e as Error).message === "aborted";
    }
    expect(aborted).toBe(true);
  });
});
