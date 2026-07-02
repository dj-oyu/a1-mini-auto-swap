// Artifact naming (pure). One place for the three names derived from a job id —
// they were previously drifting apart across upload-routes / main / monitor,
// which silently degraded monitor correlation to its single-machine fallback.

/** Local upload-cache filename (written by POST /api/queue, read by the
 *  thumbnail/model routes and the dispatch-time artifact resolver). */
export const cacheFileName = (jobId: number): string => `${jobId}.gcode.3mf`;

/** Name of the artifact on the printer (FTPS remote name / MQTT url). The
 *  printer echoes it back as subtask_name, which the monitor correlates on. */
export const printArtifactName = (jobId: number): string => `job-${jobId}.gcode.3mf`;

/** Prefix the monitor matches inside subtask_name (see printArtifactName). */
export const jobSubtaskPrefix = (jobId: number): string => `job-${jobId}.`;

/** On-printer name of the dedicated eject job (spec 6/19, INV-MQTT-02). Not a
 *  DB job — the monitor must never attribute its FINISH to a queue row, which
 *  the job- prefix scheme above already guarantees. */
export const EJECT_ARTIFACT_NAME = "eject.gcode.3mf";

/** Full STOR path on the printer for an artifact. Uploads MUST target /cache/
 *  — 実測 2026-07-02: a STOR to the SD root is silently swallowed by real A1
 *  firmware (no 226 reply → control-socket timeout → abandoned sessions wedge
 *  the FTPS server). LIST works anywhere, which is why diagnostics passed
 *  while every upload hung. The stub sanitizes to basename, so it accepts
 *  either form. Matches the MQTT url (`ftp:///cache/...`, spec 9). */
export const printerUploadPath = (name: string): string => `/cache/${name}`;
