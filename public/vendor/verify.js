// 実機検証ガイド (/verify) client. Mirrors app.js conventions: delegated
// listeners on document.body so wiring survives htmx fragment swaps, no inline
// handlers (CSP-friendly), shared helpers via window.PF. Owns four bits of
// interactivity the SSR fragment can't: the physical-safety checkbox gate on the
// Stage 5 run button, the dry-run / eject fetch calls, the SSE 'upload_progress'
// FTPS-transfer bar, and the SSE 'progress' live display (which auto-marks
// Stage 5 passed on FINISH).
(function () {
  // ── Stage 5: physical-safety gate ──────────────────────────────────────────
  // Base gate: all 3 general safety boxes. When the "スワップシーケンス込みで
  // 実行" toggle is checked, two more physical confirmations (mod装着, ストッカー
  // 供給) appear and must ALSO be checked before the run button is enabled.
  function allChecked(selector) {
    var boxes = document.querySelectorAll(selector);
    if (boxes.length === 0) return false;
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) return false;
    }
    return true;
  }
  function updateDryButton() {
    var swapToggle = document.querySelector('[data-verify-swap-toggle]');
    var swapOn = !!(swapToggle && swapToggle.checked);
    var extra = document.getElementById('verifySwapExtra');
    if (extra) extra.hidden = !swapOn;

    var all = allChecked('[data-verify-safety]');
    if (swapOn) all = all && allChecked('[data-verify-swap-safety]');

    var btn = document.getElementById('verifyDryRun');
    if (btn) btn.disabled = !all;
  }
  document.body.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (
      t.getAttribute('data-verify-safety') !== null ||
      t.getAttribute('data-verify-swap-safety') !== null ||
      t.getAttribute('data-verify-swap-toggle') !== null
    ) {
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
      var swapToggle = document.querySelector('[data-verify-swap-toggle]');
      var includeSwap = !!(swapToggle && swapToggle.checked);
      fetch('/api/verify/dry-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, includeSwap: includeSwap }),
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

  // ── SSE: Stage 5 FTPS upload-progress bar ───────────────────────────────────
  // Only the dry-rehearsal transfer is relevant here (context "dry-rehearsal");
  // job-/eject- contexts belong to the dashboard, not this page.
  function fmtMb(bytes) { return (Number(bytes) / (1024 * 1024)).toFixed(1); }
  function showUploadProgress(p) {
    if (!p || p.context !== 'dry-rehearsal') return;
    var live = document.getElementById('verifyUploadLive');
    if (!live) return;
    live.hidden = false;
    var sent = Number(p.bytesSent) || 0;
    var total = Number(p.totalBytes) || 0;
    var pct = total > 0 ? Math.floor((sent / total) * 100) : 0;
    var msgEl = live.querySelector('[data-upload-msg]');
    var bar = live.querySelector('.prog-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (msgEl) {
      msgEl.textContent = total > 0 && sent >= total
        ? '送信完了、プリンター応答待ち…'
        : 'アップロード中 ' + pct + '% (' + fmtMb(sent) + '/' + fmtMb(total) + ' MB)';
    }
  }

  // ── TEMPORARY (実機検証用 — 確認後に削除, task#16): 一時検証セクション ──────
  function tempMsg(text) {
    var el = document.getElementById('tempPhotoMsg');
    if (el) el.textContent = text;
  }
  document.body.addEventListener('click', function (e) {
    var shot = e.target.closest && e.target.closest('#tempShotBtn');
    if (shot) {
      shot.disabled = true;
      tempMsg('撮影中…（最大10秒）');
      fetch('/api/verify/test-snapshot', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          shot.disabled = false;
          if (res.ok) {
            tempMsg('撮影OK (' + Math.round(res.d.bytes / 1024) + 'KB)');
            var img = document.getElementById('tempShotImg');
            if (img) { img.hidden = false; img.src = '/api/verify/test-snapshot.jpg?t=' + Date.now(); }
          } else {
            tempMsg('撮影失敗: ' + (res.d.error || 'unknown'));
          }
        })
        .catch(function () { shot.disabled = false; tempMsg('撮影失敗'); });
      return;
    }
    var rep = e.target.closest && e.target.closest('#tempReportBtn');
    if (rep) {
      rep.disabled = true;
      tempMsg('Discordへ送信中…');
      fetch('/api/verify/test-photo-report', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          rep.disabled = false;
          tempMsg(res.ok ? 'Discordへ送信しました。チャンネルを確認してください' : '送信失敗: ' + (res.d.error || 'unknown'));
        })
        .catch(function () { rep.disabled = false; tempMsg('送信失敗'); });
      return;
    }
  });
  document.body.addEventListener('change', function (e) {
    var arm = e.target.closest && e.target.closest('#tempAutoArm');
    if (!arm) return;
    var body = new FormData();
    body.append('armed', arm.checked ? '1' : '0');
    fetch('/ui/verify/auto-capture', { method: 'POST', body: body }).then(function () {
      tempMsg(arm.checked ? '自動撮影をアームしました。次の印刷で発火します' : '自動撮影を解除しました');
    });
  });

  if (!window.EventSource) return; // no SSE → live display simply stays idle
  var es = new EventSource('/events');
  if (window.PF) window.PF.watchConnection(es, document.getElementById('connChip'));
  es.addEventListener('progress', function (e) {
    try { showLive(JSON.parse(e.data)); } catch (_) {}
  });
  es.addEventListener('upload_progress', function (e) {
    try { showUploadProgress(JSON.parse(e.data)); } catch (_) {}
  });
})();
