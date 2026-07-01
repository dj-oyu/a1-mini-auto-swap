import { VirtualPrinter } from "./virtual-printer.ts";

/**
 * Drives a running print forward in real (compressed) time. Used ONLY by the
 * live stub process (main.ts); tests never attach a Ticker — they call tick()/
 * forceFinish() explicitly so timing never leaks into CI (scenarios/README.md).
 */
export class Ticker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly printer: VirtualPrinter) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.printer.state === "RUNNING") this.printer.tick();
      this.schedule();
    }, this.printer.tickIntervalMs);
  }
}
