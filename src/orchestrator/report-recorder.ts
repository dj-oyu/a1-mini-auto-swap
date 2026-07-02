import type { Clock } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";
import { RotatingFileSink } from "../obs/sinks.ts";
import type { ReportSource } from "./state-log.ts";

// Raw report recorder (obs stream 3): investigation-only, HIGH VOLUME. When
// MQTT_LOG=1, every push_status raw print-block is appended verbatim to
// data/mqtt-log/YYYY-MM-DD.jsonl as { ts, ...raw }. This is the firehose you
// turn on to debug a protocol quirk (a mis-parsed field, an AMS diff sequence)
// and turn OFF again — it grows fast. It reuses the SINGLE MQTT connection (the
// `report` event the mqtt-client already emits); it never opens a second one.
//
// No redaction is applied: a push_status report carries no secrets (no access
// code / token / webhook) — only printer state, temps, and AMS filament data.

export interface ReportRecorderOptions {
  /** Directory for the daily raw dumps (default ./data/mqtt-log). */
  dir?: string;
  clock?: Clock;
  /** Prune dumps older than this many days on rollover (default 14). */
  retentionDays?: number;
}

export class ReportRecorder {
  private readonly sink: RotatingFileSink;
  private readonly clock: Clock;
  private readonly onReport = (raw: Record<string, unknown>) => this.record(raw);

  constructor(
    private readonly source: ReportSource,
    opts: ReportRecorderOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.sink = new RotatingFileSink({
      dir: opts.dir ?? "./data/mqtt-log",
      prefix: "", // filename is just YYYY-MM-DD.jsonl
      clock: this.clock,
      retentionDays: opts.retentionDays ?? 14,
    });
  }

  start(): void {
    this.source.on("report", this.onReport);
  }

  stop(): void {
    this.source.off("report", this.onReport);
  }

  private record(raw: Record<string, unknown>): void {
    this.sink.write(JSON.stringify({ ts: this.clock.now(), ...raw }) + "\n");
  }
}
