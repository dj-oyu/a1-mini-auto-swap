  (function () {
    // Printing header: show a MEASURED ETA from the printer's live
    // mc_remaining_time (polled from /api/printer/status), falling back to the
    // static estimate (data-start/data-est) when no live value is available.
    var liveStatus = null;
    var fmtClock = window.PF.fmtClock;
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
      window.PF.fetchPrinterStatus(function (s) { liveStatus = s; updatePrinting(); });
    }

    pollStatus(); // initial populate; live updates then arrive via SSE 'progress'
    document.body.addEventListener('htmx:afterSwap', updatePrinting);

    // Delegated <img onerror> replacement (CSP-friendly: no inline handlers).
    // 'error' doesn't bubble, so this listens on the CAPTURE phase from a
    // stable ancestor instead — data-onerror on the element picks the recovery.
    document.body.addEventListener('error', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var kind = el.getAttribute('data-onerror');
      if (kind === 'remove') {
        el.remove();
      } else if (kind === 'snapshot') {
        el.hidden = true;
        var none = el.parentNode && el.parentNode.querySelector('.snapshot-none');
        if (none) none.hidden = false;
      }
    }, true);

    // Coalesced #dashboard refresh: a mutation's own .then(refresh) and the SSE
    // event it triggers (or a finish's job_finished+job_started+pending burst)
    // collapse into ONE fragment fetch instead of two or three.
    var refreshTimer = null;
    function refresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () {
        if (window.htmx) window.htmx.ajax('GET', '/ui/dashboard', { target: '#dashboard', swap: 'outerHTML' });
      }, 150);
    }
    // Modal accessibility (a11y polish): Escape closes, Tab traps focus inside
    // the modal-box, and focus moves in on open / back out on close. The
    // modal-box itself is marked role="dialog" aria-modal="true" server-side
    // (ui-routes.ts); this is the client half of that contract.
    function focusableIn(box) {
      return Array.prototype.slice.call(
        box.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        )
      );
    }
    var modalOpenerEl = null; // element focused just before the modal opened
    function onModalOpened() {
      var modal = document.getElementById('modal');
      var box = modal && modal.querySelector('.modal-box');
      if (!box) return;
      modalOpenerEl = document.activeElement;
      var f = focusableIn(box);
      (f[0] || box).focus();
    }
    function closeModal() {
      var m = document.getElementById('modal');
      if (m) {
        // The camera modal streams MJPEG (multipart/x-mixed-replace); some
        // browsers keep the connection alive if we only remove the <img>, which
        // would pin the server's single upstream camera slot open. Blank the src
        // first so the browser cancels the stream and the relay can unsubscribe.
        var cam = m.querySelector('.snapshot');
        if (cam) cam.src = '';
        m.innerHTML = '';
      }
      if (modalOpenerEl && typeof modalOpenerEl.focus === 'function') modalOpenerEl.focus();
      modalOpenerEl = null;
    }
    // htmx swaps the modal in for every open path (hx-get on the card-thumb /
    // camera button / confirm button, and the upload flow's openConfirm() via
    // htmx.ajax) — one listener covers all of them.
    document.body.addEventListener('htmx:afterSwap', function (e) {
      var tgt = e.detail && e.detail.target;
      if (tgt && tgt.id === 'modal') onModalOpened();
    });
    document.addEventListener('keydown', function (e) {
      var modal = document.getElementById('modal');
      var box = modal && modal.querySelector('.modal-box');
      if (!box) return;
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeModal();
        return;
      }
      if (e.key !== 'Tab' && e.keyCode !== 9) return;
      var f = focusableIn(box);
      if (f.length === 0) { e.preventDefault(); box.focus(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !box.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !box.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    });
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

      // camera modal is a live MJPEG stream now — no manual 更新 needed.

      // stocker config: save capacity → POST /api/stocker → close + refresh
      var stockerSet = e.target.closest && e.target.closest('[data-stocker-set]');
      if (stockerSet) {
        var sbox = stockerSet.closest('.modal-box');
        var sinput = sbox && sbox.querySelector('[data-stocker-capacity]');
        var cap = sinput ? Number(sinput.value) : NaN;
        if (!(cap >= 1)) { if (sbox) sbox.classList.add('error'); return; }
        stockerSet.disabled = true;
        fetch('/api/stocker', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capacity: cap }),
        }).then(function (r) {
          stockerSet.disabled = false;
          if (r.ok) { closeModal(); refresh(); }
          else if (sbox) sbox.classList.add('error');
        }).catch(function () { stockerSet.disabled = false; if (sbox) sbox.classList.add('error'); });
        return;
      }

      // card action: reorder (↑/↓) — swap with the adjacent card, persist order
      var up = e.target.closest && e.target.closest('[data-move-up]');
      var down = e.target.closest && e.target.closest('[data-move-down]');
      if (up || down) {
        var moveId = Number((up || down).getAttribute(up ? 'data-move-up' : 'data-move-down'));
        var order = queueCards().map(function (c) { return Number(c.getAttribute('data-job-id')); });
        var i = order.indexOf(moveId);
        var j = up ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= order.length) return; // at a boundary
        order[i] = order[j];
        order[j] = moveId;
        persistOrder(order);
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
      // multi-plate 3mf upload: which Metadata/plate_N.gcode to print (only
      // present when the archive had more than one plate — see renderPlateSelect)
      var plateInput = box.querySelector('input[name="plate"]:checked');
      if (plateInput) payload.selected_plate = plateInput.value;
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

    // spec 17 §9: changing a slot's AMS tray in the confirm modal recolors the
    // 3D preview immediately via viewer.js's __setColor hook — the visual
    // "this is what will actually print" check. 未使用 (-1) greys the model out.
    document.body.addEventListener('change', function (e) {
      var sel = e.target;
      if (!sel || !sel.matches || !sel.matches('.modal-box select[data-slot]')) return;
      var box = sel.closest('.modal-box');
      var viewer = box && box.querySelector('.viewer');
      if (!viewer || typeof viewer.__setColor !== 'function') return;
      if (Number(sel.value) < 0) { viewer.__setColor('#cccccc'); return; }
      var row = sel.closest('.fil-row');
      var hex = row && row.getAttribute('data-color');
      if (hex && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) viewer.__setColor(hex);
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

    // Drag-and-drop reorder (pointer-based → testable; ↑/↓ buttons remain as an
    // accessible fallback). On drop, persist the new order via PATCH.
    function queueCards() {
      return Array.prototype.slice.call(document.querySelectorAll('.queue .card[data-job-id]'));
    }
    // Shared by the ↑/↓ buttons and the drag-drop handler below: both end up
    // with a full job-id order array, then persist + refresh identically.
    function persistOrder(order) {
      fetch('/api/queue/reorder', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order: order }),
      }).then(function (r) { if (r.ok) refresh(); });
    }
    var dragEl = null;
    document.body.addEventListener('pointerdown', function (e) {
      var h = e.target.closest && e.target.closest('[data-drag-handle]');
      if (!h) return;
      dragEl = h.closest('.card');
      if (!dragEl) return;
      dragEl.classList.add('dragging');
      e.preventDefault();
      document.addEventListener('pointerup', dropOnce, { once: true });
    });
    function dropOnce(e) {
      if (!dragEl) return;
      var moved = dragEl;
      moved.classList.remove('dragging');
      var others = queueCards().filter(function (c) { return c !== moved; });
      var before = null;
      for (var i = 0; i < others.length; i++) {
        var r = others[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { before = others[i]; break; }
      }
      var list = moved.parentNode;
      if (before) list.insertBefore(moved, before); else list.appendChild(moved);
      dragEl = null;
      var order = queueCards().map(function (c) { return Number(c.getAttribute('data-job-id')); });
      persistOrder(order);
    }

    // FTPS upload-progress indicator (header chip): only job- dispatches are
    // shown here (eject/dry-rehearsal belong to /verify, not the dashboard).
    // Hides on completion, and — since a failed/aborted transfer may never
    // send a completion sample — auto-hides 10s after the last event either way.
    var uploadChipTimer = null;
    function hideUploadChip() {
      var chip = document.getElementById('uploadChip');
      if (chip) chip.hidden = true;
    }
    function showUploadChip(p) {
      if (!p || typeof p.context !== 'string' || p.context.indexOf('job-') !== 0) return;
      var chip = document.getElementById('uploadChip');
      if (!chip) return;
      clearTimeout(uploadChipTimer);
      var sent = Number(p.bytesSent) || 0;
      var total = Number(p.totalBytes) || 0;
      if (total > 0 && sent >= total) { hideUploadChip(); return; }
      var pct = total > 0 ? Math.floor((sent / total) * 100) : 0;
      chip.textContent = '⇪ 送信中 ' + pct + '%';
      chip.hidden = false;
      uploadChipTimer = setTimeout(hideUploadChip, 10000);
    }

    if (!window.EventSource) {
      setInterval(pollStatus, 15000); // no SSE → fall back to polling the header
      return;
    }
    var es = new EventSource('/events');
    window.PF.watchConnection(es, document.getElementById('connChip'));
    ['job_started','job_finished','job_failed','aborted','stocker_low','waiting_for_refill','pending_action','filament_switched','timeout']
      .forEach(function (t) { es.addEventListener(t, refresh); });
    // a failed/aborted dispatch means no completion upload_progress sample is
    // coming — drop the chip immediately instead of waiting for the timeout.
    ['job_failed', 'aborted'].forEach(function (t) { es.addEventListener(t, hideUploadChip); });
    // build-plate low: pop a toast the moment the last plate is on the bed
    es.addEventListener('stocker_low', function (e) {
      try { showToast(JSON.parse(e.data).message || 'ビルドプレート残りわずか'); } catch (_) {}
    });
    // push-based measured ETA: apply each progress frame directly to the header
    es.addEventListener('progress', function (e) {
      try { liveStatus = JSON.parse(e.data); } catch (_) {}
      updatePrinting();
    });
    es.addEventListener('upload_progress', function (e) {
      try { showUploadChip(JSON.parse(e.data)); } catch (_) {}
    });
  })();
