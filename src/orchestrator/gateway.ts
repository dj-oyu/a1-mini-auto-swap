import mqtt, { type MqttClient } from "mqtt";
import type { Clock, Notifier, NotifyEvent } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";

// Self-hosted Mosquitto republish gateway (spec 16). Normalizes orchestrator
// state to the `printfarm/*` topics that the Tab5 monitor subscribes to (see
// docs/m5stack-tab5-frontend-research.md §5 for the payload contract). Queue /
// per-job / progress are RETAINED so a device gets the latest snapshot the
// instant it subscribes; events are non-retained one-shot triggers.

export const TOPICS = {
  queue: "printfarm/queue",
  progress: "printfarm/current/progress",
  event: "printfarm/event",
  jobStatus: (id: number) => `printfarm/queue/${id}/status`,
} as const;

/** Publish transport, so the gateway is testable without a live broker. */
export interface MqttPublisher {
  publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
}

export interface QueueJobView {
  id: number;
  filename: string;
  status: string;
  project: string | null;
  position: number | null;
  attempts: number;
  eta_epoch_ms: number | null;
  substituted: boolean;
}

export interface QueueSnapshot {
  jobs: QueueJobView[];
  stocker: { remaining: number; capacity: number };
}

export interface ProgressView {
  job_id: number;
  subtask_name: string;
  gcode_state: string;
  percent: number;
  layer: number;
  total_layer: number;
  remaining_min: number;
  eta_epoch_ms: number | null;
  project_eta_epoch_ms: number | null;
}

export class PrintfarmGateway implements Notifier {
  constructor(
    private readonly pub: MqttPublisher,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Full queue snapshot (retained). */
  publishQueue(snapshot: QueueSnapshot): void {
    this.pub.publish(TOPICS.queue, JSON.stringify({ ...snapshot, updated_at: this.clock.now() }), {
      retain: true,
    });
  }

  /** Per-job status (retained). */
  publishJobStatus(job: QueueJobView): void {
    this.pub.publish(TOPICS.jobStatus(job.id), JSON.stringify(job), { retain: true });
  }

  /** Current-print progress (retained). */
  publishProgress(progress: ProgressView): void {
    this.pub.publish(TOPICS.progress, JSON.stringify(progress), { retain: true });
  }

  /** Notifier port: one-shot events (non-retained) for IoT/Tab5 (spec 16). */
  notify(event: NotifyEvent): void {
    this.pub.publish(
      TOPICS.event,
      JSON.stringify({
        type: event.type,
        job_id: event.jobId ?? null,
        project_id: event.projectId ?? null,
        severity: event.severity ?? null,
        message: event.message ?? null,
        ts: this.clock.now(),
      }),
      { retain: false },
    );
  }
}

/** Real MqttPublisher over the self-hosted Mosquitto broker. */
export class MqttPublisherClient implements MqttPublisher {
  private readonly conn: MqttClient;
  constructor(url: string, opts: { username?: string; password?: string } = {}) {
    this.conn = mqtt.connect(url, {
      username: opts.username,
      password: opts.password,
      reconnectPeriod: 1000,
    });
  }
  publish(topic: string, payload: string, opts?: { retain?: boolean }): void {
    this.conn.publish(topic, payload, { qos: 0, retain: opts?.retain ?? false });
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.conn.end(true, {}, () => resolve()));
  }
}
