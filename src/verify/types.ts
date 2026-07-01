// Scenario DSL types — the machine-readable form of scenarios/*.yaml.
// The DSL contract is documented in scenarios/README.md; this is its typed
// representation after parsing.

export interface Scenario {
  name: string;
  targets: string[];
  setup: Setup;
  steps: Step[];
  expect: ExpectEntry[];
}

export interface Setup {
  project?: { name: string; color_consistency_policy: "strict" | "propagate" };
  jobs: JobSpec[];
  ams: TraySpec[];
  stocker?: { capacity: number; remaining: number };
  system_settings: Record<string, string>;
  speed_factor?: number;
}

export interface JobSpec {
  id: string;
  project?: string;
  est_seconds?: number;
  filaments?: Array<{ slot: number; color: string; type: string }>;
  ams_mapping?: number[];
}

export interface TraySpec {
  slot: number;
  color: string;
  type: string;
  remaining_g: number;
}

export interface ExpectEntry {
  invariant: string;
  note?: string;
}

/** A parsed, discriminated step. Waits carry a resolved timeout in ms. */
export type Step =
  | { kind: "upload"; job: string }
  | { kind: "confirm_filaments"; job: string }
  | { kind: "dispatch_all" }
  | { kind: "control"; method: string; path: string; body?: unknown }
  | { kind: "resolve_pending"; type: string }
  | { kind: "retry"; job: string }
  | { kind: "refill_stocker" }
  | { kind: "finish_current" }
  | { kind: "wait_job"; job: string; state: string; timeoutMs: number }
  | { kind: "wait_pending"; type: string; exists: boolean; timeoutMs: number }
  | { kind: "assert_job"; job: string; state: string }
  | { kind: "assert_stocker"; remaining: number }
  | { kind: "assert_pending"; type: string; exists: boolean }
  | { kind: "assert_invariant"; id: string }
  | { kind: "assert_printing_count"; count: number };
