// Pure, deterministic unit tests for the curl argv builder (no network, no
// wall-clock). These pin the stall-based timeout fix: a slow-but-progressing
// upload of any size must complete (size-aware --max-time) while a genuine
// stall aborts promptly (--speed-limit/--speed-time). See ftps-curl.ts.
import { expect, test } from "bun:test";
import {
  buildCurlArgs,
  DEFAULT_FLOOR_BYTES_PER_SEC,
  DEFAULT_SPEED_LIMIT_BYTES_PER_SEC,
  DEFAULT_SPEED_TIME_SECONDS,
  DEFAULT_TIMEOUT_MS,
  HANDSHAKE_MARGIN_MS,
  type CurlUploadOptions,
} from "../../src/orchestrator/ftps-curl.ts";

const CFG = "/tmp/ftps-curl-xyz/curl.cfg";
const URL = "ftps://127.0.0.1:990/cache/job-12.gcode.3mf";
const base: CurlUploadOptions = { host: "127.0.0.1", port: 990, accessCode: "secret-code" };

/** Read the value following a flag in the argv (mirrors how curl parses it). */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const maxTimeSec = (args: string[]) => Number(flagValue(args, "--max-time"));

test("adds the stall guard (--speed-limit/--speed-time) with sensible defaults", () => {
  const args = buildCurlArgs(CFG, URL, 1024, base);
  expect(flagValue(args, "--speed-limit")).toBe(String(DEFAULT_SPEED_LIMIT_BYTES_PER_SEC));
  expect(flagValue(args, "--speed-time")).toBe(String(DEFAULT_SPEED_TIME_SECONDS));
  // Sanity on the chosen values: 1 KB/s over 30s.
  expect(DEFAULT_SPEED_LIMIT_BYTES_PER_SEC).toBe(1024);
  expect(DEFAULT_SPEED_TIME_SECONDS).toBe(30);
});

test("stall guard is overridable via options", () => {
  const args = buildCurlArgs(CFG, URL, 1024, { ...base, speedLimitBytesPerSec: 2048, speedTimeSeconds: 45 });
  expect(flagValue(args, "--speed-limit")).toBe("2048");
  expect(flagValue(args, "--speed-time")).toBe("45");
});

test("--max-time scales with payload size (22 MB > 120s floor)", () => {
  const twentyTwoMB = 22 * 1024 * 1024;
  const args = buildCurlArgs(CFG, URL, twentyTwoMB, base);
  const sec = maxTimeSec(args);
  // 22MiB / 40_000 B/s ≈ 576s + 30s margin ≈ 606s — well above the 120s floor
  // that killed the real transfer.
  expect(sec).toBeGreaterThan(120);
  const effMs = Math.max(DEFAULT_TIMEOUT_MS, (twentyTwoMB / DEFAULT_FLOOR_BYTES_PER_SEC) * 1000 + HANDSHAKE_MARGIN_MS);
  expect(sec).toBe(Math.ceil(effMs / 1000));
  expect(sec).toBeGreaterThanOrEqual(550);
});

test("--max-time stays at the 120s floor for a tiny payload", () => {
  const args = buildCurlArgs(CFG, URL, 32, base);
  expect(maxTimeSec(args)).toBe(DEFAULT_TIMEOUT_MS / 1000); // 120
});

test("a lowered floor makes even a small stand-in buffer exceed the 120s floor", () => {
  // Exercises the size-aware ceiling deterministically without a huge buffer:
  // 300 KiB / 1000 B/s ≈ 307s + 30s ≈ 337s.
  const args = buildCurlArgs(CFG, URL, 300 * 1024, { ...base, floorBytesPerSec: 1000 });
  expect(maxTimeSec(args)).toBeGreaterThan(120);
});

test("opts.timeoutMs acts as an explicit floor/override, never a cap", () => {
  // Larger than the size-derived ceiling → the override wins (floor raised).
  const raised = buildCurlArgs(CFG, URL, 1024, { ...base, timeoutMs: 300_000 });
  expect(maxTimeSec(raised)).toBe(300);
  // Smaller than the size-derived ceiling for a big payload → size wins (not capped).
  const big = buildCurlArgs(CFG, URL, 22 * 1024 * 1024, { ...base, timeoutMs: 60_000 });
  expect(maxTimeSec(big)).toBeGreaterThan(60);
});

test("credentials stay off argv: -K references the config path, access code never appears", () => {
  const args = buildCurlArgs(CFG, URL, 1024, base);
  const kIdx = args.indexOf("-K");
  expect(kIdx).toBe(0);
  expect(args[kIdx + 1]).toBe(CFG);
  // The secret is never rendered into the process table / argv.
  expect(args.join(" ")).not.toContain(base.accessCode);
  expect(args).not.toContain("secret-code");
});

test("preserves the required curl flags and arg order (url last)", () => {
  const args = buildCurlArgs(CFG, URL, 1024, base);
  for (const flag of ["-k", "--ssl-reqd", "--disable-epsv", "-sS"]) {
    expect(args).toContain(flag);
  }
  // -T - (stdin streaming) is present as an adjacent pair.
  const tIdx = args.indexOf("-T");
  expect(tIdx).toBeGreaterThanOrEqual(0);
  expect(args[tIdx + 1]).toBe("-");
  // URL is the final positional argument.
  expect(args[args.length - 1]).toBe(URL);
});
