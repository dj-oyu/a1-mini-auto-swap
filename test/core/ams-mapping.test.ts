// INV-MQTT-01: ams_mapping is always exactly 4 entries of -1..3. parseAmsMapping
// guards the DB→dispatch boundary: null degrades to all-unused, corruption throws
// (a 5-element mapping silently becomes an external-spool print on the firmware).
import { describe, expect, test } from "bun:test";
import { EMPTY_AMS_MAPPING, isValidAmsMapping, parseAmsMapping } from "../../src/core/ams-mapping.ts";

describe("isValidAmsMapping (INV-MQTT-01)", () => {
  test("accepts exactly 4 integers in -1..3", () => {
    expect(isValidAmsMapping([-1, -1, 0, -1])).toBe(true);
    expect(isValidAmsMapping([0, 1, 2, 3])).toBe(true);
    expect(isValidAmsMapping([-1, -1, -1, -1])).toBe(true);
  });

  test("rejects wrong lengths — the 5-element firmware trap included", () => {
    expect(isValidAmsMapping([])).toBe(false);
    expect(isValidAmsMapping([0, 1, 2])).toBe(false);
    expect(isValidAmsMapping([-1, -1, 0, -1, -1])).toBe(false); // spec 9 trap
  });

  test("rejects out-of-range and non-integer entries", () => {
    expect(isValidAmsMapping([4, -1, -1, -1])).toBe(false);
    expect(isValidAmsMapping([-2, -1, -1, -1])).toBe(false);
    expect(isValidAmsMapping([0.5, -1, -1, -1])).toBe(false);
    expect(isValidAmsMapping(["0", -1, -1, -1])).toBe(false);
  });

  test("rejects non-arrays", () => {
    expect(isValidAmsMapping(null)).toBe(false);
    expect(isValidAmsMapping("[-1,-1,0,-1]")).toBe(false);
    expect(isValidAmsMapping({ 0: -1, length: 4 })).toBe(false);
  });
});

describe("parseAmsMapping (DB jobs.ams_mapping column)", () => {
  test("null/undefined => all-unused mapping (no plan confirmed yet)", () => {
    expect(parseAmsMapping(null)).toEqual([...EMPTY_AMS_MAPPING]);
    expect(parseAmsMapping(undefined)).toEqual([-1, -1, -1, -1]);
  });

  test("valid JSON mapping parses to the same values", () => {
    expect(parseAmsMapping("[-1,-1,0,-1]")).toEqual([-1, -1, 0, -1]);
  });

  test("corrupt JSON throws instead of silently degrading", () => {
    expect(() => parseAmsMapping("not json")).toThrow(/not valid JSON/);
  });

  test("valid JSON but invalid mapping throws with the INV id in the message", () => {
    expect(() => parseAmsMapping("[-1,-1,0,-1,-1]")).toThrow(/INV-MQTT-01/); // 5 elements
    expect(() => parseAmsMapping("[9,9,9,9]")).toThrow(/INV-MQTT-01/);
    expect(() => parseAmsMapping('{"a":1}')).toThrow(/INV-MQTT-01/);
  });

  test("returns a fresh array (callers may mutate without corrupting the shared EMPTY constant)", () => {
    const a = parseAmsMapping(null);
    a[0] = 3;
    expect(parseAmsMapping(null)).toEqual([-1, -1, -1, -1]);
  });
});
