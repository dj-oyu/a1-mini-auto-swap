// 3D preview viewer (spec 17 §9 / MVP #6). Loads the merged mesh from
// GET /api/queue/:id/model into a Three.js scene with custom pointer-drag
// rotation + wheel zoom (no OrbitControls addon needed). Progressive: if WebGL
// or the fetch fails, the container's fallback <img> thumbnail stays visible.
//
// Vendored Three.js (no CDN — LAN/tailnet self-hosted). `three` is resolved by
// the import map in the page head to /vendor/three.module.min.js.
import * as THREE from "three";

function initOne(el) {
  el.dataset.ready = "1";
  const url = el.getAttribute("data-model-url");
  if (!url || !window.WebGLRenderingContext) return; // keep the fallback img

  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no model"))))
    .then((mesh) => mount(el, mesh))
    .catch(() => {
      /* leave the fallback thumbnail in place */
    });
}

function mount(el, data) {
  const positions = Float32Array.from(data.positions || []);
  const indices = data.indices || [];
  if (!positions.length || !indices.length) return;

  const width = el.clientWidth || 400;
  const height = el.clientHeight || 260;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7f9);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(el.getAttribute("data-color") || "#4b9fea"),
    metalness: 0.1,
    roughness: 0.75,
    flatShading: false,
  });
  const model = new THREE.Mesh(geo, material);

  // center the model at the origin so drag-rotation spins around its middle
  const sphere = geo.boundingSphere;
  const group = new THREE.Group();
  model.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
  group.add(model);
  // 3MF is Z-up; tilt to a pleasant default 3/4 view
  group.rotation.x = -Math.PI / 2;
  scene.add(group);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(1, 1, 1);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-1, 0.5, -1);
  scene.add(fill);

  const radius = sphere.radius || 50;
  const camera = new THREE.PerspectiveCamera(45, width / height, radius / 100, radius * 20);
  let dist = radius * 2.6;
  camera.position.set(0, 0, dist);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  el.innerHTML = "";
  el.appendChild(renderer.domElement);
  el.classList.add("viewer-live");

  function render() {
    camera.position.z = dist;
    renderer.render(scene, camera);
  }
  render();

  // recolor hook: the confirm modal calls this when a slot color changes
  el.__setColor = (hex) => {
    if (hex) material.color.set(hex);
    render();
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
    render();
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
      dist = Math.max(radius * 1.1, Math.min(radius * 8, dist * (1 + Math.sign(e.deltaY) * 0.12)));
      render();
    },
    { passive: false },
  );
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
