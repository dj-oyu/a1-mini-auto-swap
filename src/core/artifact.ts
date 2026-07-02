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
