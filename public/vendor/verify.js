// 実機検証ガイド (/verify) client. Mirrors app.js conventions: delegated
// listeners on document.body so wiring survives htmx fragment swaps, no inline
// handlers (CSP-friendly), shared helpers via window.PF. Owns three bits of
// interactivity the SSR fragment can't: the physical-safety checkbox gate on the
// Stage 5 run button, the dry-run / eject fetch calls, and the SSE 'progress'
// live display (which auto-marks Stage 5 passed on FINISH).
(function () {
  // ── Stage 5: physical-safety gate ──────────────────────────────────────────
  function updateDryButton() {
    var boxes = document.querySelectorAll('[data-verify-safety]');
    var all = boxes.length > 0;
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) { all = false; break; }
    }
    var btn = document.getElementById('verifyDryRun');
    if (btn) btn.disabled = !all;
  }
  document.body.addEventListener('change', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-verify-safety') !== null) {
      updateDryButton();
    }
  });
  // Re-evaluate after every htmx swap (the fragment re-renders unchecked boxes).
  document.body.addEventListener('htmx:afterSwap', updateDryButton);
  updateDryButton();

  function setMsg(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg;
  }

  // ── clicks: dry-run + eject ─────────────────────────────────────────────────
  document.body.addEventListener('click', function (e) {
    var dry = e.target.closest && e.target.closest('#verifyDryRun');
    if (dry) {
      if (dry.disabled) return;
      dry.disabled = true;
      setMsg('verifyDryMsg', 'ドライリハーサルを送信中…');
      fetch('/api/verify/dry-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.ok) {
            setMsg('verifyDryMsg', '送信しました。プリンタの動作を監視してください（下にライブ表示）。');
          } else if (res.status === 409) {
            setMsg('verifyDryMsg', 'プリンタが動作中です。停止してから再実行してください。');
            dry.disabled = false;
          } else {
            setMsg('verifyDryMsg', '送信失敗: ' + ((res.d && res.d.error) || 'unknown'));
            dry.disabled = false;
          }
        })
        .catch(function () { setMsg('verifyDryMsg', '送信失敗'); dry.disabled = false; });
      return;
    }

    var stop = e.target.closest && e.target.closest('#verifyEject');
    if (stop) {
      // two-step confirm (no native dialog), like the dashboard's abort/delete
      if (stop.getAttribute('data-armed') !== '1') {
        stop.setAttribute('data-armed', '1');
        stop.textContent = '本当に中止して排出？';
        return;
      }
      stop.disabled = true;
      setMsg('verifyEjectMsg', '中止 + 排出ジョブを送信中…');
      fetch('/api/verify/eject', { method: 'POST' })
        .then(function (r) {
          if (r.ok) setMsg('verifyEjectMsg', '送信しました。G28 でホームに正常復帰したか目視で確認してください。');
          else { setMsg('verifyEjectMsg', '送信失敗'); stop.disabled = false; }
        })
        .catch(function () { setMsg('verifyEjectMsg', '送信失敗'); stop.disabled = false; });
      return;
    }
  });

  // ── SSE: Stage 5 live display ───────────────────────────────────────────────
  var marked = false;
  function markStage5Passed() {
    if (marked) return;
    marked = true;
    var params = new URLSearchParams();
    params.set('status', 'passed');
    fetch('/ui/verify/stage/5', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }).then(function () {
      if (window.htmx) window.htmx.ajax('GET', '/ui/verify', { target: '#verify', swap: 'outerHTML' });
    });
  }
  function showLive(s) {
    var live = document.getElementById('verifyDryLive');
    if (!live || !s) return;
    var state = s.gcode_state || '—';
    var pct = Number(s.percent) || 0;
    var stateEl = live.querySelector('[data-dry-state]');
    var pctEl = live.querySelector('[data-dry-pct]');
    var bar = live.querySelector('.prog-bar');
    if (stateEl) stateEl.textContent = state;
    if (pctEl) pctEl.textContent = Math.floor(pct) + '%';
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (state === 'FINISH') markStage5Passed();
  }

  if (!window.EventSource) return; // no SSE → live display simply stays idle
  var es = new EventSource('/events');
  if (window.PF) window.PF.watchConnection(es, document.getElementById('connChip'));
  es.addEventListener('progress', function (e) {
    try { showLive(JSON.parse(e.data)); } catch (_) {}
  });
})();
