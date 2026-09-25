import * as THREE from 'three';
import { V3, sweepTube, orientBetween, solveIK, basisQuat, canvasTex, Spring, clamp, damp, lerp, TAU } from './util.js';
import { BIKE } from './bicycle.js';

// ---------- 材质 ----------
function featherBump() {
  return canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#808080'; c.fillRect(0, 0, w, h);
    const s = 32;
    for (let row = 0; row < h / s * 2 + 2; row++) {
      for (let col = -1; col < w / s + 1; col++) {
        const x = col * s + (row % 2 ? s / 2 : 0), y = row * s * 0.5;
        const g = c.createRadialGradient(x, y - s * 0.2, 2, x, y, s * 0.62);
        g.addColorStop(0, '#9a9a9a'); g.addColorStop(0.75, '#8a8a8a'); g.addColorStop(1, '#4a4a4a');
        c.fillStyle = g;
        c.beginPath(); c.ellipse(x, y, s * 0.55, s * 0.6, 0, 0, Math.PI); c.fill();
      }
    }
  }, { repeat: [7, 4], srgb: false });
}

export function makePelicanMaterials() {
  const bump = featherBump();
  return {
    feather: new THREE.MeshPhysicalMaterial({ color: 0xf5f4ef, roughness: 0.82, sheen: 1, sheenColor: 0xfff8ec, sheenRoughness: 0.45, bumpMap: bump, bumpScale: 0.6 }),
    featherPlain: new THREE.MeshPhysicalMaterial({ color: 0xf2f1ec, roughness: 0.85, sheen: 0.8, sheenColor: 0xffffff, sheenRoughness: 0.5 }),
    black: new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: 0.55 }),
    bill: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
    pouch: new THREE.MeshPhysicalMaterial({ color: 0xf2a23c, roughness: 0.42, clearcoat: 0.35, sheen: 0.5, sheenColor: 0xffd9a8, sheenRoughness: 0.4 }),
    leg: new THREE.MeshStandardMaterial({ color: 0xf1935b, roughness: 0.5 }),
    eyeWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 }),
    iris: new THREE.MeshPhysicalMaterial({ color: 0x1a120c, roughness: 0.05, clearcoat: 1 }),
    glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    skin: new THREE.MeshStandardMaterial({ color: 0xf6b98c, roughness: 0.5 }),
    helmet: new THREE.MeshPhysicalMaterial({ color: 0x5fb8a6, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }),
    vent: new THREE.MeshStandardMaterial({ color: 0x21393b, roughness: 0.6 }),
    crest: new THREE.MeshStandardMaterial({ color: 0xf7efd5, roughness: 0.8 }),
  };
}

function scarfTexture() {
  return canvasTex(64, 256, (c, w, h) => {
    const n = 10;
    for (let i = 0; i < n; i++) { c.fillStyle = i % 2 ? '#f4f1ea' : '#1f2f5a'; c.fillRect(0, (i * h) / n, w, h / n + 1); }
    c.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < h; y += 3) c.fillRect(0, y, w, 1);
  });
}

// ---------- 身体部件 ----------
export function bodyGeometry() {
  const g = new THREE.SphereGeometry(1, 44, 30);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = x > 0 ? 1 : 1 + 0.38 * x;
    const belly = y < 0 ? 1.08 : 1;
    p.setXYZ(i, x * 0.34, y * 0.26 * k * belly, z * 0.25 * k);
  }
  g.computeVertexNormals();
  g.rotateZ(0.36);
  return g;
}

function colorBill(geo, stops) {
  const uv = geo.attributes.uv, n = uv.count;
  const col = new Float32Array(n * 3);
  const cs = stops.map(([t, c]) => [t, new THREE.Color(c)]);
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const t = uv.getY(i);
    let k = 0; while (k < cs.length - 2 && t > cs[k + 1][0]) k++;
    const [t0, c0] = cs[k], [t1, c1] = cs[k + 1];
    tmp.copy(c0).lerp(c1, clamp((t - t0) / (t1 - t0), 0, 1));
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** 头部（含眼睛、鸟喙、喉囊、头盔、羽冠）。原点为头部中心 */
export function makeHead(M, { helmet = true } = {}) {
  const head = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.086, 32, 24), M.featherPlain);
  skull.scale.set(1.18, 0.95, 0.9);
  head.add(skull);
  // 前额向鸟喙过渡
  const brow = new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 14), M.featherPlain);
  brow.scale.set(1.6, 0.9, 0.95); brow.position.set(0.06, -0.005, 0);
  head.add(brow);

  const B = (x, y) => V3(x - 0.12, y - 1.8, 0); // 从骑行坐标转头部局部坐标
  // 上喙
  const upperCurve = new THREE.CatmullRomCurve3([B(0.165, 1.79), B(0.4, 1.742), B(0.62, 1.668), B(0.715, 1.628)]);
  const upper = sweepTube(upperCurve, 48, 16, (t) => {
    const tip = t > 0.9 ? 1 - (t - 0.9) / 0.1 * 0.6 : 1;
    return [0.024 * (1 - 0.45 * t) * tip, 0.042 * (1 - 0.42 * t) * tip, 0.007 * tip];
  });
  colorBill(upper, [[0, '#f2b98a'], [0.18, '#f4b04a'], [0.75, '#f29c38'], [1, '#e67f36']]);
  const upperMesh = new THREE.Mesh(upper, M.bill);
  head.add(upperMesh);
  // 喙尖弯钩
  const hookCurve = new THREE.CatmullRomCurve3([B(0.7, 1.634), B(0.735, 1.625), B(0.748, 1.598)]);
  const hook = new THREE.Mesh(colorBill(sweepTube(hookCurve, 10, 10, (t) => { const r = 0.013 * (1 - 0.7 * t); return [r, r, r]; }), [[0, '#e9853a'], [1, '#d9442e']]), M.bill);
  head.add(hook);

  // 下颌（可张开）
  const jaw = new THREE.Group();
  const hinge = B(0.165, 1.768);
  jaw.position.copy(hinge);
  head.add(jaw);
  const J = (x, y) => B(x, y).sub(hinge);
  const lowerCurve = new THREE.CatmullRomCurve3([J(0.165, 1.768), J(0.4, 1.722), J(0.62, 1.65), J(0.705, 1.617)]);
  const lower = sweepTube(lowerCurve, 40, 12, (t) => [0.006, 0.038 * (1 - 0.4 * t), 0.011 * (1 - 0.3 * t)]);
  colorBill(lower, [[0, '#f0bb8a'], [0.5, '#f2ab3e'], [1, '#e98a3a']]);
  jaw.add(new THREE.Mesh(lower, M.bill));
  // 喉囊（弹簧抖动）
  const pouchPivot = new THREE.Group();
  pouchPivot.position.copy(J(0.36, 1.71));
  jaw.add(pouchPivot);
  const P = (x, y) => J(x, y).sub(pouchPivot.position);
  const pouchCurve = new THREE.CatmullRomCurve3([P(0.06, 1.735), P(0.22, 1.72), P(0.45, 1.685), P(0.66, 1.628)]);
  const pouchGeo = sweepTube(pouchCurve, 40, 20, (t) => {
    const sag = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 1.3) * (1 - 0.35 * t);
    return [0.012, 0.036 * (1 - 0.4 * t) + 0.006, 0.014 + 0.105 * sag];
  });
  const pouch = new THREE.Mesh(pouchGeo, M.pouch);
  pouchPivot.add(pouch);

  // 眼睛
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(0.045, 0.028, s * 0.066);
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.027, 20, 14), M.eyeWhite);
    eye.add(white);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.018, 18, 12), M.iris);
    iris.position.set(0.008, 0.002, s * 0.013); eye.add(iris);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 8, 6), M.glint);
    glint.position.set(0.017, 0.012, s * 0.024); eye.add(glint);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.006, 8, 24), M.skin);
    ring.position.set(0, 0, s * 0.008); eye.add(ring);
    head.add(eye); eyes.push(eye);
  }

  // 羽冠
  const crests = [];
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.09 - i * 0.012, 8), M.crest);
    const pivot = new THREE.Group();
    pivot.position.set(-0.085, 0.035 - i * 0.012, (i - 1.5) * 0.018);
    c.position.y = 0.04;
    pivot.rotation.z = 1.15 + i * 0.12;
    pivot.add(c); head.add(pivot); crests.push(pivot);
  }

  if (helmet) {
    const hg = new THREE.Group();
    hg.position.set(-0.02, 0.05, 0); hg.rotation.z = 0.08;
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 14, 0, TAU, 0, Math.PI / 2), M.helmet);
    shell.scale.set(1.22, 0.9, 1.02);
    hg.add(shell);
    const brim = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.006, 6, 40), M.vent);
    brim.rotation.x = Math.PI / 2; brim.scale.set(1.22, 1.02, 1); hg.add(brim);
    for (const z of [-0.045, 0, 0.045]) {
      const arc = 2.0;
      const f = Math.sqrt(1 - (z / 0.102) ** 2);
      const v = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.005, 6, 28, arc), M.vent);
      v.rotation.z = (Math.PI - arc) / 2;
      v.scale.set(1.22 * f + 0.004, 0.9 * f + 0.004, 1);
      v.position.z = z; hg.add(v);
    }
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8, 0, TAU, 0, Math.PI / 2), M.helmet);
    visor.scale.set(0.9, 0.15, 1.6); visor.position.set(0.1, 0.012, 0); visor.rotation.z = -0.25;
    hg.add(visor);
    head.add(hg);
  }
  head.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { head, jaw, pouchPivot, eyes, crests };
}

function webbedFoot(M) {
  const s = new THREE.Shape();
  s.moveTo(-0.02, -0.012);
  s.quadraticCurveTo(0.03, -0.03, 0.095, -0.05);
  s.quadraticCurveTo(0.08, -0.028, 0.105, -0.018);
  s.quadraticCurveTo(0.09, -0.004, 0.118, 0.0);
  s.quadraticCurveTo(0.09, 0.004, 0.105, 0.018);
  s.quadraticCurveTo(0.08, 0.028, 0.095, 0.05);
  s.quadraticCurveTo(0.03, 0.03, -0.02, 0.012);
  s.quadraticCurveTo(-0.03, 0, -0.02, -0.012);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 8 });
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.008, 0);
  const m = new THREE.Mesh(g, M.leg);
  m.castShadow = true;
  return m;
}

// ---------- 围巾（Verlet 布条） ----------
class ScarfTail {
  constructor(n, seg, width, mat) {
    this.n = n; this.seg = seg; this.width = width;
    this.p = Array.from({ length: n }, () => new THREE.Vector3());
    this.o = Array.from({ length: n }, () => new THREE.Vector3());
    const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), idx = [];
    for (let i = 0; i < n; i++) { uv.set([0, i / (n - 1), 1, i / (n - 1)], i * 4); if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.castShadow = true; this.mesh.frustumCulled = false;
    this.inited = false;
  }
  reset(anchor, back) {
    for (let i = 0; i < this.n; i++) { this.p[i].copy(anchor).addScaledVector(back, i * this.seg); this.o[i].copy(this.p[i]); }
    this.inited = true;
  }
  step(dt, anchor, wind, colliders, back) {
    if (!this.inited) this.reset(anchor, back);
    const g = -3.2, drag = 7;
    const v = new THREE.Vector3();
    for (let i = 1; i < this.n; i++) {
      const p = this.p[i], o = this.o[i];
      v.subVectors(p, o).multiplyScalar(1 / dt);
      const ax = (wind.x - v.x) * drag, ay = (wind.y - v.y) * drag + g, az = (wind.z - v.z) * drag;
      const nx = p.x + (p.x - o.x) * 0.985 + ax * dt * dt;
      const ny = p.y + (p.y - o.y) * 0.985 + ay * dt * dt;
      const nz = p.z + (p.z - o.z) * 0.985 + az * dt * dt;
      o.copy(p); p.set(nx, ny, nz);
    }
    this.p[0].copy(anchor); this.o[0].copy(anchor);
    const d = new THREE.Vector3();
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < this.n - 1; i++) {
        const a = this.p[i], b = this.p[i + 1];
        d.subVectors(b, a); const len = d.length() || 1e-6;
        const diff = (len - this.seg) / len;
        if (i === 0) b.addScaledVector(d, -diff);
        else { a.addScaledVector(d, diff * 0.5); b.addScaledVector(d, -diff * 0.5); }
      }
      for (const [c, r] of colliders) for (let i = 1; i < this.n; i++) {
        d.subVectors(this.p[i], c); const l = d.length();
        if (l < r) this.p[i].copy(c).addScaledVector(d, r / (l || 1));
      }
    }
  }
  write(up) {
    const pos = this.geo.attributes.position.array;
    const t = new THREE.Vector3(), w = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      const a = this.p[Math.max(i - 1, 0)], b = this.p[Math.min(i + 1, this.n - 1)];
      t.subVectors(b, a).normalize();
      w.copy(up).addScaledVector(t, -up.dot(t)).normalize().multiplyScalar(this.width * (1 - 0.25 * i / this.n) * 0.5);
      const p = this.p[i];
      pos.set([p.x - w.x, p.y - w.y, p.z - w.z, p.x + w.x, p.y + w.y, p.z + w.z], i * 6);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }
}

// ---------- 骑车的鹈鹕 ----------
export function createPelican() {
  const M = makePelicanMaterials();
  const root = new THREE.Group();
  root.name = 'pelican';

  const HIP_C = V3(-0.27, 1.06, 0);
  const upper = new THREE.Group(); upper.position.copy(HIP_C); root.add(upper);
  const U = (x, y, z = 0) => V3(x, y, z).sub(HIP_C); // 骑行坐标 -> upper 局部

  const body = new THREE.Mesh(bodyGeometry(), M.feather);
  body.position.copy(U(-0.15, 1.24)); body.castShadow = true; body.receiveShadow = true;
  upper.add(body);
  // 尾羽
  for (let i = 0; i < 5; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), M.featherPlain);
    f.scale.set(0.085, 0.022, 0.045);
    f.position.copy(U(-0.47 - (2 - Math.abs(i - 2)) * 0.008, 1.12 - Math.abs(i - 2) * 0.006, (i - 2) * 0.03));
    f.rotation.set(0, (i - 2) * 0.35, 0.5);
    f.castShadow = true; upper.add(f);
  }
  // 锚点
  const anchor = (x, y, z = 0) => { const o = new THREE.Object3D(); o.position.copy(U(x, y, z)); upper.add(o); return o; };
  const neckBaseA = anchor(0.03, 1.36);
  const shoulderA = [anchor(-0.03, 1.37, 0.19), anchor(-0.03, 1.37, -0.19)];
  const hipA = [anchor(-0.26, 1.05, 0.105), anchor(-0.26, 1.05, -0.105)];
  const knotA = anchor(-0.02, 1.47, 0);

  // 肩部覆羽
  for (const s of [1, -1]) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), M.feather);
    c.scale.set(0.11, 0.08, 0.06); c.position.copy(U(-0.06, 1.36, s * 0.175)); c.rotation.z = 0.5;
    c.castShadow = true; upper.add(c);
  }

  // 颈（每帧重建）
  const neckMesh = new THREE.Mesh(new THREE.BufferGeometry(), M.featherPlain);
  neckMesh.castShadow = true; neckMesh.frustumCulled = false;
  root.add(neckMesh);

  // 围巾环
  const scarfMat = new THREE.MeshStandardMaterial({ map: scarfTexture(), roughness: 0.9, side: THREE.DoubleSide });
  const scarfRing = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.032, 12, 28), scarfMat);
  root.add(scarfRing); scarfRing.castShadow = true;
  const tails = [new ScarfTail(11, 0.05, 0.075, scarfMat), new ScarfTail(9, 0.05, 0.07, scarfMat)];

  // 头
  const H0 = V3(0.12, 1.8, 0);
  const { head, jaw, pouchPivot, eyes, crests } = makeHead(M);
  head.position.copy(H0); root.add(head);
  const headAttach = new THREE.Object3D(); headAttach.position.set(-0.035, -0.055, 0); head.add(headAttach);
  const povA = new THREE.Object3D(); povA.position.set(0.2, 0.11, 0); head.add(povA);
  const neckCurve = new THREE.CatmullRomCurve3([V3(), V3(), V3(), V3(), V3()]);
  const neckR = (u) => { const r = lerp(0.088, 0.058, Math.pow(u, 0.8)); return [r, r * 0.94, r * 1.04]; };

  // 翅膀
  const wingParts = [];
  const unit = new THREE.SphereGeometry(1, 18, 12);
  for (const s of [1, -1]) {
    const mk = (mat) => { const m = new THREE.Mesh(unit, mat); m.castShadow = true; root.add(m); return m; };
    const w = {
      s, upperArm: mk(M.feather), fore: mk(M.feather), second: mk(M.black), hand: mk(M.featherPlain),
      prim: Array.from({ length: 6 }, () => mk(M.black)), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(),
    };
    wingParts.push(w);
  }

  // 腿
  const legParts = [];
  for (const s of [1, -1]) {
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.072, 1, 16), M.feather);
    const cuff = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), M.featherPlain);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.024, 1, 10), M.leg);
    const ankle = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), M.leg);
    const heel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 1, 8), M.leg);
    const foot = webbedFoot(M);
    for (const m of [thigh, cuff, shin, ankle, heel, foot]) { m.castShadow = true; root.add(m); }
    legParts.push({ s, thigh, cuff, shin, ankle, heel, foot, knee: new THREE.Vector3() });
  }

  const pouchSpring = new Spring(160, 5);
  const st = {
    jaw: 0, jawTarget: 0, squawkT: 0, blinkT: 2, wave: 0, waveT: 0, lookYaw: 0, lookPitch: 0,
    headOff: new THREE.Vector3(), prevHeadY: 0, footDown: 0,
  };

  const tmp = {
    S: new THREE.Vector3(), E: new THREE.Vector3(), W: new THREE.Vector3(), G: new THREE.Vector3(), n: new THREE.Vector3(),
    a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion(), pole: new THREE.Vector3(),
    hip: new THREE.Vector3(), ank: new THREE.Vector3(), fp: new THREE.Vector3(),
  };
  const worldTmp = { anchor: new THREE.Vector3(), c: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3() };
  const NECK_O1 = V3(-0.035, 0.12, 0), NECK_O2 = V3(-0.035, -0.1, 0), NECK_O3 = V3(0.02, 0.03, 0);
  const W = { fdir: V3(), trailing: V3(), back: V3(), dir: V3(), a: V3(), b: V3(), secA: V3(), secB: V3(), side: V3(), tmp: V3() };

  function placeEllipsoid(mesh, a, b, width, thick, normal) {
    tmp.c.subVectors(b, a);
    const len = tmp.c.length();
    mesh.position.copy(a).addScaledVector(tmp.c, 0.5);
    basisQuat(tmp.c, normal, mesh.quaternion);
    mesh.scale.set(width, len * 0.5, thick);
  }

  function localOf(obj, out) { return out.copy(obj.position).applyMatrix4(obj.parent.matrix); }

  return {
    root, head, tails, M,
    povAnchor: povA,
    squawk() { st.squawkT = 0.9; pouchSpring.kick(3); },
    wave() { st.waveT = 2.6; },
    isBusy() { return st.waveT > 0 || st.squawkT > 0; },
    /**
     * ctx: { dt, t, crank, speed, lean, grips:[rig-local R, L], pedals:[R, L], look: rig-local 目标或 null,
     *        stopped:0..1, rig: Object3D, wind: world Vector3 }
     */
    update(ctx) {
      const { dt, t, crank, speed } = ctx;
      const effort = clamp(speed / 8, 0, 1);
      // 上半身随踏频左右摆动、微微前倾
      upper.rotation.set(Math.sin(crank) * 0.045 * (0.4 + effort), 0, -0.05 - 0.08 * effort + ctx.stopped * 0.05);
      upper.position.copy(HIP_C);
      upper.position.y += Math.abs(Math.sin(crank)) * 0.008 * effort;
      upper.updateMatrix();

      // 头部：像真正的鸟一样稳住脑袋，并反向抵消车身倾斜
      st.squawkT = Math.max(0, st.squawkT - dt);
      st.jawTarget = st.squawkT > 0 ? 0.42 * Math.min(1, st.squawkT * 4) * (0.75 + 0.25 * Math.sin(t * 38)) : 0;
      st.jaw = damp(st.jaw, st.jawTarget, 18, dt);
      jaw.rotation.z = -st.jaw;
      let yawT = 0, pitchT = 0;
      if (ctx.look) {
        tmp.a.copy(ctx.look).sub(head.position);
        yawT = clamp(Math.atan2(-tmp.a.z, tmp.a.x), -1.1, 1.1);
        pitchT = clamp(Math.atan2(tmp.a.y, Math.hypot(tmp.a.x, tmp.a.z)), -0.35, 0.4);
      }
      st.lookYaw = damp(st.lookYaw, yawT, 4, dt);
      st.lookPitch = damp(st.lookPitch, pitchT, 4, dt);
      const nod = Math.sin(t * 1.3) * 0.03 + (st.squawkT > 0 ? 0.35 : 0);
      head.position.set(H0.x - 0.02 * effort, H0.y + Math.abs(Math.sin(crank)) * 0.003, H0.z);
      head.rotation.set(-ctx.lean * 0.7, st.lookYaw, st.lookPitch * 0.8 + nod - 0.04 * effort, 'YXZ');
      head.updateMatrix();
      // 眨眼
      st.blinkT -= dt;
      const blink = st.blinkT < 0.12 && st.blinkT > 0 ? 0.12 : 1;
      if (st.blinkT < 0) st.blinkT = 2 + Math.random() * 4;
      for (const e of eyes) e.scale.y = damp(e.scale.y, blink, 40, dt);
      // 喉囊：随头部上下加速度晃动
      const hy = head.position.y;
      const vy = (hy - st.prevHeadY) / Math.max(dt, 1e-3);
      st.prevHeadY = hy;
      pouchSpring.target = 0.05 * Math.sin(2 * crank) * effort + clamp(-vy * 0.5, -0.05, 0.05);
      if (Math.random() < dt * 0.3 * effort) pouchSpring.kick(0.6 * (Math.random() - 0.3));
      const j = clamp(pouchSpring.step(dt), -0.25, 0.35);
      pouchPivot.scale.set(1, 1 + j + st.jaw * 0.6, 1 - j * 0.3);
      // 羽冠迎风抖动
      crests.forEach((c, i) => { c.rotation.x = Math.sin(t * (13 + i * 3) + i) * 0.08 * (0.3 + effort); });

      // 颈部重建
      localOf(neckBaseA, tmp.a);
      localOf(headAttach, tmp.b);
      const cp = neckCurve.points;
      cp[0].copy(tmp.a); cp[1].copy(tmp.a).add(NECK_O1); cp[2].copy(tmp.b).add(NECK_O2); cp[3].copy(tmp.b); cp[4].copy(tmp.b).add(NECK_O3);
      neckCurve.updateArcLengths();
      const curve = neckCurve;
      const ng = sweepTube(curve, 22, 16, neckR, undefined, true, neckMesh.geometry);
      if (ng !== neckMesh.geometry) { neckMesh.geometry.dispose(); neckMesh.geometry = ng; }

      // 围巾环贴在颈根
      const ringPos = curve.getPointAt(0.16);
      const ringDir = curve.getTangentAt(0.16);
      scarfRing.position.copy(ringPos);
      scarfRing.quaternion.setFromUnitVectors(V3(0, 0, 1), ringDir);

      // 翅膀：握把 or 挥手
      st.waveT = Math.max(0, st.waveT - dt);
      st.wave = damp(st.wave, st.waveT > 0.25 ? 1 : 0, 6, dt);
      for (let i = 0; i < 2; i++) {
        const w = wingParts[i], s = w.s;
        localOf(shoulderA[i], tmp.S);
        tmp.G.copy(ctx.grips[i]).add(V3(0, 0.022, 0));
        if (s < 0 && st.wave > 0.001) {
          tmp.W.copy(tmp.S).add(V3(0.1 + Math.sin(t * 9) * 0.03, 0.34, -0.2 + Math.sin(t * 11) * 0.08));
          tmp.G.lerp(tmp.W, st.wave);
        }
        tmp.pole.copy(tmp.S).add(V3(-0.2, 0.12, s * 0.4));
        solveIK(tmp.S, tmp.G, 0.23, 0.27, tmp.pole, w.elbow);
        // 手腕位置（IK 可能够不到，按实际骨长）
        tmp.c.subVectors(tmp.G, w.elbow); w.wrist.copy(w.elbow).addScaledVector(tmp.c.normalize(), Math.min(0.27, tmp.G.distanceTo(w.elbow)));
        tmp.a.subVectors(w.elbow, tmp.S); tmp.b.subVectors(w.wrist, w.elbow);
        tmp.n.crossVectors(tmp.a, tmp.b).normalize().multiplyScalar(s);
        if (tmp.n.lengthSq() < 1e-6) tmp.n.set(0, 1, 0);
        placeEllipsoid(w.upperArm, tmp.S, w.elbow, 0.075, 0.042, tmp.n);
        placeEllipsoid(w.fore, w.elbow, w.wrist, 0.07, 0.034, tmp.n);
        // 次级飞羽（黑色后缘）
        const fdir = W.fdir.copy(tmp.b).normalize();
        const trailing = W.trailing.set(-1, -0.5, 0);
        trailing.addScaledVector(fdir, -fdir.dot(trailing)).normalize();
        W.secA.copy(w.elbow).addScaledVector(trailing, 0.05); W.secB.copy(w.wrist).addScaledVector(trailing, 0.035);
        placeEllipsoid(w.second, W.secA, W.secB, 0.045, 0.02, tmp.n);
        w.hand.position.copy(w.wrist); w.hand.scale.set(0.042, 0.036, 0.04);
        // 初级飞羽：从手腕向后张开，随风抖动
        const back = W.back.copy(fdir).negate();
        W.side.set(0, 0, s);
        for (let k = 0; k < 6; k++) {
          const flutter = Math.sin(t * (22 + k * 3) + k * 1.7 + s) * 0.05 * (0.3 + effort) + st.wave * Math.sin(t * 9 + k) * 0.1;
          const dir = W.dir.copy(back).multiplyScalar(0.9).addScaledVector(trailing, 0.15 + 0.13 * k + flutter + st.wave * 0.2).addScaledVector(W.side, 0.08).normalize();
          const len = 0.2 - k * 0.016;
          W.a.copy(w.wrist).addScaledVector(trailing, 0.01 * k);
          W.b.copy(W.a).addScaledVector(dir, len);
          placeEllipsoid(w.prim[k], W.a, W.b, 0.022, 0.009, tmp.n);
        }
      }

      // 腿：两骨 IK 踩脚踏；停车时右脚落地
      for (let i = 0; i < 2; i++) {
        const L = legParts[i];
        localOf(hipA[i], tmp.hip);
        tmp.fp.copy(ctx.pedals[i]).add(V3(-0.03, 0.012, 0));
        if (i === 0 && ctx.stopped > 0.001) {
          const ground = V3(-0.1, 0.02 + Math.tan(Math.abs(ctx.lean)) * 0.4, 0.4);
          tmp.fp.lerp(ground, ctx.stopped);
        }
        tmp.ank.copy(tmp.fp).add(V3(-0.01, 0.055, 0));
        tmp.pole.copy(tmp.hip).add(V3(0.5, 0.25, L.s * 0.05));
        solveIK(tmp.hip, tmp.ank, 0.43, 0.48, tmp.pole, L.knee);
        tmp.c.subVectors(tmp.ank, L.knee);
        const reach = Math.min(0.48, tmp.c.length());
        tmp.ank.copy(L.knee).addScaledVector(tmp.c.normalize(), reach);
        orientBetween(L.thigh, tmp.hip, L.knee);
        L.cuff.position.copy(L.knee);
        orientBetween(L.shin, L.knee, tmp.ank);
        L.ankle.position.copy(tmp.ank);
        tmp.fp.copy(tmp.ank).add(V3(0.01, -0.052, 0));
        orientBetween(L.heel, tmp.ank, tmp.fp);
        L.foot.position.copy(tmp.fp);
        L.foot.rotation.set(0, -L.s * 0.12, 0);
      }
    },
    /** 围巾物理：在世界坐标中模拟 */
    updateScarf(dt, wind, rig) {
      root.updateMatrixWorld();
      knotA.getWorldPosition(worldTmp.anchor);
      worldTmp.up.set(0, 1, 0).applyQuaternion(rig.quaternion);
      worldTmp.back.set(-1, 0, 0).applyQuaternion(rig.quaternion);
      body.getWorldPosition(worldTmp.c);
      const colliders = [[worldTmp.c.clone(), 0.27]];
      const sub = 3, h = Math.min(dt, 1 / 30) / sub;
      tails.forEach((tl, k) => {
        const anchor = worldTmp.anchor.clone().addScaledVector(V3(0, 0, 1).applyQuaternion(rig.quaternion), (k ? -1 : 1) * 0.02);
        for (let i = 0; i < sub; i++) tl.step(h, anchor, wind, colliders, worldTmp.back);
        tl.write(worldTmp.up);
      });
    },
  };
}

// ---------- 停在木桩上的鹈鹕（码头用） ----------
export function createPerchedPelican(M = makePelicanMaterials()) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry(), M.feather);
  body.rotation.z = 0.25; body.position.y = 0.34; body.castShadow = true; g.add(body);
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), M.featherPlain);
    wing.scale.set(0.34, 0.13, 0.05); wing.position.set(-0.06, 0.38, s * 0.22); wing.rotation.z = 0.35; wing.castShadow = true; g.add(wing);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), M.black);
    tip.scale.set(0.22, 0.06, 0.035); tip.position.set(-0.3, 0.3, s * 0.2); tip.rotation.z = 0.25; g.add(tip);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.16, 8), M.leg);
    leg.position.set(-0.02, 0.09, s * 0.08); g.add(leg);
    const foot = webbedFoot(M); foot.position.set(-0.03, 0, s * 0.08); g.add(foot);
  }
  const neck = new THREE.Mesh(sweepTube(new THREE.CatmullRomCurve3([V3(0.18, 0.5, 0), V3(0.14, 0.64, 0), V3(0.2, 0.72, 0), V3(0.24, 0.8, 0)]), 16, 12, (u) => { const r = lerp(0.085, 0.058, u); return [r, r, r]; }), M.featherPlain);
  neck.castShadow = true; g.add(neck);
  const h = makeHead(M, { helmet: false });
  h.head.position.set(0.26, 0.85, 0);
  h.head.rotation.z = -0.35;
  g.add(h.head);
  g.userData.head = h.head;
  g.userData.jaw = h.jaw;
  return g;
}
