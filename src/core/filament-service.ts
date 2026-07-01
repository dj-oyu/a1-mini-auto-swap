import type { AmsProvider, Notifier, PrinterPort, QueueStore } from "./ports.ts";
import { resolveRunout, type RunoutPolicy } from "./runout.ts";

export interface FilamentServiceOptions {
  /** MIN_THRESHOLD_G — slots at/below this are not viable alternates. */
  minThresholdG?: number;
  notifier?: Notifier;
}

/**
 * Applies the filament-runout decision (spec 14) when a runout is detected on a
 * printing job: either resume on an alternate slot (recording a substitution if
 * the color differs) or escalate to a filament_runout pending action. The pure
 * choice is resolveRunout; this wires it to store/printer/notifier.
 *
 * The color-consistency consequence of a substitution is handled later, at plate
 * FINISH (dispatcher.onFinished), from the recorded substituted_color.
 */
export class FilamentService {
  private readonly minThresholdG: number;
  private readonly notifier?: Notifier;

  constructor(
    private readonly store: QueueStore,
    private readonly ams: AmsProvider,
    private readonly printer: PrinterPort,
    opts: FilamentServiceOptions = {},
  ) {
    this.minThresholdG = opts.minThresholdG ?? 0;
    this.notifier = opts.notifier;
  }

  async onRunout(jobId: number, runoutSlot: number): Promise<void> {
    const job = this.store.getJob(jobId);
    const policy = effectivePolicy(
      job?.filament_runout_policy_override ?? this.store.getSetting("filament_runout_policy"),
    );

    const resolution = resolveRunout({
      policy,
      runoutSlot,
      trays: this.ams.getTrays(),
      minThresholdG: this.minThresholdG,
    });

    if (resolution.kind === "pending") {
      this.store.createPendingAction({
        type: "filament_runout",
        severity: "blocking_job",
        job_id: jobId,
        message: resolution.reason,
      });
      this.notifier?.notify({
        type: "pending_action",
        jobId,
        severity: "blocking_job",
        message: "filament_runout",
      });
      return;
    }

    await this.printer.resumeWithAlternateSlot(jobId, resolution.toSlot);
    if (resolution.substitutedColor != null) {
      this.store.setSubstitution(jobId, resolution.toSlot, resolution.substitutedColor); // INV-RUNOUT-06
    }
    this.notifier?.notify({
      type: "filament_switched",
      jobId,
      severity: "advisory",
      message: resolution.substitutedColor
        ? `スロット${runoutSlot}切れ→スロット${resolution.toSlot}(代替色 ${resolution.substitutedColor})`
        : `スロット${runoutSlot}切れ→スロット${resolution.toSlot}`,
    });
  }
}

function effectivePolicy(v: string | null | undefined): RunoutPolicy {
  return v === "same_color_only" || v === "allow_material_match" ? v : "manual";
}
