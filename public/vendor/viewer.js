// 3D preview viewer (spec 17 §9 / MVP #6 + task #23 per-plate tabs). Loads a
// mesh into a Three.js scene with custom pointer-drag rotation + wheel zoom (no
// OrbitControls addon needed). Progressive: if WebGL or the fetch fails, the
// container's fallback <img> thumbnail stays visible.
//
// Sources:
//   • data-model-url         → GET /api/queue/:id/model    (whole-archive scene)
//   • data-plate-mesh (base) → GET /api/plate-mesh?job=:id&plate=plate_N
// When data-plate-mesh is present the viewer renders the ACTUAL selected plate.
// The active plate is chosen from (in priority order) the active tab
// (.plate-tab.is-active[data-plate], read-only preview), a checked radio
// (input[name="plate"]:checked, print-selection confirm modal), or the viewer's
// own data-plate seed. Clicking a tab / changing a radio reloads the mesh IN THE
// SAME WebGL context — the old BufferGeometry+material are disposed and the new
// geometry is loaded, recentering the camera on its bounding sphere (no new
// renderer/context per switch). Falls back to /model then the thumbnail.
//
// Vendored Three.js (no CDN — LAN/tailnet self-hosted). `three` is resolved by
// the import map in the page head to /vendor/three.module.min.js.
import * as THREE from "three";

/** URL of the active plate's mesh, or null when this isn't a plate viewer. */
function plateUrl(el) {
  const base = el.getAttribute("data-plate-mesh");
  if (!base) return null;
  const modal = el.closest(".modal-box") || el.parentElement;
  const tab = modal && modal.querySelector(".plate-tab.is-active[data-plate]");
  const radio = modal && modal.querySelector('input[name="plate"]:checked');
  const plate =
    (tab && tab.getAttribute("data-plate")) ||
    (radio && radio.value) ||
    el.getAttribute("data-plate");
  return plate ? base + "&plate=" + encodeURIComponent(plate) : null;
}

function initOne(el) {
  el.dataset.ready = "1";
  if (!window.WebGLRenderingContext) return; // keep the fallback img

  if (el.getAttribute("data-plate-mesh")) {
    const modal = el.closest(".modal-box") || el.parentElement;
    if (modal) {
      // Tabs (read-only preview): activate the clicked tab, then swap geometry.
      modal.querySelectorAll(".plate-tab[data-plate]").forEach((tab) =>
        tab.addEventListener("click", () => {
          modal.querySelectorAll(".plate-tab").forEach((t) => t.classList.remove("is-active"));
          tab.classList.add("is-active");
          load(el);
        }),
      );
      // Radios (print-selection confirm modal): reload on change.
      modal.querySelectorAll('input[name="plate"]').forEach((r) =>
        r.addEventListener("change", () => load(el)),
      );
    }
  }
  load(el);
}

function fetchMesh(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error("no model"))));
}
function hasGeometry(mesh) {
  return !!mesh && (mesh.positions || []).length > 0 && (mesh.indices || []).length > 0;
}

/** Fetch the current mesh (active plate, else whole model) and show it. On
 *  failure keep whatever is shown; a failed plate mesh falls back to /model. */
function load(el) {
  const pUrl = plateUrl(el);
  const modelUrl = el.getAttribute("data-model-url");
  const primary = pUrl || modelUrl;
  if (!primary) return;
  fetchMesh(primary)
    .then((mesh) => {
      if (hasGeometry(mesh)) show(el, mesh);
    })
    .catch(() => {
      if (pUrl && modelUrl) {
        fetchMesh(modelUrl)
          .then((mesh) => {
            if (hasGeometry(mesh)) show(el, mesh);
          })
          .catch(() => {
            /* leave the fallback thumbnail in place */
          });
      }
      /* else: leave the fallback thumbnail in place */
    });
}

/** Build the persistent renderer/scene/camera/interaction ONCE per container.
 *  Geometry is swapped in later via setGeometry — never a new context. */
function ensureContext(el) {
  if (el.__ctx) return el.__ctx;

  const width = el.clientWidth || 400;
  const height = el.clientHeight || 260;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7f9);
  const group = new THREE.Group();
  group.rotation.x = -Math.PI / 2; // 3MF is Z-up; tilt to a pleasant 3/4 view
  scene.add(group);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(1, 1, 1);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-1, 0.5, -1);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 5000);
  camera.position.set(0, 0, 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  el.innerHTML = "";
  el.appendChild(renderer.domElement);
  el.classList.add("viewer-live");

  const ctx = { renderer, scene, camera, group, mesh: null, material: null, radius: 50, dist: 130 };
  ctx.render = () => {
    camera.position.z = ctx.dist;
    renderer.render(scene, camera);
  };

  // pointer-drag rotate
  let dragging = false;
  let px = 0;
  let py = 0;
  const dom = renderer.domElement;
  dom.style.touchAction = "none";
  dom.style.cursor = "grab";
  dom.addEventListener("pointerdown", (e) => {
    dragging = true;
    px = e.clientX;
    py = e.clientY;
    dom.setPointerCapture(e.pointerId);
    dom.style.cursor = "grabbing";
  });
  dom.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    group.rotation.y += (e.clientX - px) * 0.01;
    group.rotation.x += (e.clientY - py) * 0.01;
    px = e.clientX;
    py = e.clientY;
    ctx.render();
  });
  const endDrag = (e) => {
    dragging = false;
    dom.style.cursor = "grab";
    if (e.pointerId != null && dom.hasPointerCapture?.(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  };
  dom.addEventListener("pointerup", endDrag);
  dom.addEventListener("pointercancel", endDrag);
  // wheel zoom
  dom.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      ctx.dist = Math.max(ctx.radius * 1.1, Math.min(ctx.radius * 8, ctx.dist * (1 + Math.sign(e.deltaY) * 0.12)));
      ctx.render();
    },
    { passive: false },
  );

  // recolor hook: the confirm modal calls this when a slot color changes
  el.__setColor = (hex) => {
    if (hex && ctx.material) ctx.material.color.set(hex);
    ctx.render();
  };

  el.__ctx = ctx;
  return ctx;
}

/** Swap in new geometry, disposing the previous BufferGeometry+material, and
 *  recenter the camera on the new bounding sphere. Reuses the same context. */
function setGeometry(ctx, el, data) {
  if (ctx.mesh) {
    ctx.group.remove(ctx.mesh);
    ctx.mesh.geometry.dispose();
    ctx.mesh.material.dispose();
    ctx.mesh = null;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(data.positions || []), 3));
  geo.setIndex(data.indices || []);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(el.getAttribute("data-color") || "#4b9fea"),
    metalness: 0.1,
    roughness: 0.75,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, material);

  const sphere = geo.boundingSphere;
  mesh.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
  ctx.group.add(mesh);
  ctx.mesh = mesh;
  ctx.material = material;

  ctx.radius = sphere.radius || 50;
  ctx.dist = ctx.radius * 2.6;
  ctx.camera.near = Math.max(ctx.radius / 100, 0.01);
  ctx.camera.far = ctx.radius * 20;
  ctx.camera.updateProjectionMatrix();
  ctx.render();
}

function show(el, data) {
  if (!(data.positions || []).length || !(data.indices || []).length) return;
  const ctx = ensureContext(el);
  setGeometry(ctx, el, data);
}

/** Scan for freshly-inserted .viewer containers and initialize each once. */
function initViewers() {
  document.querySelectorAll(".viewer[data-model-url]:not([data-ready])").forEach(initOne);
}

window.initViewers = initViewers;
window.addEventListener("DOMContentLoaded", initViewers);
// modals are injected by htmx after load → init the new viewer then too
document.body.addEventListener("htmx:afterSwap", initViewers);
initViewers();
