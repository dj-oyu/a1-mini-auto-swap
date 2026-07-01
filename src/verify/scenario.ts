import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ExpectEntry, Scenario, Setup, Step } from "./types.ts";

/** Default wait_until timeout when a step does not specify one. */
export const DEFAULT_WAIT_MS = 3000;

const HTTP_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"];

export function loadScenario(path: string): Scenario {
  return parseScenario(readFileSync(path, "utf8"));
}

export function parseScenario(yamlText: string): Scenario {
  const raw = parseYaml(yamlText) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("scenario must be a YAML mapping");
  if (typeof raw.name !== "string") throw new Error("scenario.name is required");

  const setup = parseSetup((raw.setup ?? {}) as Record<string, unknown>);
  const steps = ((raw.steps as unknown[]) ?? []).map(parseStep);
  const expect = ((raw.expect as unknown[]) ?? []).map(parseExpect);
  const targets = Array.isArray(raw.targets) ? (raw.targets as string[]) : [];

  return { name: raw.name, targets, setup, steps, expect };
}

function parseSetup(raw: Record<string, unknown>): Setup {
  return {
    project: raw.project as Setup["project"],
    jobs: (raw.jobs as Setup["jobs"]) ?? [],
    ams: (raw.ams as Setup["ams"]) ?? [],
    stocker: raw.stocker as Setup["stocker"],
    system_settings: (raw.system_settings as Record<string, string>) ?? {},
    speed_factor: raw.speed_factor as number | undefined,
  };
}

export function parseStep(raw: unknown): Step {
  if (typeof raw === "string") {
    switch (raw) {
      case "dispatch_all":
        return { kind: "dispatch_all" };
      case "finish_current":
        return { kind: "finish_current" };
      case "refill_stocker":
        return { kind: "refill_stocker" };
      default:
        throw new Error(`unknown bare step: "${raw}"`);
    }
  }
  if (!raw || typeof raw !== "object") throw new Error(`invalid step: ${JSON.stringify(raw)}`);

  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) throw new Error(`a step must have exactly one key: ${JSON.stringify(raw)}`);
  const key = keys[0]!;
  const val = obj[key];

  switch (key) {
    case "upload":
      return { kind: "upload", job: String(val) };
    case "confirm_filaments":
      return { kind: "confirm_filaments", job: String(val) };
    case "retry":
      return { kind: "retry", job: String(val) };
    case "resolve_pending":
      return { kind: "resolve_pending", type: String((val as Record<string, unknown>).type) };
    case "control":
      return parseControl(val as Record<string, unknown>);
    case "wait_until":
      return parseWait(val as Record<string, unknown>);
    case "assert":
      return parseAssert(val as Record<string, unknown>);
    default:
      throw new Error(`unknown step key: "${key}"`);
  }
}

function parseControl(val: Record<string, unknown>): Step {
  const method = HTTP_METHODS.find((m) => m in val);
  if (!method) throw new Error(`control step needs an HTTP method key: ${JSON.stringify(val)}`);
  return { kind: "control", method, path: String(val[method]), body: val.body };
}

function parseWait(val: Record<string, unknown>): Step {
  const timeoutMs = typeof val.timeout_ms === "number" ? val.timeout_ms : DEFAULT_WAIT_MS;
  if ("job" in val) {
    return { kind: "wait_job", job: String(val.job), state: String(val.state), timeoutMs };
  }
  if ("pending_action" in val) {
    return {
      kind: "wait_pending",
      type: String(val.pending_action),
      exists: val.exists !== false,
      timeoutMs,
    };
  }
  throw new Error(`wait_until needs a job or pending_action: ${JSON.stringify(val)}`);
}

function parseAssert(val: Record<string, unknown>): Step {
  if ("job" in val) return { kind: "assert_job", job: String(val.job), state: String(val.state) };
  if ("stocker" in val) {
    const s = val.stocker as { remaining: number };
    return { kind: "assert_stocker", remaining: s.remaining };
  }
  if ("pending_action" in val) {
    return { kind: "assert_pending", type: String(val.pending_action), exists: val.exists !== false };
  }
  if ("invariant" in val) return { kind: "assert_invariant", id: String(val.invariant) };
  if ("printing_count" in val) {
    return { kind: "assert_printing_count", count: Number(val.printing_count) };
  }
  throw new Error(`unknown assert form: ${JSON.stringify(val)}`);
}

function parseExpect(raw: unknown): ExpectEntry {
  if (typeof raw === "string") return { invariant: raw };
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) throw new Error(`an expect entry must have one key: ${JSON.stringify(raw)}`);
  const key = keys[0]!;
  return { invariant: key, note: obj[key] == null ? undefined : String(obj[key]) };
}
