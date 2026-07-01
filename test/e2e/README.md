# Web frontend E2E (Playwright)

Browser E2E for the Web UI (`docs/ui-handoff.md`). The app under test is the
**dev harness** (`src/dev/harness.ts`): the full UI served over a seeded
in-memory DB with no printer/broker. Playwright boots one harness (see
`playwright.config.ts` → `webServer`); each test resets state via
`POST /__dev/reset` (re-seeds, restarts AUTOINCREMENT ids at 1) so tests are
isolated and deterministic.

Files are named `*.e2e.ts` (not `*.spec.ts`) so Bun's own test runner never
collects them; only `playwright test` does.

## Run

```bash
bunx playwright install chromium   # once
bun run test:e2e                   # headless
bunx playwright test --ui          # interactive
```

## Scenarios

**正常系**
- Dashboard renders the seeded queue (6 cards), stocker chip, 対応待ち banner
  (count 2), and the live printing header.
- Printing header shows a **measured** %/ETA from `/api/printer/status` (実測).
- `/api/printer/status` is polled; the SSE `/events` stream opens.
- Resolving a 対応待ち item drops the count via an htmx `#dashboard` swap.
- Filament confirm: open the modal for the processing job, set the AMS mapping,
  確定 → job → 待機中, its pending resolved (banner 2→1).
- Upload a valid `.gcode.3mf` → job created, confirm modal auto-opens → 確定.
- 3D preview: click a card thumbnail → viewer modal opens.

**異常系 / エッジ**
- Upload an invalid (non-zip) file → error surfaced, no job/modal created.
- Confirm modal cancel closes without changing state.
- Empty queue (`?seed=0`) → empty state + calm banner + no printing header +
  "ストッカー未設定".

## CI

Runs as a separate workflow (`.github/workflows/e2e.yml`) so the required fast
`test` gate stays unit-only.
