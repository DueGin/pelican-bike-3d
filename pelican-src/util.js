import * as THREE from 'three';

// ---------- 随机与噪声 ----------
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rand = mulberry32(20260924);
export const rr = (a, b) => a + (b - a) * rand();

const perm = new Uint8Array(512);
(() => {
  const p = [...Array(256).keys()];
  const r = mulberry32(7);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
})();
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y) {
  switch (h & 7) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x; case 5: return -x; case 6: return y; default: return -y;
  }
}
export function noise2(x, y) {
  const xf = Math.floor(x), yf = Math.floor(y);
  const X = xf & 255, Y = yf & 255; x -= xf; y -= yf;
  const u = fade(x), v = fade(y);
  const a = perm[X] + Y, b = perm[X + 1] + Y;
  return lerp(
    lerp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u),
    lerp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u), v);
}
export function fbm2(x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

// ---------- 数学 ----------
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const TAU = Math.PI * 2;

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();

/** 让一个沿 Y 轴、高度为 1 的网格从 a 伸到 b */
export function orientBetween(obj, a, b, stretch = true) {
  _d.subVectors(b, a);
  const len = _d.length() || 1e-6;
  obj.position.copy(a).addScaledVector(_d, 0.5);
  obj.quaternion.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
  if (stretch) obj.scale.set(1, len, 1);
}

/** 生成两点之间的圆柱几何体（用于合并静态结构） */
export function tubeBetween(a, b, r0, r1 = r0, radial = 10) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, _d.subVectors(b, a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

/**
 * 沿曲线挤出可变截面管。
 * radiusFn(t) -> [rUp, rSide, rDown]：rUp/rDown 为截面“上/下”半径，rSide 为侧向半径。
 * side：截面侧向参考轴（保证扁平鸟喙等方向可控）。
 */
export function sweepTube(curve, segs, radial, radiusFn, side = new THREE.Vector3(0, 0, 1), capEnds = true, target = null) {
  const pos = [], uv = [], idx = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), P = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, P);
    curve.getTangentAt(t, T);
    B.copy(side).addScaledVector(T, -side.dot(T)).normalize();
    N.crossVectors(B, T).normalize(); // “上”方向（side=+Z 且曲线朝 +X 时，N=+Y）
    const [ru, rs, rd] = radiusFn(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const rN = c >= 0 ? ru : rd;
      pos.push(P.x + N.x * c * rN + B.x * s * rs, P.y + N.y * c * rN + B.y * s * rs, P.z + N.z * c * rN + B.z * s * rs);
      uv.push(j / radial, t);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * row + j, b = a + row, c = b + 1, d = a + 1;
    idx.push(a, d, b, b, d, c);
  }
  if (capEnds) {
    for (const [ring, t, flip] of [[0, 0, true], [segs, 1, false]]) {
      curve.getPointAt(t, P);
      const center = pos.length / 3;
      pos.push(P.x, P.y, P.z); uv.push(0.5, t);
      for (let j = 0; j < radial; j++) {
        const a = ring * row + j, b = a + 1;
        if (flip) idx.push(center, b, a); else idx.push(center, a, b);
      }
    }
  }
  if (target && target.attributes.position && target.attributes.position.array.length === pos.length) {
    target.attributes.position.array.set(pos);
    target.attributes.position.needsUpdate = true;
    target.computeVertexNormals();
    target.computeBoundingSphere();
    return target;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 两骨 IK：已知根 A、目标 C、骨长 L1/L2 与极向量 pole，返回关节位置 */
const _dir = new THREE.Vector3(), _p = new THREE.Vector3();
export function solveIK(A, C, L1, L2, pole, out) {
  _dir.subVectors(C, A);
  let d = _dir.length();
  _dir.multiplyScalar(1 / (d || 1));
  d = clamp(d, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
  _p.subVectors(pole, A);
  _p.addScaledVector(_dir, -_p.dot(_dir)).normalize();
  return out.copy(A).addScaledVector(_dir, a).addScaledVector(_p, h);
}

/** 由三个轴构造四元数：Y 为主轴，Z 为参考法线 */
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
export function basisQuat(yAxis, zHint, out) {
  _y.copy(yAxis).normalize();
  _x.crossVectors(_y, zHint).normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

// ---------- 画布纹理 ----------
export function canvasTex(w, h, draw, { repeat = null, srgb = true, aniso = 4 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

/** 给几何体整体上一种顶点色（方便合并后仍保留颜色） */
export function paint(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 简单弹簧：用于喉囊抖动、车铃摇晃等 */
export class Spring {
  constructor(k = 120, c = 8) { this.k = k; this.c = c; this.x = 0; this.v = 0; this.target = 0; }
  step(dt) {
    const a = -this.k * (this.x - this.target) - this.c * this.v;
    this.v += a * dt; this.x += this.v * dt; return this.x;
  }
  kick(v) { this.v += v; }
}
