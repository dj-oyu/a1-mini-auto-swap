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
    poll();
    setInterval(poll, 30000);
    document.body.addEventListener('htmx:afterSwap', render);
  })();
