  (function () {
    var fmtClock = window.PF.fmtClock;
    var live = null;
    function render() {
      document.querySelectorAll('.proj-card[data-eta-sec]').forEach(function (card) {
        var el = card.querySelector('[data-eta]');
        if (!el) return;
        var sec = Number(card.getAttribute('data-eta-sec'));
        if (!sec || sec <= 0) { el.textContent = '完了予定 —'; return; }
        var runId = card.getAttribute('data-run-id');
        var runEst = Number(card.getAttribute('data-run-est')) || 0;
        var remaining = sec;
        if (live && live.printing && runId && String(live.job_id) === runId) {
          remaining = sec - runEst + (Number(live.remaining_min) || 0) * 60;
        }
        if (remaining < 0) remaining = 0;
        el.textContent = '完了予定 ' + fmtClock(Date.now() + remaining * 1000);
      });
    }
    function poll() {
      window.PF.fetchPrinterStatus(function (s) { live = s; render(); });
    }
    poll(); // initial populate; live updates then arrive via SSE 'progress'
    document.body.addEventListener('htmx:afterSwap', render);

    // Coalesced #projects refresh — mirrors app.js's #dashboard debounce so a
    // burst of events (e.g. job_finished + the next job's job_started) collapses
    // into one fragment fetch instead of several.
    var refreshTimer = null;
    function refresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () {
        if (window.htmx) window.htmx.ajax('GET', '/ui/projects', { target: '#projects', swap: 'outerHTML' });
      }, 150);
    }

    if (!window.EventSource) {
      setInterval(poll, 30000); // no SSE → fall back to polling
      return;
    }
    var es = new EventSource('/events');
    window.PF.watchConnection(es, document.getElementById('connChip'));
    // plate-completion events change project progress/ETA → refetch the card list
    ['job_finished', 'job_failed', 'aborted'].forEach(function (t) { es.addEventListener(t, refresh); });
    // push-based measured ETA: apply each progress frame directly, like app.js
    es.addEventListener('progress', function (e) {
      try { live = JSON.parse(e.data); } catch (_) {}
      render();
    });
  })();
