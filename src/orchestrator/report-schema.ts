import { z } from "zod";

/**
 * Boundary schema for the printer's `push_status` report (spec 9,
 * docs/bambu-protocol-notes.md). The wire shape varies by firmware, so scalar
 * fields coerce with safe fallbacks — but unlike the previous blind
 * `as Array<{attr, code}>` cast, `hms` entries are actually validated:
 * a malformed hms array degrades to [] instead of leaking junk objects
 * into the monitor/notification path. NaN from a non-numeric
 * mc_remaining_time/mc_percent also degrades to 0 (Number() used to pass
 * NaN straight through).
 */
export const pushStatusSchema = z.object({
  gcode_state: z.coerce.string().catch(""),
  mc_remaining_time: z.coerce.number().catch(0).default(0),
  mc_percent: z.coerce.number().catch(0).default(0),
  subtask_name: z.coerce.string().catch("").default(""),
  layer_num: z.coerce.number().catch(0).default(0),
  total_layer_num: z.coerce.number().catch(0).default(0),
  hms: z
    .array(z.object({ attr: z.coerce.number().int(), code: z.coerce.number().int() }))
    .catch([])
    .default([]),
});

export type PushStatus = z.infer<typeof pushStatusSchema>;
