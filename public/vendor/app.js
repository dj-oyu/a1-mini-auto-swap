  (function () {
    // Printing header: show a MEASURED ETA from the printer's live
    // mc_remaining_time (polled from /api/printer/status), falling back to the
    // static estimate (data-start/data-est) when no live value is available.
    var liveStatus = null;
    function fmtClock(epoch) {
      try { return new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return '--:--'; }
    }
    function updatePrinting() {
      var els = document.querySelectorAll('[data-printing]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var jobId = Number(el.getAttribute('data-job-id'));
        var start = Number(el.getAttribute('data-start'));
        var est = Number(el.getAttribute('data-est'));
        var bar = el.querySelector('.prog-bar');
        var pctEl = el.querySelector('.pct');
        var etaEl = el.querySelector('[data-eta]');
        var pct, etaEpoch, live = false;
        if (liveStatus && liveStatus.printing && liveStatus.job_id === jobId && liveStatus.remaining_min > 0) {
          pct = Math.max(0, Math.min(100, liveStatus.percent));
          etaEpoch = Date.now() + liveStatus.remaining_min * 60000;
          live = true;
        } else if (start && est) {
          pct = Math.max(0, Math.min(100, (Date.now() - start) / 1000 / est * 100));
          etaEpoch = start + est * 1000;
        } else {
          if (pctEl) pctEl.textContent = '進行中';
          continue;
        }
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        if (pctEl) pctEl.textContent = Math.floor(pct) + '%' + (live ? '（実測）' : '（予定）');
        if (etaEl) etaEl.textContent = 'ETA ' + fmtClock(etaEpoch);
      }
    }
    function pollStatus() {
      fetch('/api/printer/status')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { liveStatus = s; updatePrinting(); })
        .catch(function () { updatePrinting(); });
    }

    pollStatus(); // initial populate; live updates then arrive via SSE 'progress'
    document.body.addEventListener('htmx:afterSwap', updatePrinting);

    function refresh() {
      if (window.htmx) window.htmx.ajax('GET', '/ui/dashboard', { target: '#dashboard', swap: 'outerHTML' });
    }
    function closeModal() { var m = document.getElementById('modal'); if (m) m.innerHTML = ''; }
    // Transient alert (e.g. build-plate low). Click or auto-hide after ~12s.
    function showToast(msg) {
      var t = document.getElementById('toast');
      if (!t) return;
      t.textContent = msg;
      t.hidden = false;
      t.onclick = function () { t.hidden = true; };
      clearTimeout(t.__timer);
      t.__timer = setTimeout(function () { t.hidden = true; }, 12000);
    }

    // MVP #5: the filament-confirm modal. Cancel/backdrop close it; 確定 gathers
    // the per-slot AMS selects into a 4-element mapping and PATCHes the job.
    document.body.addEventListener('click', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-close')) { closeModal(); return; }

      // camera modal: reload the snapshot with a cache-buster
      var snapBtn = e.target.closest && e.target.closest('[data-snap-refresh]');
      if (snapBtn) {
        var img = document.querySelector('#modal .snapshot');
        var none = document.querySelector('#modal .snapshot-none');
        if (img) { img.hidden = false; if (none) none.hidden = true; img.src = '/api/printer/snapshot?t=' + Date.now(); }
        return;
      }

      // card action: reorder (↑/↓) — swap with the adjacent card, persist order
      var up = e.target.closest && e.target.closest('[data-move-up]');
      var down = e.target.closest && e.target.closest('[data-move-down]');
      if (up || down) {
        var moveId = Number((up || down).getAttribute(up ? 'data-move-up' : 'data-move-down'));
        var cards = Array.prototype.slice.call(document.querySelectorAll('.queue .card[data-job-id]'));
        var order = cards.map(function (c) { return Number(c.getAttribute('data-job-id')); });
        var i = order.indexOf(moveId);
        var j = up ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= order.length) return; // at a boundary
        order[i] = order[j];
        order[j] = moveId;
        fetch('/api/queue/reorder', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ order: order }),
        }).then(function (r) { if (r.ok) refresh(); });
        return;
      }

      // card action: abort the running job (two-step, no native dialog)
      var abortBtn = e.target.closest && e.target.closest('[data-abort]');
      if (abortBtn) {
        if (abortBtn.getAttribute('data-armed') !== '1') {
          abortBtn.setAttribute('data-armed', '1');
          abortBtn.textContent = '本当に中止？';
          return;
        }
        var aid = abortBtn.getAttribute('data-abort');
        abortBtn.disabled = true;
        fetch('/api/queue/' + aid + '/abort', { method: 'POST' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function () { refresh(); })
          .catch(function () { abortBtn.disabled = false; });
        return;
      }

      // card action: retry a failed job
      var retryBtn = e.target.closest && e.target.closest('[data-retry]');
      if (retryBtn) {
        var rid = retryBtn.getAttribute('data-retry');
        retryBtn.disabled = true;
        fetch('/api/queue/' + rid + '/retry', { method: 'POST' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function () { refresh(); })
          .catch(function () { retryBtn.disabled = false; });
        return;
      }

      // card action: delete a non-printing job (two-step, no native dialog)
      var delBtn = e.target.closest && e.target.closest('[data-delete]');
      if (delBtn) {
        if (delBtn.getAttribute('data-armed') !== '1') {
          delBtn.setAttribute('data-armed', '1');
          delBtn.textContent = '本当に削除？';
          return;
        }
        var did = delBtn.getAttribute('data-delete');
        delBtn.disabled = true;
        fetch('/api/queue/' + did, { method: 'DELETE' })
          .then(function (r) {
            if (r.status === 204) { refresh(); }
            else { delBtn.disabled = false; delBtn.textContent = '削除できません'; }
          })
          .catch(function () { delBtn.disabled = false; });
        return;
      }

      var btn = e.target.closest && e.target.closest('[data-confirm]');
      if (!btn) return;
      var id = btn.getAttribute('data-confirm');
      var box = btn.closest('.modal-box');
      var map = [-1, -1, -1, -1];
      box.querySelectorAll('select[data-slot]').forEach(function (s) {
        var slot = Number(s.getAttribute('data-slot'));
        if (slot >= 1 && slot <= 4) map[slot - 1] = Number(s.value);
      });
      var payload = { ams_mapping: map };
      var proj = box.querySelector('[data-project]');
      if (proj) payload.project_id = proj.value === '' ? null : Number(proj.value);
      btn.disabled = true;
      fetch('/api/queue/' + id + '/filaments', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) {
        btn.disabled = false;
        if (r.ok) { closeModal(); refresh(); }
        else { box.classList.add('error'); }
      }).catch(function () { btn.disabled = false; box.classList.add('error'); });
    });

    // MVP #5: drag-drop / pick a .gcode.3mf → POST /api/queue → open its confirm
    // modal. Listeners live on the persistent topbar (not swapped by SSE).
    function openConfirm(id) {
      if (window.htmx) window.htmx.ajax('GET', '/ui/queue/' + id + '/confirm', { target: '#modal', swap: 'innerHTML' });
    }
    function setUploadStatus(msg) { var el = document.getElementById('uploadStatus'); if (el) el.textContent = msg; }
    function uploadFile(file) {
      if (!file) return;
      setUploadStatus('アップロード中… ' + file.name);
      file.arrayBuffer().then(function (buf) {
        return fetch('/api/queue?filename=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: buf,
        });
      }).then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      }).then(function (res) {
        if (res.ok && res.data && res.data.id != null) {
          setUploadStatus('');
          refresh();
          openConfirm(res.data.id);
        } else {
          setUploadStatus('アップロード失敗: ' + ((res.data && res.data.error) || 'unknown'));
        }
      }).catch(function () { setUploadStatus('アップロード失敗'); });
    }
    var fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.addEventListener('change', function () {
      if (this.files && this.files[0]) uploadFile(this.files[0]);
      this.value = '';
    });
    var dz = document.getElementById('dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
      });
    }

    if (!window.EventSource) {
      setInterval(pollStatus, 15000); // no SSE → fall back to polling the header
      return;
    }
    var es = new EventSource('/events');
    ['job_started','job_finished','job_failed','aborted','stocker_low','waiting_for_refill','pending_action','filament_switched','timeout']
      .forEach(function (t) { es.addEventListener(t, refresh); });
    // build-plate low: pop a toast the moment the last plate is on the bed
    es.addEventListener('stocker_low', function (e) {
      try { showToast(JSON.parse(e.data).message || 'ビルドプレート残りわずか'); } catch (_) {}
    });
    // push-based measured ETA: apply each progress frame directly to the header
    es.addEventListener('progress', function (e) {
      try { liveStatus = JSON.parse(e.data); } catch (_) {}
      updatePrinting();
    });
  })();
