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
})();
