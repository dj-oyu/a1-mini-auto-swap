// Shared client helpers for the dashboard (app.js) and projects (projects.js)
// pages — the small bits that were previously copy-pasted between them.
(function () {
  var PF = (window.PF = window.PF || {});

  // "15:40" style local clock for ETA display.
  PF.fmtClock = function (epoch) {
    try { return new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return '--:--'; }
  };

  // One-shot fetch of the live printer status; cb receives the JSON or null.
  PF.fetchPrinterStatus = function (cb) {
    fetch('/api/printer/status')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(cb)
      .catch(function () { cb(null); });
  };

  // Surfaces an EventSource's connectivity as a small, calm indicator (spec 17:
  // red is reserved for "stop" — this is amber/neutral, not alarming). `el` is
  // the chip element (hidden by default in the markup); shown while the stream
  // is down, hidden again once the browser's auto-reconnect brings it back up.
  PF.watchConnection = function (es, el) {
    if (!es || !el) return;
    es.addEventListener('error', function () { el.hidden = false; });
    es.addEventListener('open', function () { el.hidden = true; });
  };
})();
