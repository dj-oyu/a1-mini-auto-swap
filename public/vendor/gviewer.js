// G-CODE toolpath preview (Part A). Renders the SELECTED plate's sliced gcode —
// the only real geometry in a printable .gcode.3mf, since Bambu strips the mesh
// on slice. Uses the vendored gcode-preview (npm 2.18.0, MIT), which parses
// Bambu's default G2/G3 arcs (arc fitting is ON by default; a naive G0/G1 parser
// corrupts curves) and splits travel/extrusion.
//
// Isolation: gcode-preview bundles its OWN three 0.159; it is imported by an
// ABSOLUTE path (not the "three" import-map specifier), so it never collides with
// viewer.js's three r185. This viewer only touches containers whose renderer flag
// is gcode: `.viewer[data-gcode-url]` (data-preview-kind="gcode"). Mesh
// containers (data-model-url) belong to viewer.js — the two never overlap.
//
// Source (mirrors viewer.js): the active plate is chosen from (priority) the
// active tab (.plate-tab.is-active[data-plate]), a checked radio
// (input[name="plate"]:checked), else the viewer's own data-plate seed. Clicking
// a tab / changing a radio re-fetches + re-processes the gcode IN THE SAME WebGL
// context (clear() → processGCode() → render()). Progressive: if WebGL, the
// fetch, or the parse fails, the container's fallback <img> thumbnail stays.
import { init } from "/vendor/gcode-preview.js";

/** The active plate id for this container, or null. */
function plateOf(el) {
  const modal = el.closest(".modal-box") || el.parentElement;
  const tab = modal && modal.querySelector(".plate-tab.is-active[data-plate]");
  const radio = modal && modal.querySelector('input[name="plate"]:checked');
  return (
    (tab && tab.getAttribute("data-plate")) ||
    (radio && radio.value) ||
    el.getAttribute("data-plate") ||
    null
  );
}

/** URL of the active plate's gcode, or null when no plate is resolvable. */
function gcodeUrl(el, plate) {
  const base = el.getAttribute("data-gcode-url");
  return base && plate ? base + "?plate=" + encodeURIComponent(plate) : null;
}

/** Build the gcode-preview instance ONCE per container (own canvas + own three).
 *  Returns null when WebGL is unavailable / init throws (keep the thumbnail). */
function ensurePreview(el) {
  if (el.__gpreview !== undefined) return el.__gpreview;
  const canvas = document.createElement("canvas");
  canvas.className = "gviewer-canvas";
  el.appendChild(canvas); // sized by `.viewer canvas{width/height:100%}` (app.css)
  let preview = null;
  try {
    preview = init({
      canvas,
      buildVolume: { x: 180, y: 180, z: 180 }, // A1 mini bed
      renderExtrusion: true,
      renderTravel: false,
      renderTubes: false,
      extrusionColor: el.getAttribute("data-color") || "#4b9fea",
      backgroundColor: "#f6f7f9",
    });
  } catch (e) {
    canvas.remove();
  }
  el.__gpreview = preview; // cache the result (incl. null) so we init only once
  return preview;
}

/** Fetch + render the current plate's gcode; leave the thumbnail on any failure. */
function loadGcode(el) {
  const url = gcodeUrl(el, plateOf(el));
  if (!url) return;
  fetch(url)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("no gcode"))))
    .then((text) => {
      const preview = ensurePreview(el);
      if (!preview) return;
      preview.clear(); // reset on plate switch — reuse the same context
      preview.processGCode(text); // parses G0/G1 + G2/G3 arcs
      preview.render();
      const fb = el.querySelector(".viewer-fallback");
      if (fb) fb.style.display = "none"; // success → drop the thumbnail
      el.classList.add("viewer-live", "gviewer-live");
    })
    .catch(() => {
      /* leave the fallback thumbnail in place */
    });
}

function initOne(el) {
  el.dataset.gready = "1";
  if (!window.WebGLRenderingContext) return; // keep the fallback img
  const modal = el.closest(".modal-box") || el.parentElement;
  if (modal) {
    // Tabs (read-only preview + multi-plate confirm): activate + reload.
    modal.querySelectorAll(".plate-tab[data-plate]").forEach((tab) =>
      tab.addEventListener("click", () => {
        modal.querySelectorAll(".plate-tab").forEach((t) => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        loadGcode(el);
      }),
    );
    // Radios (print-selection): reload on change.
    modal.querySelectorAll('input[name="plate"]').forEach((r) =>
      r.addEventListener("change", () => loadGcode(el)),
    );
  }
  loadGcode(el);
}

/** Scan for freshly-inserted gcode viewers and initialize each once. */
function initGViewers() {
  document.querySelectorAll(".viewer[data-gcode-url]:not([data-gready])").forEach(initOne);
}

window.initGViewers = initGViewers;
window.addEventListener("DOMContentLoaded", initGViewers);
// modals are injected by htmx after load → init the new gcode viewer then too
document.body.addEventListener("htmx:afterSwap", initGViewers);
initGViewers();
