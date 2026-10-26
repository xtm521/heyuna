// Lazy-loaded original geometry: no external textures, models or network requests.
import * as THREE from 'three';
import { animate } from 'motion';
let introPlayed = false;
export function createSproutScene(host: HTMLElement): () => void {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(33, 1, .1, 30); camera.position.set(0, .15, 7.8);
  const group = new THREE.Group(); scene.add(group);
  const geometries: THREE.BufferGeometry[] = []; const materials: THREE.Material[] = [];
  const endpoints = [new THREE.Vector3(-1.25, 1.05, .12), new THREE.Vector3(1.2, 1.26, -.18), new THREE.Vector3(.12, 1.5, .3)];
  for (let ribbon = 0; ribbon < 3; ribbon++) {
    const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(0, -1.35, 0), new THREE.Vector3(ribbon === 0 ? -.1 : .12, -.25, .3), new THREE.Vector3(endpoints[ribbon].x * 1.3, .45, -.35), endpoints[ribbon]);
    const positions: number[] = []; const indices: number[] = [];
    for (let i = 0; i <= 64; i++) {
      const t = i / 64; const p = curve.getPoint(t); const tangent = curve.getTangent(t);
      const side = new THREE.Vector3(-tangent.y, tangent.x, Math.sin(t * Math.PI * 1.5 + ribbon) * .8).normalize();
      const width = Math.sin(t * Math.PI) * (.22 + ribbon * .025) + .006;
      for (const sign of [-1, 1]) { const v = p.clone().addScaledVector(side, width * sign); positions.push(v.x, v.y, v.z); }
      if (i < 64) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometries.push(geometry);
    const material = new THREE.MeshPhysicalMaterial({ color: ribbon === 1 ? 0x4fe0ba : 0xd3dedb, metalness: .82, roughness: .26, clearcoat: .6, side: THREE.DoubleSide }); materials.push(material); group.add(new THREE.Mesh(geometry, material));
  }
  scene.add(new THREE.HemisphereLight(0xeafff7, 0x35524d, 2.2));
  for (const [x, y, z, intensity] of [[-3, 4, 4, 7], [3, 1, -2, 5], [0, -2, 4, 2]]) { const light = new THREE.DirectionalLight(0xffffff, intensity); light.position.set(x, y, z); scene.add(light); }
  host.appendChild(renderer.domElement); renderer.domElement.setAttribute('aria-hidden', 'true');
  let disposed = false; let frame = 0; let last = 0;
  const size = () => { const width = Math.max(1, host.clientWidth); const height = Math.max(1, host.clientHeight); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); };
  const observer = new ResizeObserver(size); observer.observe(host); size();
  const progress = { value: introPlayed ? 1 : 0 }; const intro = introPlayed ? null : animate(0, 1, { duration: 1.1, ease: [.2, .75, .2, 1], onUpdate: value => { progress.value = value; } }); introPlayed = true;
  const draw = (now: number) => { if (disposed) return; frame = requestAnimationFrame(draw); if (now - last < 1000 / 30) return; last = now; group.rotation.y = Math.sin(now / 9000) * .15 + (1 - progress.value) * -.6; group.rotation.z = -.05; group.scale.setScalar(.86 + progress.value * .14); renderer.render(scene, camera); };
  frame = requestAnimationFrame(draw);
  const dispose = () => { if (disposed) return; disposed = true; cancelAnimationFrame(frame); intro?.stop(); observer.disconnect(); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); renderer.renderLists.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); };
  renderer.domElement.addEventListener('webglcontextlost', dispose, { once: true });
  return dispose;
}
