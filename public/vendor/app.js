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
    // Ordered print-sequence builder (multi-plate 3mf confirm modal). The list
    // is authoritative on submit: app.js reads it top-to-bottom into
    // selected_plates (order + duplicates significant → spells words like BOB).
    function seqListOf(box) { return box && box.querySelector('[data-seq-list]'); }
    // The job id lives on the [data-plate-seq] container so client-built rows can
    // construct the per-plate thumbnail URL (same endpoint as the palette chips).
    function jobIdOf(box) {
      var seq = box && box.querySelector('[data-plate-seq]');
      return seq ? seq.getAttribute('data-job-id') : null;
    }
    function renumberSeq(box) {
      var list = seqListOf(box);
      if (!list) return;
      var items = list.querySelectorAll('[data-seq-item]');
      for (var i = 0; i < items.length; i++) {
        var idx = items[i].querySelector('.seq-idx');
        if (idx) idx.textContent = String(i + 1);
      }
      var cnt = box.querySelector('[data-seq-count]');
      if (cnt) cnt.textContent = String(items.length);
      var err = box.querySelector('[data-seq-error]');
      if (err && items.length > 0) err.hidden = true;
    }
    function makeSeqRow(plate, label, jobId) {
      var li = document.createElement('li');
      li.className = 'plate-seq-item';
      li.setAttribute('data-seq-item', '');
      li.setAttribute('data-plate', plate);
      // small per-plate thumbnail so a built sequence (e.g. B,O,B) is visually
      // readable; removes itself if the plate has no PNG (data-onerror="remove").
      var thumb = jobId
        ? '<img class="seq-thumb" loading="lazy" src="/api/queue/' + encodeURIComponent(jobId) +
          '/thumbnail?plate=' + encodeURIComponent(plate) + '" alt="" data-onerror="remove">'
        : '';
      li.innerHTML =
        '<span class="seq-idx"></span>' + thumb + '<span class="seq-label"></span>' +
        '<span class="seq-controls">' +
        '<button type="button" class="act move" data-seq-up aria-label="上へ">↑</button>' +
        '<button type="button" class="act move" data-seq-down aria-label="下へ">↓</button>' +
        '<button type="button" class="act danger" data-seq-remove aria-label="この行を削除">✕</button>' +
        '</span>';
      li.querySelector('.seq-label').textContent = label || ('プレート ' + plate.replace(/^plate_/, ''));
      return li;
    }

    document.body.addEventListener('click', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-close')) { closeModal(); return; }

      // print-sequence builder: append one plate (a plate may be added many times)
      var addChip = e.target.closest && e.target.closest('[data-plate-add]');
      if (addChip) {
        var abox = addChip.closest('.modal-box');
        var alist = seqListOf(abox);
        if (alist) {
          alist.appendChild(makeSeqRow(addChip.getAttribute('data-plate-add'), addChip.getAttribute('data-plate-label'), jobIdOf(abox)));
          renumberSeq(abox);
        }
        return;
      }
      // append every plate once, in palette (ascending) order — "print all"
      var addAll = e.target.closest && e.target.closest('[data-plate-add-all]');
      if (addAll) {
        var allBox = addAll.closest('.modal-box');
        var allList = seqListOf(allBox);
        if (allList) {
          var allJobId = jobIdOf(allBox);
          var chips = allBox.querySelectorAll('[data-plate-add]');
          for (var ci = 0; ci < chips.length; ci++) {
            allList.appendChild(makeSeqRow(chips[ci].getAttribute('data-plate-add'), chips[ci].getAttribute('data-plate-label'), allJobId));
          }
          renumberSeq(allBox);
        }
        return;
      }
      // remove a sequence row
      var seqRm = e.target.closest && e.target.closest('[data-seq-remove]');
      if (seqRm) {
        var rmBox = seqRm.closest('.modal-box');
        var rmItem = seqRm.closest('[data-seq-item]');
        if (rmItem) rmItem.remove();
        renumberSeq(rmBox);
        return;
      }
      // reorder a sequence row (↑/↓)
      var seqUp = e.target.closest && e.target.closest('[data-seq-up]');
      var seqDown = e.target.closest && e.target.closest('[data-seq-down]');
      if (seqUp || seqDown) {
        var mvBox = (seqUp || seqDown).closest('.modal-box');
        var mvItem = (seqUp || seqDown).closest('[data-seq-item]');
        if (mvItem) {
          if (seqUp && mvItem.previousElementSibling) {
            mvItem.parentNode.insertBefore(mvItem, mvItem.previousElementSibling);
          } else if (seqDown && mvItem.nextElementSibling) {
            mvItem.parentNode.insertBefore(mvItem.nextElementSibling, mvItem);
          }
          renumberSeq(mvBox);
        }
        return;
      }

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
      // multi-plate 3mf upload: the ORDERED print sequence (see renderPlateSelect).
      // Only present when the archive had more than one plate. The list is
      // authoritative: read top-to-bottom into selected_plates WITH duplicates +
      // order (so "BOB" = plate_B, plate_O, plate_B fans out to three jobs).
      var seq = box.querySelector('[data-plate-seq]');
      if (seq) {
        var seqItems = seq.querySelectorAll('[data-seq-item]');
        var plates = Array.prototype.map.call(seqItems, function (li) { return li.getAttribute('data-plate'); });
        if (plates.length === 0) {
          var seqErr = seq.querySelector('[data-seq-error]');
          if (seqErr) seqErr.hidden = false; // block submit, surface inline message
          return;
        }
        payload.selected_plates = plates;
        payload.selected_plate = plates[0]; // legacy back-compat (first plate)
      }
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

    // FTPS upload progress ON THE JOB'S OWN QUEUE CARD (in addition to the header
    // chip above). Only a "job-<id>" context maps to a card; eject/dry-rehearsal
    // have no card and are ignored. No-ops gracefully if htmx hasn't rendered the
    // card yet. The card's .card-progress is server-rendered hidden, so a #dashboard
    // re-render (htmx afterSwap) naturally clears it back to the resting state.
    var JOB_CONTEXT = /^job-(\d+)$/;
    function cardForContext(context) {
      if (typeof context !== 'string') return null;
      var m = JOB_CONTEXT.exec(context);
      if (!m) return null; // non-job context (eject, dry-rehearsal, …)
      return document.querySelector('.card[data-job-id="' + m[1] + '"]');
    }
    function resetCardProgress(wrap) {
      if (!wrap) return;
      wrap.hidden = true;
      var bar = wrap.querySelector('[data-card-progress-bar]');
      if (bar) bar.style.width = '0%';
      var label = wrap.querySelector('[data-card-progress-label]');
      if (label) label.textContent = '';
    }
    function hideAllCardProgress() {
      var wraps = document.querySelectorAll('[data-card-progress]');
      for (var i = 0; i < wraps.length; i++) resetCardProgress(wraps[i]);
    }
    function updateCardUpload(p) {
      if (!p) return;
      var card = cardForContext(p.context);
      if (!card) return; // non-job context, or card not rendered yet
      var wrap = card.querySelector('[data-card-progress]');
      if (!wrap) return;
      var sent = Number(p.bytesSent) || 0;
      var total = Number(p.totalBytes) || 0;
      if (total > 0 && sent >= total) { resetCardProgress(wrap); return; } // done → hide
      var pct = total > 0 ? Math.floor((sent / total) * 100) : 0;
      var bar = wrap.querySelector('[data-card-progress-bar]');
      if (bar) bar.style.width = pct + '%';
      var label = wrap.querySelector('[data-card-progress-label]');
      if (label) label.textContent = '⇪ 送信中 ' + pct + '%';
      wrap.hidden = false;
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
    // coming — drop the chip AND any card bars immediately instead of waiting.
    ['job_failed', 'aborted'].forEach(function (t) {
      es.addEventListener(t, hideUploadChip);
      es.addEventListener(t, hideAllCardProgress);
    });
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
      try {
        var p = JSON.parse(e.data);
        showUploadChip(p);   // header chip (unchanged)
        updateCardUpload(p); // and the specific job's queue card
      } catch (_) {}
    });
  })();
