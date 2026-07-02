import type { Notifier, NotifyEvent } from "../core/ports.ts";

// Discord/Slack Incoming Webhook notifier (spec 15). A concrete Notifier adapter
// that POSTs an embed for each event. notify() is fire-and-forget with a timeout
// guard so a slow/hung webhook never blocks or throws into the dispatcher
// (INV-NOTIFY-02); the payload carries a deep link to the job/project when known
// (INV-PENDING-04).

export interface WebhookOptions {
  url: string;
  /** base URL for deep links, e.g. "https://host:3000" */
  baseUrl?: string;
  /** POST timeout, ms (default 5000) */
  timeoutMs?: number;
  /** injectable fetch for tests */
  fetchImpl?: typeof fetch;
}

const TITLES: Record<NotifyEvent["type"], string> = {
  job_started: "▶️ 印刷開始",
  job_finished: "✅ 完了",
  job_failed: "❌ 失敗",
  aborted: "🛑 中止",
  stocker_low: "🟡 ビルドプレート残りわずか",
  waiting_for_refill: "🪧 ストッカー補充",
  pending_action: "⚠️ 対応待ち",
  filament_switched: "ℹ️ フィラメント自動切替",
  timeout: "⏱️ タイムアウト",
};

export class WebhookNotifier implements Notifier {
  constructor(private readonly opts: WebhookOptions) {}

  /** Port method: fire-and-forget, never throws. */
  notify(event: NotifyEvent): void {
    void this.send(event).catch(() => {
      // best-effort; a webhook failure must not affect the run
    });
  }

  /** Awaitable POST with a timeout guard. Public so tests can assert on it. */
  async send(event: NotifyEvent): Promise<void> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5000);
    try {
      await doFetch(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.buildPayload(event)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Awaitable multipart POST attaching a JPEG to the embed (spec 13: 通知に
   * カメラスナップショットを直接添付). Discord webhooks take `payload_json`
   * plus `files[N]` parts; the embed references the upload via
   * `attachment://<filename>`. Same timeout guard as send(); never used on the
   * hot notify() path directly — callers decide when a photo is warranted.
   */
  async sendWithPhoto(event: NotifyEvent, jpeg: Buffer, filename = "snapshot.jpg"): Promise<void> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const payload = this.buildPayload(event) as { embeds: Array<Record<string, unknown>> };
      payload.embeds[0]!.image = { url: `attachment://${filename}` };
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), filename);
      // NOTE: no content-type header — fetch sets the multipart boundary itself.
      await doFetch(this.opts.url, { method: "POST", body: form, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  buildPayload(event: NotifyEvent): unknown {
    const url = this.deepLink(event);
    return {
      embeds: [
        {
          title: TITLES[event.type] ?? event.type,
          description: event.message ?? event.type,
          ...(url ? { url } : {}),
        },
      ],
    };
  }

  /** Deep link to the related job/project (INV-PENDING-04). */
  private deepLink(event: NotifyEvent): string | undefined {
    if (!this.opts.baseUrl) return undefined;
    if (event.jobId != null) return `${this.opts.baseUrl}/queue/${event.jobId}`;
    if (event.projectId != null) return `${this.opts.baseUrl}/projects/${event.projectId}`;
    return undefined;
  }
}
