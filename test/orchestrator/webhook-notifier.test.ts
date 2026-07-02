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

// spec 13: 通知にカメラスナップショットを直接添付 — multipart photo attachment.
describe("WebhookNotifier.sendWithPhoto", () => {
  test("POSTs multipart form-data: payload_json embed references attachment://, file part carries the JPEG", async () => {
    const forms: FormData[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      forms.push(init.body as FormData);
      return new Response("ok");
    }) as unknown as typeof fetch;

    const n = new WebhookNotifier({ url: WEBHOOK, baseUrl: "http://host:3000", fetchImpl });
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    await n.sendWithPhoto({ type: "job_finished", jobId: 7, message: "plate done" }, jpeg, "preswap.jpg");

    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form).toBeInstanceOf(FormData);

    const payload = JSON.parse(String(form.get("payload_json")));
    expect(payload.embeds[0].title).toContain("完了");
    expect(payload.embeds[0].description).toBe("plate done");
    expect(payload.embeds[0].image).toEqual({ url: "attachment://preswap.jpg" });
    expect(payload.embeds[0].url).toBe("http://host:3000/queue/7"); // deep link kept

    const file = form.get("files[0]") as File;
    expect(file).not.toBeNull();
    expect(file.name).toBe("preswap.jpg");
    expect(file.type).toBe("image/jpeg");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.equals(jpeg)).toBe(true);
  });

  test("propagates a failed POST as a rejection (callers decide how to degrade)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const n = new WebhookNotifier({ url: WEBHOOK, fetchImpl });
    let failed = false;
    try {
      await n.sendWithPhoto({ type: "job_finished" }, Buffer.from("x"));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
