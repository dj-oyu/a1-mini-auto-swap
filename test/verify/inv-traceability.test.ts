// INVトレーサビリティ検証：invariants.yaml の各 INV-XXX-NN が、実際に
// test/**/*.ts (e2e含む) / scenarios/*.yaml / src/verify/**/*.ts のどこかで
// 参照されていることを機械的に確認する。
//
// 「仕様＝不変条件＝テスト」の三位一体を維持するためのメタテスト（CLAUDE.md）。
// 未参照のIDを黙って見逃さない：カバーされていないIDは UNCOVERED に理由付きで
// 明示登録しない限り、このテストは失敗する。逆に、テスト/シナリオ中の
// `INV-[A-Z]+-\d+` 文字列で invariants.yaml に存在しないもの（タイポ）も検出する。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dir, "..", "..");
// このファイル自身は走査対象から除外する。UNCOVERED配列にIDリテラルを書くと
// それ自体が「参照」としてヒットしてしまい、未カバー検出が機能しなくなるため。
const SELF = resolve(import.meta.dir, "inv-traceability.test.ts");

const INV_ID_RE = /INV-[A-Z]+-\d+/g;

interface InvariantMeta {
  id: string;
  spec?: string;
  desc?: string;
}

function loadInvariants(): InvariantMeta[] {
  const doc = parseYaml(readFileSync(join(ROOT, "invariants.yaml"), "utf-8")) as {
    invariants: InvariantMeta[];
  };
  return doc.invariants;
}

/** Recursively collect files under `dir` whose path satisfies `filter`. */
function walk(dir: string, filter: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p, filter, out);
    } else if (filter(p)) {
      out.push(p);
    }
  }
  return out;
}

/** The files this traceability test scans: test/**\/*.ts (e2e含む, 自分自身は除く),
 *  scenarios/*.yaml, src/verify/**\/*.ts. */
function collectScannedFiles(): string[] {
  const files: string[] = [];

  walk(join(ROOT, "test"), (p) => p.endsWith(".ts") && resolve(p) !== SELF, files);

  for (const entry of readdirSync(join(ROOT, "scenarios"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".yaml")) {
      files.push(join(ROOT, "scenarios", entry.name));
    }
  }

  walk(join(ROOT, "src", "verify"), (p) => p.endsWith(".ts"), files);

  return files;
}

/** Map of INV id -> repo-relative file paths that mention it (deduped). */
function collectReferences(files: string[]): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const matches = text.match(INV_ID_RE);
    if (!matches) continue;
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    for (const id of new Set(matches)) {
      const list = refs.get(id) ?? [];
      list.push(rel);
      refs.set(id, list);
    }
  }
  return refs;
}

/**
 * INV ids that are NOT currently referenced anywhere in test/**\/*.ts,
 * scenarios/*.yaml, or src/verify/**\/*.ts. Every entry is a deliberate,
 * reasoned exemption — never a silent gap. When real coverage is added for
 * an id, remove its entry here (the "still actually unreferenced" check
 * below fails loudly if a stale exemption becomes referenced elsewhere).
 */
const UNCOVERED: { id: string; reason: string }[] = [
  {
    id: "INV-MQTT-03",
    reason:
      "アーキテクチャレベルの不変条件（A1 mini本体へのMQTT/FTPS直接接続はオーケストレーター" +
      "1点に集約し、ブラウザ/IoTクライアントは直接繋がない）。現状のテストダブル・シナリオ" +
      "ランナーには『別クライアントが直接接続を試みて拒否される』ことをモデル化する仕組みが" +
      "なく、実際には『src/orchestrator 以外の層が mqtt/basic-ftp をimportしない』という" +
      "コード構造で担保されているのみ。機械的な接続可否テストはまだ書けていない（未実装）。",
  },
  {
    id: "INV-RUNOUT-02",
    reason:
      "spec 15 の『色が代替されたジョブは完了通知に必ずその旨が含まれる』は未実装。" +
      "dispatcher.onFinished (src/core/dispatcher.ts) が送る job_finished 通知イベントは " +
      "jobId のみで、代替色に触れる message を持たない（src/core/ports.ts の NotifyEvent 参照）。" +
      "invariants.yaml でも layer: ai （自然言語判定）指定であり、通知本文の実装自体が先行課題。",
  },
];

const UNCOVERED_IDS = new Set(UNCOVERED.map((u) => u.id));

function formatMissingReport(missing: string[], byId: Map<string, InvariantMeta>): string {
  const lines = missing.map((id) => {
    const meta = byId.get(id);
    return `  - ${id}${meta?.spec ? ` (spec ${meta.spec})` : ""}: ${meta?.desc ?? ""}`;
  });
  return [
    `${missing.length} invariant id(s) are referenced by neither test/**/*.ts, scenarios/*.yaml,`,
    `nor src/verify/**/*.ts, and are not listed in UNCOVERED with a reason:`,
    ...lines,
    "",
    "Add a test/scenario tag comment (// INV-XXX-NN) where coverage genuinely exists,",
    "or add a reasoned entry to the UNCOVERED array in test/verify/inv-traceability.test.ts.",
  ].join("\n");
}

describe("INV traceability (invariants.yaml <-> tests/scenarios)", () => {
  const invariants = loadInvariants();
  const invIds = new Set(invariants.map((inv) => inv.id));
  const invById = new Map(invariants.map((inv) => [inv.id, inv]));
  const scannedFiles = collectScannedFiles();
  const refs = collectReferences(scannedFiles);

  test("invariants.yaml parses and has at least one id (sanity check)", () => {
    expect(invariants.length).toBeGreaterThan(0);
    expect(new Set(invariants.map((i) => i.id)).size).toBe(invariants.length); // no duplicate ids
  });

  test("every invariants.yaml id is referenced by a test/scenario, or explicitly exempted in UNCOVERED", () => {
    const missing = [...invIds].filter((id) => !refs.has(id) && !UNCOVERED_IDS.has(id));
    if (missing.length > 0) {
      console.error(formatMissingReport(missing, invById));
    }
    expect(missing).toEqual([]);
  });

  test("UNCOVERED entries are real ids, carry a substantive reason, and are still actually unreferenced", () => {
    const problems: string[] = [];
    for (const u of UNCOVERED) {
      if (!invIds.has(u.id)) {
        problems.push(`${u.id}: not a real id in invariants.yaml (stale entry or typo)`);
      }
      if (!u.reason || u.reason.trim().length < 10) {
        problems.push(`${u.id}: missing or too-short reason`);
      }
      if (refs.has(u.id)) {
        problems.push(
          `${u.id}: is now referenced in [${refs.get(u.id)!.join(", ")}] — remove it from UNCOVERED, it's covered.`,
        );
      }
    }
    if (problems.length > 0) console.error(problems.join("\n"));
    expect(problems).toEqual([]);
  });

  test("no INV-* reference in test/scenario/verify code is a typo of a nonexistent invariant id", () => {
    const unknown = [...refs.keys()].filter((id) => !invIds.has(id));
    if (unknown.length > 0) {
      const lines = unknown.map((id) => `  - ${id} referenced in: ${refs.get(id)!.join(", ")}`);
      console.error(
        [
          `${unknown.length} INV-* string(s) referenced in test/scenario/verify code do not exist`,
          `in invariants.yaml (likely typos):`,
          ...lines,
        ].join("\n"),
      );
    }
    expect(unknown).toEqual([]);
  });
});
