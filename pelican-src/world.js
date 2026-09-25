import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { V3, TAU, lerp, clamp, smooth, fbm2, noise2, rand, rr, sweepTube, canvasTex, paint, tubeBetween, mulberry32 } from './util.js';
import { createPerchedPelican, makePelicanMaterials } from './pelican.js';

// =============== 环岛公路 ===============
export const HALF_W = 3.2;
export const LANE = 1.5; // 骑行车道相对中心线向右偏移
const roadR = (a) => 92 + 13 * Math.sin(2 * a + 0.4) + 7 * Math.cos(3 * a + 1.1) + 4 * Math.sin(5 * a);

function buildRoad() {
  const M = 1440;
  const raw = [];
  for (let i = 0; i < M; i++) { const a = (i / M) * TAU, r = roadR(a); raw.push([r * Math.cos(a), r * Math.sin(a)]); }
  const cum = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) { const [x0, z0] = raw[i], [x1, z1] = raw[(i + 1) % M]; cum[i + 1] = cum[i] + Math.hypot(x1 - x0, z1 - z0); }
  const L = cum[M];
  const heightAtS = (s) => { const u = (s / L) * TAU; return 3.4 + 1.8 * Math.sin(2 * u + 0.6) + 0.7 * Math.sin(5 * u + 2); };
  const N = 4096, ds = L / N;
  const px = new Float32Array(N), pz = new Float32Array(N), py = new Float32Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j]);
    const [x0, z0] = raw[j], [x1, z1] = raw[(j + 1) % M];
    px[i] = lerp(x0, x1, t); pz[i] = lerp(z0, z1, t); py[i] = heightAtS(s);
  }
  const tx = new Float32Array(N), tz = new Float32Array(N), kap = new Float32Array(N), slope = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    const dx = px[b] - px[a], dz = pz[b] - pz[a], l = Math.hypot(dx, dz);
    tx[i] = dx / l; tz[i] = dz / l;
    slope[i] = (py[b] - py[a]) / (2 * ds);
  }
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    const dtx = (tx[b] - tx[a]) / (2 * ds), dtz = (tz[b] - tz[a]) / (2 * ds);
    kap[i] = dtx * -tz[i] + dtz * tx[i]; // 向右为正
  }
  // 平滑曲率
  const k2 = new Float32Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let k = -12; k <= 12; k++) s += kap[(i + k + N) % N]; k2[i] = s / 25; }

  function sample(s, o = {}) {
    s = ((s % L) + L) % L;
    const f = s / ds, i = Math.floor(f) % N, b = (i + 1) % N, t = f - Math.floor(f);
    o.x = lerp(px[i], px[b], t); o.y = lerp(py[i], py[b], t); o.z = lerp(pz[i], pz[b], t);
    let ttx = lerp(tx[i], tx[b], t), ttz = lerp(tz[i], tz[b], t); const l = Math.hypot(ttx, ttz); ttx /= l; ttz /= l;
    o.tx = ttx; o.tz = ttz; o.rx = -ttz; o.rz = ttx; // right = 内侧（陆地）
    o.slope = lerp(slope[i], slope[b], t); o.kappa = lerp(k2[i], k2[b], t);
    return o;
  }
  // 最近点（利用道路是关于原点的星形曲线：角度 -> 采样索引查找表）
  const ABINS = 2048, angIdx = new Int32Array(ABINS);
  {
    const ang = (i) => (Math.atan2(pz[i], px[i]) + TAU) % TAU;
    let j = 0;
    for (let k = 0; k < ABINS; k++) { const a = (k / ABINS) * TAU; while (j < N - 1 && ang(j + 1) < a && ang(j + 1) > ang(j) - 1) j++; angIdx[k] = j; }
  }
  function nearest(x, z) {
    const a = (Math.atan2(z, x) + TAU) % TAU; const i0 = angIdx[Math.floor((a / TAU) * ABINS) % ABINS];
    let best = 1e9, bi = 0;
    for (let k = -420; k <= 420; k += 4) {
      const i = (i0 + k + N) % N; const dx = x - px[i], dz = z - pz[i]; const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    for (let k = -3; k <= 3; k++) {
      const i = (bi + k + N) % N; const dx = x - px[i], dz = z - pz[i]; const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    const outside = Math.hypot(x, z) > Math.hypot(px[bi], pz[bi]);
    return { d: Math.sqrt(best), h: py[bi], s: bi * ds, outside };
  }
  return { L, N, ds, px, py, pz, sample, nearest, roadR };
}

// =============== 地形 ===============
const LH_ANGLE = 0.95, PIER_ANGLE = 3.75;

function buildTerrain(road) {
  const SIZE = 640, SEG = 256;
  const lhR = roadR(LH_ANGLE) + 36;
  const LH = V3(Math.cos(LH_ANGLE) * lhR, 0, Math.sin(LH_ANGLE) * lhR);

  function rawHeight(x, z) {
    const n = road.nearest(x, z);
    const rp = Math.hypot(x, z);
    const n1 = fbm2(x * 0.018 + 11, z * 0.018 - 7, 3);
    let h;
    const t = n.d - HALF_W - 0.7;
    if (t <= 0) h = n.h - 0.06;
    else if (n.outside) {
      const e = 6 + 4 * n1;
      if (t < e) h = lerp(n.h - 0.06, 1.35, smooth(0, e, t));
      else if (t < e + 20) h = lerp(1.35, -0.6, (t - e) / 20) + 0.08 * Math.sin(x * 0.7 + z * 0.3);
      else h = Math.max(-0.6 - (t - e - 20) * 0.2, -16);
    } else {
      const hill = 3 + 22 * Math.max(0, fbm2(x * 0.011 + 3, z * 0.011 - 2, 4) + 0.28) + 16 * smooth(85, 5, rp);
      h = n.h - 0.06 + smooth(0, 38, t) * hill + 0.25 * fbm2(x * 0.1, z * 0.1, 2) * smooth(0, 6, t);
    }
    // 灯塔岬角
    const dl = Math.hypot(x - LH.x, z - LH.z);
    const cape = 8.5 * Math.exp(-(dl * dl) / (2 * 15 * 15)) + 1.2 * fbm2(x * 0.08, z * 0.08, 3) * Math.exp(-(dl * dl) / (2 * 22 * 22));
    if (n.outside && t > 0) h = Math.max(h, cape - 0.8 + (h > 0 ? 0 : h * 0.1));
    return h;
  }

  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const grid = new Float32Array((SEG + 1) * (SEG + 1));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = rawHeight(x, z);
    pos.setY(i, h); grid[i] = h;
  }
  geo.computeVertexNormals();
  // 顶点色：沙滩、湿沙、草地、干草、岩石、路肩碎石
  const nrm = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  const C = (h) => new THREE.Color(h);
  const sand = C('#e6d3a3'), wet = C('#b8a376'), grass = C('#6f9a4c'), grass2 = C('#9aa860'), rock = C('#8f8a80'), gravel = C('#a39b8c'), deep = C('#c8b688');
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ny = nrm.getY(i);
    const n = road.nearest(x, z);
    const v = fbm2(x * 0.05, z * 0.05, 3);
    if (y < -0.2) tmp.copy(deep).lerp(sand, clamp(1 + y * 0.2, 0, 1));
    else if (y < 0.35) tmp.copy(wet);
    else if (n.outside && y < 1.7 && n.d > HALF_W + 3) tmp.copy(sand).lerp(C('#efdcb0'), clamp(v + 0.5, 0, 1));
    else tmp.copy(grass).lerp(grass2, clamp(v * 1.6 + 0.5, 0, 1));
    if (ny < 0.78) tmp.lerp(rock, smooth(0.78, 0.6, ny));
    if (n.d < HALF_W + 1.4) tmp.copy(gravel);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;

  const half = SIZE / 2, cell = SIZE / SEG;
  function heightAt(x, z) {
    const fx = (x + half) / cell, fz = (z + half) / cell;
    if (fx < 0 || fz < 0 || fx >= SEG || fz >= SEG) return -16;
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const r = SEG + 1;
    const a = grid[iz * r + ix], b = grid[iz * r + ix + 1], c = grid[(iz + 1) * r + ix], d = grid[(iz + 1) * r + ix + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }
  // 给水面用的高度纹理（半精度浮点）
  const TS = 256;
  const data = new Uint16Array(TS * TS);
  for (let j = 0; j < TS; j++) for (let i = 0; i < TS; i++) {
    const x = -half + (i + 0.5) / TS * SIZE, z = -half + (j + 0.5) / TS * SIZE;
    data[j * TS + i] = THREE.DataUtils.toHalfFloat(heightAt(x, z));
  }
  const htex = new THREE.DataTexture(data, TS, TS, THREE.RedFormat, THREE.HalfFloatType);
  htex.magFilter = htex.minFilter = THREE.LinearFilter; htex.needsUpdate = true;
  return { mesh, heightAt, htex, half, SIZE, LH };
}

// =============== 路面 ===============
function roadTexture() {
  return canvasTex(256, 1024, (c, w, h) => {
    c.fillStyle = '#4a4d52'; c.fillRect(0, 0, w, h);
    const r = mulberry32(3);
    for (let i = 0; i < 26000; i++) { const g = 55 + r() * 60; c.fillStyle = `rgba(${g},${g},${g + 4},${0.35 + r() * 0.4})`; c.fillRect(r() * w, r() * h, 1.5, 1.5); }
    // 修补痕迹
    for (let i = 0; i < 6; i++) { c.fillStyle = 'rgba(30,32,35,0.25)'; c.beginPath(); c.ellipse(r() * w, r() * h, 20 + r() * 40, 30 + r() * 80, r(), 0, TAU); c.fill(); }
    // 白色边线 + 黄色中央虚线（一张图代表 8 米）
    c.fillStyle = '#e9e6dc'; c.fillRect(10, 0, 7, h); c.fillRect(w - 17, 0, 7, h);
    c.fillStyle = '#e8b93c'; c.fillRect(w / 2 - 4, 0, 8, h * 0.42);
  }, { repeat: [1, 1] });
}

function buildRoadMesh(road) {
  const N = 2048, L = road.L;
  const pos = new Float32Array((N + 1) * 2 * 3), uv = new Float32Array((N + 1) * 2 * 2), idx = [];
  const o = {};
  for (let i = 0; i <= N; i++) {
    const s = (i / N) * L; road.sample(s, o);
    const w = HALF_W + 0.25;
    pos.set([o.x - o.rx * w, o.y + 0.02, o.z - o.rz * w, o.x + o.rx * w, o.y + 0.02, o.z + o.rz * w], i * 6);
    uv.set([0, s / 8, 1, s / 8], i * 4);
    if (i < N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // 确保法线朝上
  const n = g.attributes.normal; if (n.getY(0) < 0) { g.setIndex(idx.map((v, k) => idx[k - (k % 3) + (2 - (k % 3))])); g.computeVertexNormals(); }
  const tex = roadTexture();
  tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping;
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, metalness: 0 }));
  m.receiveShadow = true;
  return m;
}

/** 路面涂装：“鹈鹕专用道” */
function roadDecals(road, group) {
  const tex = canvasTex(256, 512, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#eceae0'; c.fillStyle = '#eceae0'; c.lineWidth = 12; c.lineCap = 'round';
    // 自行车
    c.save(); c.translate(w / 2, 150);
    c.beginPath(); c.arc(-62, 30, 40, 0, TAU); c.stroke(); c.beginPath(); c.arc(62, 30, 40, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(-62, 30); c.lineTo(-10, 30); c.lineTo(30, -25); c.lineTo(-25, -25); c.lineTo(-10, 30); c.moveTo(30, -25); c.lineTo(62, 30); c.moveTo(22, -40); c.lineTo(40, -40); c.stroke();
    // 鹈鹕剪影（身体 + 长喙）
    c.beginPath(); c.ellipse(-20, -70, 34, 24, -0.3, 0, TAU); c.fill();
    c.beginPath(); c.moveTo(0, -85); c.quadraticCurveTo(12, -130, 8, -140); c.lineTo(20, -140); c.quadraticCurveTo(26, -110, 16, -80); c.fill();
    c.beginPath(); c.arc(14, -142, 13, 0, TAU); c.fill();
    c.beginPath(); c.moveTo(22, -148); c.lineTo(96, -128); c.lineTo(88, -120); c.lineTo(22, -132); c.fill();
    c.restore();
    c.font = 'bold 60px "PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif';
    c.textAlign = 'center'; c.fillText('鹈鹕专用道', w / 2, 330);
    c.font = 'bold 40px "PingFang SC","Noto Sans SC",sans-serif'; c.fillText('PELICANS ONLY', w / 2, 400);
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, opacity: 0.85 });
  const o = {};
  for (const f of [0.08, 0.33, 0.58, 0.83]) {
    road.sample(f * road.L, o);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 3.2), mat);
    m.rotation.order = 'YXZ';
    m.rotation.y = Math.atan2(o.tx, o.tz) + Math.PI; m.rotation.x = -Math.PI / 2;
    m.position.set(o.x + o.rx * LANE, o.y + 0.045, o.z + o.rz * LANE);
    m.receiveShadow = true; group.add(m);
  }
}

// =============== 水面 ===============
function buildWater(terr) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) },
    uZenith: { value: new THREE.Color('#4f88d0') }, uHorizon: { value: new THREE.Color('#cfe2f0') },
    uDeep: { value: new THREE.Color('#0b4a66') }, uShallow: { value: new THREE.Color('#37c3c0') },
    uHeight: { value: terr.htex }, uHalf: { value: terr.half }, uSize: { value: terr.SIZE },
    uLight: { value: 1 }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uNight: { value: 0 },
  }]);
  uniforms.uHeight.value = terr.htex;
  const mat = new THREE.ShaderMaterial({
    uniforms, fog: true, transparent: true,
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float sw = sin(wp.x*0.045 + uTime*0.8)*0.12 + sin(wp.z*0.06 - uTime*1.1)*0.08 + sin((wp.x+wp.z)*0.11 + uTime*1.7)*0.04;
        wp.y += sw;
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uZenith; uniform vec3 uHorizon;
      uniform vec3 uDeep; uniform vec3 uShallow; uniform sampler2D uHeight; uniform float uHalf; uniform float uSize;
      uniform float uLight; uniform vec3 uMoonDir; uniform float uNight;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
      vec2 waveGrad(vec2 p, float t){
        vec2 g = vec2(0.0);
        // 方向波叠加
        vec2 d1=normalize(vec2(1.0,0.35)), d2=normalize(vec2(-0.4,1.0)), d3=normalize(vec2(0.8,-0.9)), d4=normalize(vec2(-1.0,-0.2));
        g += d1*cos(dot(d1,p)*0.9 + t*1.3)*0.9*0.08;
        g += d2*cos(dot(d2,p)*1.6 + t*1.9)*1.6*0.04;
        g += d3*cos(dot(d3,p)*3.1 + t*2.6)*3.1*0.018;
        g += d4*cos(dot(d4,p)*5.3 + t*3.4)*5.3*0.009;
        // 细碎噪声
        float e = 0.15;
        vec2 q = p*1.7 + vec2(t*0.35, -t*0.22);
        float n0 = vnoise(q), nx = vnoise(q+vec2(e,0.0)), nz = vnoise(q+vec2(0.0,e));
        g += vec2(nx-n0, nz-n0)/e*0.05;
        vec2 q2 = p*4.3 + vec2(-t*0.6, t*0.5);
        float m0 = vnoise(q2), mx = vnoise(q2+vec2(e,0.0)), mz = vnoise(q2+vec2(0.0,e));
        g += vec2(mx-m0, mz-m0)/e*0.022;
        return g;
      }
      void main(){
        vec3 V = normalize(cameraPosition - vWorld);
        float dist = length(cameraPosition - vWorld);
        vec2 g = waveGrad(vWorld.xz, uTime) * mix(1.0, 0.25, smoothstep(40.0, 500.0, dist));
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec2 huv = (vWorld.xz + uHalf) / uSize;
        float th = -16.0;
        if (huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0) th = texture2D(uHeight, huv).r;
        float depth = max(vWorld.y - th, 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.45, R.y));
        vec3 water = mix(uShallow, uDeep, smoothstep(0.0, 9.0, depth));
        float diff = 0.35 + 0.65 * max(dot(N, uSunDir), 0.0);
        water *= diff * uLight;
        vec3 col = mix(water, sky, fres * 0.9);
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 350.0) * 5.0 + pow(max(dot(N, H), 0.0), 40.0) * 0.12;
        col += uSunColor * spec * step(0.0, uSunDir.y);
        vec3 Hm = normalize(uMoonDir + V);
        col += vec3(0.7,0.8,1.0) * pow(max(dot(N, Hm), 0.0), 300.0) * 2.5 * uNight;
        // 岸边浪花
        float n = vnoise(vWorld.xz*0.6 + uTime*0.2);
        float band = sin(depth * 7.0 - uTime * 1.8 + n * 4.0) * 0.5 + 0.5;
        float foam = (1.0 - smoothstep(0.0, 0.7, depth)) * smoothstep(0.35, 0.9, band + (1.0-smoothstep(0.0,0.18,depth)));
        foam = max(foam, (1.0 - smoothstep(0.0, 0.1, depth)) * 0.9);
        col = mix(col, vec3(0.95,0.97,0.98) * (0.12 + 0.88*uLight*uLight), clamp(foam, 0.0, 1.0) * 0.85);
        float alpha = mix(0.35, 0.96, smoothstep(0.0, 3.5, depth));
        alpha = max(alpha, foam * 0.9);
        alpha = mix(alpha, 1.0, smoothstep(60.0, 200.0, dist));
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const geo = new THREE.PlaneGeometry(5000, 5000, 320, 320); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0;
  mesh.renderOrder = 1;
  return { mesh, uniforms };
}
export function waveHeight(x, z, t) {
  return Math.sin(x * 0.045 + t * 0.8) * 0.12 + Math.sin(z * 0.06 - t * 1.1) * 0.08 + Math.sin((x + z) * 0.11 + t * 1.7) * 0.04;
}

// =============== 天空、星星、月亮 ===============
function buildStars() {
  const n = 2600, pos = new Float32Array(n * 3), sz = new Float32Array(n), ph = new Float32Array(n);
  const r = mulberry32(99);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, th = r() * TAU; const y = Math.abs(u) * 0.98 + 0.02; const s = Math.sqrt(1 - y * y);
    pos.set([Math.cos(th) * s * 1800, y * 1800, Math.sin(th) * s * 1800], i * 3);
    sz[i] = Math.pow(r(), 6) * 3.2 + 0.8; ph[i] = r() * TAU;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
  g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uPR: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: `attribute float size; attribute float phase; uniform float uTime; uniform float uPR; varying float vA;
      void main(){ vA = 0.6 + 0.4*sin(uTime*2.0 + phase*7.0); vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = size*uPR; }`,
    fragmentShader: `uniform float uOpacity; varying float vA; void main(){ vec2 c = gl_PointCoord-0.5; float d = length(c); float a = smoothstep(0.5,0.0,d); gl_FragColor = vec4(vec3(1.0,0.97,0.9)*a*vA*uOpacity*2.0, 1.0); }`,
  });
  const p = new THREE.Points(g, mat); p.frustumCulled = false; p.renderOrder = -1;
  return p;
}

/** 暮光天幕：Preetham 天空在太阳落下后会迅速变黑，这里补上蓝调时刻的深蓝与地平线余晖 */
function buildTwilight() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTwilight: { value: 0 }, uNight: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uSunDir; uniform float uTwilight; uniform float uNight; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float above = smoothstep(-0.04, 0.02, d.y);
        float h = max(d.y, 0.0);
        vec2 sh = normalize(uSunDir.xz + 1e-5);
        float toward = dot(normalize(d.xz + 1e-5), sh) * 0.5 + 0.5;
        vec3 zenith = vec3(0.015, 0.035, 0.11), horizon = vec3(0.09, 0.14, 0.32);
        vec3 base = mix(horizon, zenith, pow(h, 0.45));
        vec3 glow = mix(vec3(0.55, 0.22, 0.28), vec3(1.0, 0.45, 0.16), toward);
        float g = pow(1.0 - h, 7.0) * (0.25 + 0.75 * pow(toward, 3.0));
        vec3 col = base * (uTwilight * 1.1 + uNight * 0.4) + glow * g * uTwilight * 0.8;
        gl_FragColor = vec4(col * above, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1700, 48, 24), mat);
  m.frustumCulled = false; m.renderOrder = -2;
  return m;
}

function buildMoon() {
  const tex = canvasTex(256, 256, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,250,235,1)'); g.addColorStop(0.18, 'rgba(250,244,225,1)'); g.addColorStop(0.2, 'rgba(210,220,255,0.35)');
    g.addColorStop(0.45, 'rgba(160,180,255,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(190,185,170,0.5)';
    for (const [x, y, r] of [[118, 112, 8], [140, 136, 6], [122, 145, 4], [136, 116, 3]]) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  });
  const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  m.scale.setScalar(420);
  m.renderOrder = -1;
  return m;
}

// =============== 植被与道具 ===============
function leafTexture() {
  return canvasTex(128, 512, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#3f6b2a'; c.lineWidth = 5; c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
    for (let y = 10; y < h - 6; y += 9) {
      const t = y / h; const len = (w / 2 - 4) * Math.sin(Math.PI * Math.pow(t, 0.8));
      for (const s of [-1, 1]) {
        const g = c.createLinearGradient(w / 2, y, w / 2 + s * len, y + 30);
        g.addColorStop(0, '#4f8a33'); g.addColorStop(1, '#8dbb4e');
        c.strokeStyle = g; c.lineWidth = 5; c.beginPath(); c.moveTo(w / 2, y); c.quadraticCurveTo(w / 2 + s * len * 0.6, y + 6, w / 2 + s * len, y + 26); c.stroke();
      }
    }
  });
}

function palmGeometry() {
  const curve = new THREE.CatmullRomCurve3([V3(0, -0.4, 0), V3(0.25, 2, 0), V3(0.9, 4.2, 0), V3(1.8, 6, 0)]);
  const trunk = sweepTube(curve, 30, 9, (t) => { const r = lerp(0.26, 0.14, t) * (1 + 0.1 * Math.max(0, Math.sin(t * 90))); return [r, r, r]; });
  const uv = trunk.attributes.uv, n = uv.count, col = new Float32Array(n * 3);
  const a = new THREE.Color('#7a5a3c'), b = new THREE.Color('#a58458'), tc = new THREE.Color();
  for (let i = 0; i < n; i++) { const t = uv.getY(i); tc.copy(a).lerp(b, 0.5 + 0.5 * Math.sin(t * 90)); col.set([tc.r, tc.g, tc.b], i * 3); }
  trunk.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const top = curve.getPoint(1);
  const parts = [trunk];
  // 椰子
  for (let k = 0; k < 4; k++) {
    const s = new THREE.SphereGeometry(0.16, 10, 8).translate(top.x + Math.cos(k * 1.7) * 0.2, top.y - 0.25, Math.sin(k * 1.7) * 0.2);
    paint(s, '#5b4a22'); s.deleteAttribute('uv'); s.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(s.attributes.position.count * 2), 2));
    parts.push(s);
  }
  const trunkGeo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  // 叶片
  const leaves = [];
  const K = 10;
  for (let k = 0; k < K; k++) {
    const ang = (k / K) * TAU + (k % 2) * 0.2;
    const dir = V3(Math.cos(ang), 0, Math.sin(ang));
    const side = V3(-dir.z, 0, dir.x);
    const len = 3 + (k % 3) * 0.4, up = 0.9 + (k % 2) * 0.4;
    const S = 12, pos = [], uvs = [], idx = [];
    for (let i = 0; i <= S; i++) {
      const u = i / S;
      const c = top.clone().addScaledVector(dir, u * len).add(V3(0, up * u - (up + 1.8) * u * u, 0));
      const w = 0.55 * Math.sin(Math.PI * Math.pow(u, 0.7)) + 0.03;
      const tilt = V3(0, 0.25, 0);
      const l = c.clone().addScaledVector(side, -w).add(tilt.clone().multiplyScalar(w)), r = c.clone().addScaledVector(side, w).add(tilt.clone().multiplyScalar(w));
      pos.push(l.x, l.y, l.z, r.x, r.y, r.z); uvs.push(0, u, 1, u);
      if (i < S) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx); g.computeVertexNormals();
    leaves.push(g.toNonIndexed());
  }
  return { trunkGeo, leafGeo: mergeGeometries(leaves) };
}

function umbrellaTexture(c1, c2) {
  return canvasTex(256, 64, (c, w, h) => { const n = 8; for (let i = 0; i < n; i++) { c.fillStyle = i % 2 ? c1 : c2; c.fillRect((i * w) / n, 0, w / n + 1, h); } });
}

function houseTexture(wall) {
  // 墙面 + 窗户（emissive 蒙版在另一张图）
  const draw = (lit) => (c, w, h) => {
    c.fillStyle = lit ? '#000' : wall; c.fillRect(0, 0, w, h);
    for (const x of [30, 150]) {
      c.fillStyle = lit ? '#ffcf7a' : '#2b3a48'; c.fillRect(x, 60, 70, 70);
      if (!lit) { c.strokeStyle = '#f5f2ea'; c.lineWidth = 8; c.strokeRect(x, 60, 70, 70); c.beginPath(); c.moveTo(x + 35, 60); c.lineTo(x + 35, 130); c.moveTo(x, 95); c.lineTo(x + 70, 95); c.stroke(); }
    }
    c.fillStyle = lit ? '#000' : '#3d6f8a'; c.fillRect(105, 150, 46, 100);
  };
  return { map: canvasTex(256, 256, draw(false)), emissive: canvasTex(256, 256, draw(true)) };
}

function lighthouseTexture() {
  return canvasTex(64, 512, (c, w, h) => {
    const n = 7; for (let i = 0; i < n; i++) { c.fillStyle = i % 2 ? '#f3f1ea' : '#c8433a'; c.fillRect(0, (i * h) / n, w, h / n + 1); }
    c.fillStyle = '#20303a'; for (const y of [0.3, 0.55, 0.78]) c.fillRect(w / 2 - 5, h * y, 10, 18);
  });
}

// =============== 创建世界 ===============
export function createWorld(scene) {
  const road = buildRoad();
  const terr = buildTerrain(road);
  scene.add(terr.mesh);
  const roadMesh = buildRoadMesh(road);
  scene.add(roadMesh);
  const deco = new THREE.Group(); scene.add(deco);
  roadDecals(road, deco);
  const water = buildWater(terr);
  scene.add(water.mesh);

  // 天空
  const sky = new Sky();
  sky.scale.setScalar(4000);
  sky.frustumCulled = false;
  const su = sky.material.uniforms;
  su.turbidity.value = 3.5; su.rayleigh.value = 1.6; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
  su.cloudCoverage.value = 0.38; su.cloudDensity.value = 0.45; su.cloudElevation.value = 0.55; su.cloudScale.value = 0.00022; su.cloudSpeed.value = 0.00003;
  scene.add(sky);
  const stars = buildStars(); scene.add(stars);
  const twilight = buildTwilight(); scene.add(twilight);
  const moon = buildMoon(); scene.add(moon);

  // 光照
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x857a60, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 140;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // ---------- 护栏（海侧白色木栅栏） ----------
  const o = {};
  {
    const posts = [], railPts = [[], []];
    for (let s = 0; s < road.L; s += 2.6) {
      road.sample(s, o);
      const x = o.x - o.rx * (HALF_W + 0.9), z = o.z - o.rz * (HALF_W + 0.9);
      posts.push([x, o.y - 0.1, z, Math.atan2(o.tx, o.tz)]);
    }
    for (let s = 0; s <= road.L + 1; s += 1.3) {
      road.sample(s, o);
      for (let r = 0; r < 2; r++) railPts[r].push(V3(o.x - o.rx * (HALF_W + 0.9), o.y + 0.45 + r * 0.38, o.z - o.rz * (HALF_W + 0.9)));
    }
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 1.1, 0.1).translate(0, 0.55, 0), new THREE.MeshStandardMaterial({ color: 0xf1efe8, roughness: 0.7 }), posts.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    posts.forEach(([x, y, z, a], i) => { q.setFromAxisAngle(V3(0, 1, 0), a); m4.compose(V3(x, y, z), q, V3(1, 1, 1)); pm.setMatrixAt(i, m4); });
    pm.castShadow = true; pm.receiveShadow = true; deco.add(pm);
    const railMat = new THREE.MeshStandardMaterial({ color: 0xf1efe8, roughness: 0.7 });
    for (const pts of railPts) {
      const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), pts.length * 2, 0.035, 5, true), railMat);
      rail.castShadow = true; deco.add(rail);
    }
  }

  // ---------- 路灯 ----------
  const lamps = [];
  {
    const poleParts = [];
    poleParts.push(new THREE.CylinderGeometry(0.06, 0.09, 4.4, 10).translate(0, 2.2, 0));
    poleParts.push(new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10).translate(0, 0.15, 0));
    const arm = new THREE.CatmullRomCurve3([V3(0, 4.3, 0), V3(0, 4.7, 0), V3(-0.4, 4.9, 0), V3(-1.1, 4.8, 0)]);
    poleParts.push(new THREE.TubeGeometry(arm, 16, 0.045, 6, false));
    poleParts.push(new THREE.ConeGeometry(0.28, 0.25, 12, 1, true).translate(-1.15, 4.72, 0));
    const poleGeo = mergeGeometries(poleParts.map((g) => { const n = g.index ? g.toNonIndexed() : g; return n; }));
    const bulbGeo = new THREE.SphereGeometry(0.14, 12, 8).translate(-1.15, 4.6, 0);
    const spacing = 30;
    const count = Math.floor(road.L / spacing);
    const poleMesh = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x2f4a4c, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }), count);
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffd08a, emissiveIntensity: 0 });
    const bulbMesh = new THREE.InstancedMesh(bulbGeo, bulbMat, count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      road.sample(i * spacing + 7, o);
      const p = V3(o.x + o.rx * (HALF_W + 0.8), o.y - 0.05, o.z + o.rz * (HALF_W + 0.8));
      // 让灯臂伸向路中央：局部 -X 指向 -right
      q.setFromAxisAngle(V3(0, 1, 0), Math.atan2(-o.rz, o.rx));
      m4.compose(p, q, V3(1, 1, 1));
      poleMesh.setMatrixAt(i, m4); bulbMesh.setMatrixAt(i, m4);
      const bulb = V3(-1.15, 4.5, 0).applyQuaternion(q).add(p);
      lamps.push(bulb);
    }
    poleMesh.castShadow = true;
    deco.add(poleMesh, bulbMesh);
    lamps.bulbMat = bulbMat;
  }
  const lampLights = Array.from({ length: 4 }, () => { const l = new THREE.PointLight(0xffc98a, 0, 22, 1.6); scene.add(l); return l; });

  // ---------- 棕榈树、灌木、岩石 ----------
  const place = (count, test, tries = 6000) => {
    const out = [];
    for (let i = 0; i < tries && out.length < count; i++) {
      const x = rr(-250, 250), z = rr(-250, 250);
      const h = terr.heightAt(x, z);
      const n = road.nearest(x, z);
      if (test(x, z, h, n)) out.push([x, h, z]);
    }
    return out;
  };
  const palm = palmGeometry();
  const leafMat = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 });
  const swayUniform = { value: 0 };
  leafMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = swayUniform;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float ph = 0.0;
      #ifdef USE_INSTANCING
        ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
      #endif
      float w = uv.y * uv.y;
      transformed.y += sin(uTime * 1.6 + ph + position.x) * 0.18 * w;
      transformed.x += sin(uTime * 1.1 + ph * 1.3) * 0.12 * w;`);
  };
  const palms = [
    ...place(46, (x, z, h, n) => n.outside && n.d > HALF_W + 7 && h > 0.9 && h < 3.2),
    ...place(40, (x, z, h, n) => !n.outside && n.d > HALF_W + 5 && h < 16),
  ];
  {
    const tm = new THREE.InstancedMesh(palm.trunkGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), palms.length);
    const lm = new THREE.InstancedMesh(palm.leafGeo, leafMat, palms.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    palms.forEach(([x, y, z], i) => {
      q.setFromAxisAngle(V3(0, 1, 0), rand() * TAU);
      const s = rr(0.75, 1.25);
      m4.compose(V3(x, y, z), q, V3(s, s * rr(0.9, 1.2), s));
      tm.setMatrixAt(i, m4); lm.setMatrixAt(i, m4);
    });
    tm.castShadow = lm.castShadow = true; tm.receiveShadow = lm.receiveShadow = true;
    deco.add(tm, lm);
  }
  {
    const bush = new THREE.IcosahedronGeometry(1, 2);
    const p = bush.attributes.position;
    for (let i = 0; i < p.count; i++) { const v = V3(p.getX(i), p.getY(i), p.getZ(i)); v.multiplyScalar(1 + 0.18 * noise2(v.x * 2 + 5, v.z * 2 + v.y)); p.setXYZ(i, v.x, v.y * 0.75, v.z); }
    bush.computeVertexNormals();
    const spots = place(260, (x, z, h, n) => !n.outside && n.d > HALF_W + 2.5 && h > 1);
    const bm = new THREE.InstancedMesh(bush, new THREE.MeshStandardMaterial({ roughness: 0.9 }), spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    spots.forEach(([x, y, z], i) => {
      const s = rr(0.5, 1.5);
      q.setFromAxisAngle(V3(0, 1, 0), rand() * TAU);
      m4.compose(V3(x, y + s * 0.3, z), q, V3(s, s, s)); bm.setMatrixAt(i, m4);
      c.setHSL(rr(0.22, 0.3), rr(0.35, 0.55), rr(0.25, 0.38)); bm.setColorAt(i, c);
    });
    bm.castShadow = true; bm.receiveShadow = true; deco.add(bm);
    // 花丛点缀
    const fl = place(120, (x, z, h, n) => !n.outside && n.d > HALF_W + 2 && n.d < 30 && h > 1);
    const fm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 0), new THREE.MeshStandardMaterial({ roughness: 0.6 }), fl.length);
    const pal = ['#f2b33d', '#f07b8a', '#f4f1ea', '#b98ce0'];
    fl.forEach(([x, y, z], i) => { m4.compose(V3(x, y + 0.15, z), q, V3(1, 1, 1)); fm.setMatrixAt(i, m4); fm.setColorAt(i, c.set(pal[i % 4])); });
    deco.add(fm);
  }
  {
    const rock = new THREE.DodecahedronGeometry(1, 1);
    const p = rock.attributes.position;
    for (let i = 0; i < p.count; i++) { const v = V3(p.getX(i), p.getY(i), p.getZ(i)); v.multiplyScalar(1 + 0.25 * noise2(v.x * 1.7 + 9, v.z * 1.7 - v.y * 2)); p.setXYZ(i, v.x, v.y * 0.7, v.z); }
    rock.computeVertexNormals();
    const spots = [
      ...place(110, (x, z, h, n) => n.outside && h > -1.2 && h < 0.8),
      ...place(60, (x, z, h) => Math.hypot(x - terr.LH.x, z - terr.LH.z) < 26 && Math.hypot(x - terr.LH.x, z - terr.LH.z) > 5 && h > -2),
    ];
    const rm = new THREE.InstancedMesh(rock, new THREE.MeshStandardMaterial({ color: 0x8a867d, roughness: 0.95, flatShading: true }), spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    spots.forEach(([x, y, z], i) => {
      const s = rr(0.4, 1.8);
      q.setFromEuler(new THREE.Euler(rand(), rand() * TAU, rand()));
      m4.compose(V3(x, y, z), q, V3(s, s * rr(0.6, 1), s)); rm.setMatrixAt(i, m4);
      rm.setColorAt(i, c.setHSL(0.1, 0.05, rr(0.42, 0.6)));
    });
    rm.castShadow = true; rm.receiveShadow = true; deco.add(rm);
  }

  // ---------- 小屋 ----------
  const windowMats = [];
  {
    const walls = ['#f4f1ea', '#bfe0dc', '#f6d6a8', '#f2c4c0', '#cfd8f0', '#e6efd8'];
    const spots = [];
    for (const f of [0.05, 0.14, 0.27, 0.44, 0.61, 0.72, 0.9]) {
      road.sample(f * road.L, o);
      const d = HALF_W + 9 + (spots.length % 3) * 2;
      const x = o.x + o.rx * d, z = o.z + o.rz * d;
      spots.push([x, terr.heightAt(x, z), z, Math.atan2(-o.rx, -o.rz)]);
    }
    spots.forEach(([x, y, z, a], i) => {
      const g = new THREE.Group();
      const { map, emissive } = houseTexture(walls[i % walls.length]);
      const wm = new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: 0xffc070, emissiveIntensity: 0, roughness: 0.85 });
      windowMats.push(wm);
      const body = new THREE.Mesh(new THREE.BoxGeometry(4, 2.8, 3.4), wm); body.position.y = 1.4; g.add(body);
      const roofShape = new THREE.Shape(); roofShape.moveTo(-2.3, 0); roofShape.lineTo(0, 1.6); roofShape.lineTo(2.3, 0); roofShape.lineTo(-2.3, 0);
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 3.8, bevelEnabled: false }), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xb5553e : 0x3f6f8a, roughness: 0.7 }));
      roof.position.set(0, 2.8, -1.9); g.add(roof);
      const chim = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, 0.4), new THREE.MeshStandardMaterial({ color: 0xe8e2d6 })); chim.position.set(1.1, 3.7, 0.6); g.add(chim);
      g.position.set(x, y - 0.2, z); g.rotation.y = a;
      g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      deco.add(g);
    });
  }

  // ---------- 灯塔 ----------
  const lighthouse = new THREE.Group();
  const beams = new THREE.Group();
  let lhLight;
  {
    const LH = terr.LH;
    const baseY = terr.heightAt(LH.x, LH.z) - 0.5;
    lighthouse.position.set(LH.x, baseY, LH.z);
    const prof = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12; prof.push(new THREE.Vector2(lerp(2.0, 1.25, t), t * 13)); }
    const tower = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), new THREE.MeshStandardMaterial({ map: lighthouseTexture(), roughness: 0.7 }));
    lighthouse.add(tower);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3, 1.2, 24), new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.9 })); base.position.y = 0.4; lighthouse.add(base);
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.7, 0.3, 32), new THREE.MeshStandardMaterial({ color: 0x2b3033, roughness: 0.6, metalness: 0.5 })); gallery.position.y = 13.1; lighthouse.add(gallery);
    const rail = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.04, 6, 40), gallery.material); rail.rotation.x = Math.PI / 2; rail.position.y = 13.9; lighthouse.add(rail);
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.6, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd36b, emissiveIntensity: 0.2, transparent: true, opacity: 0.85, roughness: 0.1 }));
    lantern.position.y = 14.1; lighthouse.add(lantern);
    lighthouse.userData.lantern = lantern;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.15, 24, 12, 0, TAU, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8433a, roughness: 0.5 })); dome.position.y = 14.9; lighthouse.add(dome);
    const vane = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.9, 8), gallery.material); vane.position.y = 16.4; lighthouse.add(vane);
    lighthouse.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    // 光束
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform float uOpacity; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float along = pow(1.0 - vUv.y, 1.6); float edge = pow(abs(dot(vN, vV)), 1.5); gl_FragColor = vec4(vec3(1.0,0.93,0.72) * along * edge * uOpacity, 1.0); }`,
    });
    const beamGeo = new THREE.CylinderGeometry(9, 0.5, 110, 32, 1, true).translate(0, 55, 0).rotateZ(-Math.PI / 2);
    for (const r of [0, Math.PI]) { const b = new THREE.Mesh(beamGeo, beamMat); b.rotation.y = r; beams.add(b); }
    beams.position.y = 14.1; beams.rotation.z = -0.04;
    lighthouse.add(beams);
    beams.userData.mat = beamMat;
    lhLight = new THREE.PointLight(0xffd88a, 0, 40, 1.5); lhLight.position.y = 14.1; lighthouse.add(lhLight);
    scene.add(lighthouse);
  }

  // ---------- 码头 + 桩上的鹈鹕 ----------
  const perched = [];
  {
    const dir = V3(Math.cos(PIER_ANGLE), 0, Math.sin(PIER_ANGLE));
    const side = V3(-dir.z, 0, dir.x);
    let start = roadR(PIER_ANGLE) + HALF_W + 4;
    for (let r = start; r < start + 40; r += 0.5) { if (terr.heightAt(dir.x * r, dir.z * r) < 1.9) { start = r; break; } }
    const len = 58, deckY = 1.95;
    const pier = new THREE.Group();
    const plankTex = canvasTex(128, 512, (c, w, h) => {
      c.fillStyle = '#a07a52'; c.fillRect(0, 0, w, h);
      const r = mulberry32(5);
      for (let y = 0; y < h; y += 16) { c.fillStyle = `hsl(28, ${30 + r() * 15}%, ${38 + r() * 12}%)`; c.fillRect(0, y, w, 14); c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, y + 14, w, 2); }
    }, { repeat: [1, 6] });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.18, len), new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.85 }));
    deck.position.set(0, deckY, len / 2); pier.add(deck);
    const pileGeo = new THREE.CylinderGeometry(0.16, 0.18, 1, 10);
    const pileMat = new THREE.MeshStandardMaterial({ color: 0x5e4630, roughness: 0.9 });
    const piles = [];
    for (let zz = 2; zz <= len; zz += 4) for (const s of [-1.3, 1.3]) {
      const tall = (zz % 12 === 10) && s > 0 ? 1 : 0;
      piles.push([s, zz, tall]);
    }
    const pm = new THREE.InstancedMesh(pileGeo, pileMat, piles.length);
    const m4 = new THREE.Matrix4();
    const q0 = new THREE.Quaternion();
    const pierQ = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), dir);
    const pierPos = dir.clone().multiplyScalar(start);
    piles.forEach(([s, zz, tall], i) => {
      const wp = V3(s, 0, zz).applyQuaternion(pierQ).add(pierPos);
      const bottom = Math.min(terr.heightAt(wp.x, wp.z), -0.5) - 0.5;
      const top = deckY + (tall ? 1.3 : 0.5);
      m4.compose(V3(s, (bottom + top) / 2, zz), q0, V3(1, top - bottom, 1));
      pm.setMatrixAt(i, m4);
      if (tall) perched.push(V3(s, top, zz));
    });
    pier.add(pm);
    // 码头尽头的小灯
    const endLamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0xffc060, emissiveIntensity: 0 }));
    endLamp.position.set(0, deckY + 1.6, len - 0.5); pier.add(endLamp);
    const endPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 8), new THREE.MeshStandardMaterial({ color: 0x2f4a4c, metalness: 0.5, roughness: 0.5 }));
    endPost.position.set(0, deckY + 0.8, len - 0.5); pier.add(endPost);
    lamps.pierLamp = endLamp;
    pier.position.copy(pierPos); pier.quaternion.copy(pierQ);
    pier.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    scene.add(pier);
    const PM = makePelicanMaterials();
    const pel = [];
    for (const p of perched) {
      const b = createPerchedPelican(PM);
      b.position.copy(p); b.rotation.y = rr(-1, 1);
      pier.add(b); pel.push(b);
    }
    perched.length = 0; perched.push(...pel);
    // 沙滩伞
    const cols = [['#f2b33d', '#f4f1ea'], ['#1f2f5a', '#f4f1ea'], ['#e0503a', '#f4f1ea'], ['#5fb8a6', '#f4f1ea']];
    for (let k = 0; k < 7; k++) {
      const off = rr(-26, 26), out = rr(10, 20);
      const wp = pierPos.clone().addScaledVector(side, off + Math.sign(off) * 4).addScaledVector(dir, out - 14);
      const hh = terr.heightAt(wp.x, wp.z);
      if (hh < 0.3 || hh > 2.2) continue;
      const u = new THREE.Group();
      const [a, b] = cols[k % 4];
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.5, 16, 1, true), new THREE.MeshStandardMaterial({ map: umbrellaTexture(a, b), side: THREE.DoubleSide, roughness: 0.8 }));
      canopy.position.y = 2.1; u.add(canopy);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0xeeeeee })); pole.position.y = 1.1; u.add(pole);
      const towel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.7).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: b === '#f4f1ea' ? a : b, roughness: 0.9 }));
      towel.position.set(0.9, 0.03, 0.4); towel.rotation.y = rr(-0.5, 0.5); u.add(towel);
      u.position.set(wp.x, hh, wp.z); u.rotation.z = rr(-0.12, 0.12);
      u.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      scene.add(u);
    }
  }

  // ---------- 昼夜配色 ----------
  const KEYS = [
    // 太阳高度, 雾, 半球天, 半球地, 半球强度, 太阳色, 太阳强度, 天顶反射, 地平线反射, 深水, 浅水
    [-18, '#0b1426', '#1d2c50', '#07090f', 0.45, '#9fb4ff', 0.0, '#060d1f', '#122041', '#04121c', '#0b3a44'],
    [-6, '#2c3858', '#4a5f9a', '#1a1e2a', 0.85, '#9ab0ff', 0.0, '#18264f', '#3b4671', '#08263a', '#1b5b66'],
    [0, '#d79374', '#8494c8', '#4a3a3a', 0.9, '#ff7a3d', 1.4, '#4b67a8', '#f2a877', '#0d3a55', '#2f8f98'],
    [6, '#e6b995', '#9fb4dd', '#6b5a48', 0.75, '#ffb070', 2.8, '#5b85c6', '#f4cfa6', '#0c4562', '#34aeb0'],
    [20, '#c6dbea', '#b8d4f2', '#857a60', 0.9, '#fff0d8', 3.6, '#4f88d0', '#cfe2f0', '#0b4a66', '#37c3c0'],
    [70, '#bcd6ea', '#c2dcf8', '#8a7d62', 1.0, '#fffaf0', 4.0, '#3f7fd0', '#c4dcef', '#0b4a66', '#3cc8c4'],
  ];
  const keyCols = KEYS.map((k) => k.map((v) => (typeof v === 'string' ? new THREE.Color(v) : v)));
  function palette(el) {
    let i = 0; while (i < keyCols.length - 2 && el > keyCols[i + 1][0]) i++;
    const a = keyCols[i], b = keyCols[i + 1];
    const t = clamp((el - a[0]) / (b[0] - a[0]), 0, 1);
    return a.map((v, k) => (k === 0 ? el : typeof v === 'number' ? lerp(v, b[k], t) : v.clone().lerp(b[k], t)));
  }

  const state = { hour: 17.5, sunDir: V3(), moonDir: V3(), night: 0, elev: 0, lampsOn: 0 };
  scene.fog = new THREE.FogExp2(0xc6dbea, 0.0021);

  function setTime(hour) {
    state.hour = ((hour % 24) + 24) % 24;
    const dayT = (state.hour - 6) / 12; // 0 日出 1 日落
    const elev = Math.sin(dayT * Math.PI) * 62; // 度
    const az = THREE.MathUtils.degToRad(100 - dayT * 200);
    const e = THREE.MathUtils.degToRad(elev);
    state.elev = elev;
    state.sunDir.set(Math.cos(e) * Math.sin(az), Math.sin(e), Math.cos(e) * Math.cos(az)).normalize();
    // 月亮在太阳对面稍偏
    const me = THREE.MathUtils.degToRad(Math.max(-elev * 0.7, -10) + 8);
    state.moonDir.set(-Math.cos(me) * Math.sin(az + 0.6), Math.sin(me), -Math.cos(me) * Math.cos(az + 0.6)).normalize();
    su.sunPosition.value.copy(state.sunDir);
    const p = palette(elev);
    scene.fog.color.copy(p[1]);
    hemi.color.copy(p[2]); hemi.groundColor.copy(p[3]); hemi.intensity = p[4];
    const night = smooth(-2, -10, elev);
    state.night = night;
    if (elev > -3) { sun.color.copy(p[5]); sun.intensity = p[6] * smooth(-3, 2, elev); }
    else { sun.color.set(0x9fb4ff); sun.intensity = 0.55 * night; }
    state.lightDir = elev > -3 ? state.sunDir : state.moonDir;
    water.uniforms.uSunDir.value.copy(state.sunDir);
    water.uniforms.uSunColor.value.copy(p[5]).multiplyScalar(smooth(-2, 4, elev));
    water.uniforms.uZenith.value.copy(p[7]); water.uniforms.uHorizon.value.copy(p[8]);
    water.uniforms.uDeep.value.copy(p[9]); water.uniforms.uShallow.value.copy(p[10]);
    water.uniforms.uLight.value = lerp(0.25, 1, smooth(-10, 10, elev));
    water.uniforms.uMoonDir.value.copy(state.moonDir); water.uniforms.uNight.value = night;
    su.rayleigh.value = lerp(2.6, 1.4, smooth(0, 25, elev));
    su.turbidity.value = lerp(6, 3.2, smooth(0, 25, elev));
    stars.material.uniforms.uOpacity.value = smooth(-4, -14, elev);
    twilight.material.uniforms.uSunDir.value.copy(state.sunDir);
    twilight.material.uniforms.uTwilight.value = smooth(3, -2, elev) * smooth(-17, -7, elev);
    twilight.material.uniforms.uNight.value = smooth(-5, -14, elev);
    moon.material.opacity = smooth(-1, -8, elev);
    state.lampsOn = smooth(3, -3, elev);
    lamps.bulbMat.emissiveIntensity = state.lampsOn * 6;
    lamps.pierLamp.material.emissiveIntensity = state.lampsOn * 6;
    for (const wm of windowMats) wm.emissiveIntensity = state.lampsOn * 2.2;
    beams.userData.mat.uniforms.uOpacity.value = smooth(2, -6, elev) * 0.55;
    lighthouse.userData.lantern.material.emissiveIntensity = 0.3 + state.lampsOn * 5;
    lhLight.intensity = state.lampsOn * 60;
    return state;
  }

  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const lampOrder = lamps.map((p, i) => [0, i]);
  function update(dt, t, bikePos, camera) {
    water.uniforms.uTime.value = t;
    su.time.value = t;
    stars.material.uniforms.uTime.value = t;
    swayUniform.value = t;
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    twilight.position.copy(camera.position);
    moon.position.copy(camera.position).addScaledVector(state.moonDir, 1500);
    beams.rotation.y = t * 0.9;
    // 阳光/月光阴影跟随自行车
    sun.target.position.copy(bikePos);
    sun.position.copy(bikePos).addScaledVector(state.lightDir || state.sunDir, 60);
    // 最近的路灯点亮真实光源
    if (state.lampsOn > 0.01) {
      for (const e of lampOrder) e[0] = lamps[e[1]].distanceToSquared(bikePos);
      lampOrder.sort((a, b) => a[0] - b[0]);
      lampLights.forEach((l, k) => { l.position.copy(lamps[lampOrder[k][1]]); l.intensity = state.lampsOn * 30; });
    } else lampLights.forEach((l) => (l.intensity = 0));
    // 桩上的鹈鹕转头看你
    for (const b of perched) {
      b.getWorldPosition(_v);
      const dx = bikePos.x - _v.x, dz = bikePos.z - _v.z;
      const d = Math.hypot(dx, dz);
      const head = b.userData.head;
      const want = Math.atan2(-dz, dx);
      // 头部相对身体朝向偏转
      const bodyYaw = _e.setFromQuaternion(b.getWorldQuaternion(_q), 'YXZ').y;
      let rel = d < 45 ? want - bodyYaw : Math.sin(t * 0.4 + _v.x) * 0.4;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      head.rotation.y = lerp(head.rotation.y, clamp(rel, -1.3, 1.3), 1 - Math.exp(-3 * dt));
    }
  }

  return { road, terr, heightAt: terr.heightAt, sky, sun, hemi, water, setTime, update, state, lighthouse, lamps, setPR(pr) { stars.material.uniforms.uPR.value = pr; } };
}
