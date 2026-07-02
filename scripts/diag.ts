/**
 * Connectivity diagnostics CLI (spec 20.7). Reads the printer target from the
 * environment (Bun auto-loads `.env`) and prints a human-readable report:
 * per-check ✅/❌ with reasons, the negotiated PROT mode, and a short summary
 * of the sample report. Exits 0 only when every check passes, 1 otherwise —
 * so it doubles as a boot/health gate.
 *
 * Works against the stub or a real A1 mini. Defaults target the local stub
 * (STUB_* / 127.0.0.1) so `bun run diag` is useful in dev without extra config.
 *
 *   bun run diag
 *
 * Secrets are never printed: the access code is only used as a credential.
 */
import { runDiagnostics, type DiagnosticsResult } from "../src/orchestrator/diagnostics.ts";

const env = (k: string, d?: string) => process.env[k] ?? d;
const num = (k: string, d: number) => {
  const raw = process.env[k];
  if (raw === undefined || raw === "") return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${k} must be a number, got "${raw}"`);
  return n;
};

// PRINTER_* (real A1 mini, Phase 8) with a fallback to the dev stub's STUB_*.
const host = env("PRINTER_HOST", "127.0.0.1")!;
const mqttPort = num("PRINTER_MQTT_PORT", num("STUB_MQTT_PORT", 8883));
const ftpsPort = num("PRINTER_FTPS_PORT", num("STUB_FTPS_PORT", 990));
const serial = env("PRINTER_SERIAL", env("STUB_SERIAL", "STUB0001"))!;
const accessCode = env("PRINTER_ACCESS_CODE", env("STUB_ACCESS_CODE", "change-me"))!;
const timeoutMs = num("DIAG_TIMEOUT_MS", 3000);

const mark = (ok: boolean) => (ok ? "✅" : "❌");

function render(r: DiagnosticsResult): void {
  const line = (label: string, ok: boolean, extra?: string) =>
    console.log(`  ${mark(ok)} ${label.padEnd(18)} ${extra ?? ""}`.trimEnd());

  console.log(`\nDiagnostics for ${r.host}  (mqtt:${mqttPort} ftps:${ftpsPort} serial:${serial})\n`);
  line("mqtt_reachable", r.mqtt_reachable, r.errors.mqtt_reachable);
  line("ftps_reachable", r.ftps_reachable, r.errors.ftps_reachable);
  line("mqtt_auth_ok", r.mqtt_auth_ok, r.errors.mqtt);
  line("report_received", r.report_received, r.errors.report_received);
  line("ftps_auth_ok", r.ftps_auth_ok, r.errors.ftps);
  line("prot_mode", r.prot_mode !== "none", `${r.prot_mode}${r.prot_detail ? ` (${r.prot_detail})` : ""}`);

  if (r.sample_report) {
    const s = r.sample_report;
    const pick = ["gcode_state", "mc_percent", "mc_remaining_time", "subtask_name"] as const;
    const summary = pick
      .filter((k) => s[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(s[k])}`)
      .join(" ");
    console.log(`\n  sample_report: ${summary || "(received, no standard fields)"}`);
    console.log(`  sample_report keys: ${Object.keys(s).join(", ")}`);
  } else {
    console.log(`\n  sample_report: (none)`);
  }
  console.log("");
}

function allPass(r: DiagnosticsResult): boolean {
  return (
    r.mqtt_reachable &&
    r.ftps_reachable &&
    r.mqtt_auth_ok &&
    r.report_received &&
    r.ftps_auth_ok &&
    r.prot_mode !== "none"
  );
}

const result = await runDiagnostics({ host, mqttPort, ftpsPort, serial, accessCode, timeoutMs });
render(result);
const ok = allPass(result);
console.log(ok ? "All checks passed." : "Some checks failed.");
process.exit(ok ? 0 : 1);
