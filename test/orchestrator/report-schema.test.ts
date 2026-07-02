// Boundary schema for MQTT push_status (spec 9). Replaces the previous blind
// `p.hms as Array<{attr,code}>` cast: malformed hms degrades to [], and
// non-numeric progress fields degrade to 0 instead of leaking NaN.
import { describe, expect, test } from "bun:test";
import { pushStatusSchema } from "../../src/orchestrator/report-schema.ts";

describe("pushStatusSchema", () => {
  test("parses a normal push_status subset", () => {
    const r = pushStatusSchema.parse({
      gcode_state: "RUNNING",
      mc_remaining_time: 42,
      mc_percent: 37,
      subtask_name: "job-7",
      layer_num: 12,
      total_layer_num: 73,
      hms: [{ attr: 50331904, code: 65543 }],
    });
    expect(r).toEqual({
      gcode_state: "RUNNING",
      mc_remaining_time: 42,
      mc_percent: 37,
      subtask_name: "job-7",
      layer_num: 12,
      total_layer_num: 73,
      hms: [{ attr: 50331904, code: 65543 }],
    });
  });

  test("missing optional fields take safe defaults", () => {
    const r = pushStatusSchema.parse({ gcode_state: "FINISH" });
    expect(r.mc_remaining_time).toBe(0);
    expect(r.mc_percent).toBe(0);
    expect(r.subtask_name).toBe("");
    expect(r.layer_num).toBe(0); // no slice metadata (e.g. dry-rehearsal 3mf)
    expect(r.total_layer_num).toBe(0);
    expect(r.hms).toEqual([]);
  });

  test("numeric strings from the wire are coerced (mc_print_stage-style string ints)", () => {
    const r = pushStatusSchema.parse({ gcode_state: "RUNNING", mc_remaining_time: "17", mc_percent: "50" });
    expect(r.mc_remaining_time).toBe(17);
    expect(r.mc_percent).toBe(50);
  });

  test("non-numeric progress degrades to 0 — NaN never propagates to ETA math", () => {
    const r = pushStatusSchema.parse({ gcode_state: "RUNNING", mc_remaining_time: "soon", mc_percent: {} });
    expect(r.mc_remaining_time).toBe(0);
    expect(r.mc_percent).toBe(0);
  });

  test("malformed hms degrades to [] instead of leaking junk objects (was: blind cast)", () => {
    expect(pushStatusSchema.parse({ gcode_state: "RUNNING", hms: "error!" }).hms).toEqual([]);
    expect(pushStatusSchema.parse({ gcode_state: "RUNNING", hms: [{ bogus: true }] }).hms).toEqual([]);
    expect(pushStatusSchema.parse({ gcode_state: "RUNNING", hms: [null] }).hms).toEqual([]);
  });

  test("hms entries with numeric-string attr/code are coerced to numbers", () => {
    const r = pushStatusSchema.parse({ gcode_state: "RUNNING", hms: [{ attr: "1", code: "2" }] });
    expect(r.hms).toEqual([{ attr: 1, code: 2 }]);
  });

  test("gcode_state is stringified (firmware variance) and numeric states survive", () => {
    expect(pushStatusSchema.parse({ gcode_state: "PAUSE" }).gcode_state).toBe("PAUSE");
    expect(pushStatusSchema.parse({ gcode_state: 2 }).gcode_state).toBe("2");
  });
});
