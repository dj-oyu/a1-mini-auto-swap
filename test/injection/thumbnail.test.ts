import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { extractThumbnail } from "../../src/injection/threemf.ts";

const PNG = strToU8("\x89PNG\r\n\x1a\n-fake-plate-render");

describe("extractThumbnail", () => {
  test("returns the plate render PNG bytes", () => {
    const buf = Buffer.from(
      zipSync({
        "Metadata/plate_1.png": PNG,
        "Metadata/project_settings.config": strToU8("{}"),
      }),
    );
    const out = extractThumbnail(buf);
    expect(out).not.toBeNull();
    expect(Buffer.from(out!).toString()).toContain("fake-plate-render");
  });

  test("prefers Metadata/plate_N.png over other PNGs", () => {
    const buf = Buffer.from(
      zipSync({
        "Metadata/top_1.png": strToU8("TOP"),
        "Metadata/plate_1.png": strToU8("PLATE"),
      }),
    );
    expect(Buffer.from(extractThumbnail(buf)!).toString()).toBe("PLATE");
  });

  test("falls back to any Metadata PNG when there is no plate render", () => {
    const buf = Buffer.from(zipSync({ "Metadata/thumbnail.png": strToU8("THUMB") }));
    expect(Buffer.from(extractThumbnail(buf)!).toString()).toBe("THUMB");
  });

  test("returns null when the archive has no PNG", () => {
    const buf = Buffer.from(zipSync({ "Metadata/project_settings.config": strToU8("{}") }));
    expect(extractThumbnail(buf)).toBeNull();
  });
});
