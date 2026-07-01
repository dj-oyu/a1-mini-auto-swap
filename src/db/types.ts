// Row types for the SQLite schema (spec ch4). Column names match the DB.

export type JobStatus =
  | "processing"
  | "queued"
  | "printing"
  | "success"
  | "failed"
  | "aborted"
  | "waiting_for_refill";

export type ColorConsistencyPolicy = "strict" | "propagate";

export type PendingActionType =
  | "filament_confirm"
  | "stocker_refill"
  | "retry_decision"
  | "filament_runout"
  | "color_decision"
  | "mechanical_check";

export type Severity = "blocking_queue" | "blocking_job" | "advisory";

export interface ProjectRow {
  id: number;
  name: string;
  color_consistency_policy: ColorConsistencyPolicy;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: number;
  project_id: number | null;
  filename: string;
  status: JobStatus;
  position: number | null;
  attempts: number;
  last_error: string | null;
  thumbnail_path: string | null;
  mesh_json_path: string | null;
  filaments: string | null; // JSON: [{slot,color,type}]
  ams_mapping: string | null; // JSON: 4-element array
  estimated_seconds: number | null;
  substituted_slot: number | null;
  substituted_color: string | null;
  filament_runout_policy_override: string | null;
  created_at: string;
  updated_at: string;
}

export interface StockerRow {
  id: number; // always 1
  capacity: number;
  remaining: number;
}

export interface PendingActionRow {
  id: number;
  type: PendingActionType;
  job_id: number | null;
  project_id: number | null;
  severity: Severity;
  message: string | null;
  snapshot_path: string | null;
  created_at: string;
  notified_at: string | null;
  resolved_at: string | null;
}
