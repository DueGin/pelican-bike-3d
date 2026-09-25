import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createWorld, LANE } from './world.js';
import { createBicycle, BIKE } from './bicycle.js';
import { createPelican } from './pelican.js';
import { createLife } from './life.js';
import { AudioEngine } from './audio.js';
import { CameraRig, CAM_MODES, fitFov } from './camera.js';
import { V3, clamp, damp, lerp, smooth, TAU } from './util.js';

const params = new URLSearchParams(location.search);
const TEST = params.has('still');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s) => document.querySelector(s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ================= 渲染器与后期 =================
const canvas = $('#scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  $('#loader-text').textContent = '这台设备的浏览器没有开启 WebGL，换用最新版 Chrome、Edge 或 Safari 再打开即可。';
  throw e;
}
const Q = { pr: Math.min(devicePixelRatio, 2), bloom: true, shadow: 2048, level: 'high' };
renderer.setPixelRatio(Q.pr);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 4000);

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVig: { value: 0.32 }, uGrain: { value: 0.028 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uVig; uniform float uGrain; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = smoothstep(0.9, 0.25, length(d * vec2(1.15, 1.0)));
      c.rgb *= mix(1.0, v, uVig);
      float n = fract(sin(dot(vUv * vec2(1234.5, 987.6) + fract(uTime) * 17.0, vec2(12.9898, 78.233))) * 43758.5453);
      c.rgb += (n - 0.5) * uGrain; gl_FragColor = c; }`,
};
let composer, bloom, grade, renderTarget;
function buildComposer() {
  if (composer) { composer.passes.forEach((p) => p.dispose?.()); composer.dispose(); }
  // 高 DPR 屏幕本身就够细腻，不再叠加 MSAA，省下大量显存
  const samples = Q.level === 'high' && Q.pr < 1.5 ? 4 : 0;
  renderTarget = new THREE.WebGLRenderTarget(innerWidth * Q.pr, innerHeight * Q.pr, { type: THREE.HalfFloatType, samples });
  composer = new EffectComposer(renderer, renderTarget);
  composer.renderTarget1.samples = 0; // 场景画在 renderTarget2 上，只有它需要 MSAA
  composer.setPixelRatio(Q.pr);
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.55, 0.9);
  bloom.enabled = Q.bloom;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
}

// ================= 状态 =================
const S = {
  s: 40, v: 0, cruise: 18 / 3.6, crank: 0.9, wheel: 0, lean: 0, steer: 0, stopped: 1, pedaling: false,
  boost: false, brake: false, dist: 0, started: false, hour: 17.4, autoTime: false, t: 0, loadT: 0,
  lookCamT: 6, camLookUntil: 0, gullT: 8,
};
const audio = new AudioEngine();
let world, bike, pel, life, camRig, rig, pmrem, envScene, envRT, lastEnvHour = -99;

async function init() {
  try { await build(); } catch (e) {
    console.error(e);
    setLoader('场景没能加载出来：' + (e && e.message ? e.message : e) + '。刷新页面再试一次，或换用最新版 Chrome、Edge、Safari。');
    const w = document.querySelector('#loader .wheel'); if (w) w.style.animation = 'none';
  }
}
async function build() {
  await nextFrame(); await nextFrame();
  setLoader('正在堆沙滩、种棕榈树…');
  await nextFrame();
  world = createWorld(scene);
  setLoader('鹈鹕正在系围巾…');
  await nextFrame();
  rig = new THREE.Group(); rig.rotation.order = 'YZX'; scene.add(rig);
  bike = createBicycle(); rig.add(bike.root);
  pel = createPelican(); rig.add(pel.root);
  pel.tails.forEach((t) => scene.add(t.mesh));
  life = createLife(scene, world, { onSplash: (p, v) => { const d = p.distanceTo(rig.position); if (d < 60) audio.splash(v * clamp(1 - d / 60, 0.1, 1)); } });
  camRig = new CameraRig(camera, renderer.domElement, reduceMotion);
  pmrem = new THREE.PMREMGenerator(renderer);
  envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(world.sky.geometry, world.sky.material); envSky.scale.setScalar(10); envScene.add(envSky);
  if (params.has('nobloom')) Q.bloom = false;
  buildComposer();
  world.setPR(Q.pr); life.setPR(Q.pr);
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => applyTime(S.hour, true));

  // 测试/分享参数
  if (params.has('t')) S.hour = parseFloat(params.get('t'));
  if (params.has('s')) S.s = parseFloat(params.get('s'));
  applyTime(S.hour, true);
  buildMinimap();
  bindUI();
  if (TEST) {
    S.started = true; S.v = parseFloat(params.get('v') ?? 5); S.stopped = S.v > 0.3 ? 0 : 1;
    const cam = params.get('cam') || 'chase';
    setCamMode(cam);
    camRig.snap = true;
    if (params.has('shot')) { camRig.shotIdx = parseInt(params.get('shot')) - 1; camRig.shotT = 1e9; }
    document.body.classList.add('started');
    $('#intro').hidden = true;
  }
  $('#loader').classList.add('done');
  setTimeout(() => ($('#loader').hidden = true), 900);
  document.body.classList.add('ready');
  renderer.setAnimationLoop(loop);
}
function setLoader(t) { const el = $('#loader-text'); if (el) el.textContent = t; }

// ================= 时间 =================
function applyTime(h, forceEnv = false) {
  S.hour = ((h % 24) + 24) % 24;
  const st = world.setTime(S.hour);
  const dayness = smooth(-6, 8, st.elev);
  // 简易“自动曝光”：正午阳光直射时收一点，夜里放开
  renderer.toneMappingExposure = lerp(0.95, lerp(0.62, 0.4, smooth(10, 55, st.elev)), dayness);
  scene.environmentIntensity = lerp(0.3, 0.55, dayness);
  // 泛光只在黄昏和夜里出场（白天的天空太亮，会把整幅画面蒙上一层雾）
  if (bloom) { bloom.strength = lerp(0.9, 0.0, dayness); bloom.threshold = lerp(0.85, 3, dayness); bloom.radius = 0.55; bloom.enabled = Q.bloom && dayness < 0.97; }
  bike && (bike.lensMat.emissiveIntensity = st.lampsOn * 8, bike.tailMat.emissiveIntensity = st.lampsOn * 4, bike.headlight.intensity = st.lampsOn * 45);
  life && life.setLight(lerp(0.35, 1, dayness));
  document.body.classList.toggle('night', st.lampsOn > 0.5);
  if (forceEnv) refreshEnv();
  else if (Math.abs(S.hour - lastEnvHour) > 0.15) envDirty = true;
  const slider = $('#time');
  if (slider && !sliderDragging) slider.value = S.hour;
  $('#time-out') && ($('#time-out').textContent = fmtHour(S.hour));
}
let envDirty = false, envCooldown = 0, sliderDragging = false;
function refreshEnv() {
  lastEnvHour = S.hour; envDirty = false; envCooldown = 0.3;
  const rt = pmrem.fromScene(envScene, 0, 0.1, 100, { size: 128 });
  envRT?.dispose(); envRT = rt; scene.environment = rt.texture;
}
const fmtHour = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };

// ================= 物理 =================
const road = {};
function stepBike(dt) {
  const o = world.road.sample(S.s, road);
  const target = S.started ? (S.brake ? 0 : S.cruise + (S.boost ? 3.8 : 0)) : 0;
  const g = 9.8;
  let a = -g * o.slope * 0.55 - 0.004 * S.v * S.v;
  S.pedaling = false;
  if (S.brake) a = -5.5;
  else if (S.v < target - 0.25) { a += 1.6 + (S.boost ? 1.4 : 0); S.pedaling = true; }
  else if (S.v < target + 0.35 && target > 0.2) { a = (target - S.v) * 1.6; S.pedaling = true; }
  if (target < 0.2 && !S.brake) a = Math.min(a, -0.9); // 巡航设为 0：慢慢滑停
  S.v = Math.max(0, S.v + a * dt);
  if (target === 0 && S.v < 0.15) S.v = Math.max(0, S.v - dt);
  S.s += S.v * dt; S.dist += S.v * dt;
  const w = S.v / BIKE.R;
  S.wheel += w * dt;
  if (S.pedaling) S.crank += (w / BIKE.ratio) * dt;
  S.omega = w;
  S.stopped = damp(S.stopped, S.v < 0.35 && target < 0.1 ? 1 : 0, 3.5, dt);
  const leanPhys = Math.atan((S.v * S.v * o.kappa) / g);
  S.lean = damp(S.lean, clamp(leanPhys * 1.2, -0.45, 0.45) + S.stopped * 0.13, 3, dt);
  S.steer = damp(S.steer, -Math.atan(1.09 * o.kappa) * 1.8 + (S.v < 2.2 && S.v > 0.3 ? Math.sin(S.t * 2.3) * 0.06 : 0) - S.stopped * 0.12, 4, dt);
  rig.position.set(o.x + o.rx * LANE, o.y + 0.04, o.z + o.rz * LANE);
  rig.rotation.set(S.lean, Math.atan2(-o.tz, o.tx), Math.atan(o.slope), 'YZX');
  return o;
}

// ================= 主循环 =================
const timer = new THREE.Timer();
timer.connect(document);
const tmp = { fwd: V3(), right: V3(), head: V3(), bb: V3(), look: V3(), q: new THREE.Quaternion(), camFrom: V3() };
let fpsAcc = 0, fpsN = 0, fpsChecked = false, hudT = 0;

function loop(ts) {
  timer.update(ts);
  let dt = clamp(timer.getDelta(), 0, 1 / 20);
  if (TEST) dt = 1 / 60;
  if (!(dt > 0)) { composer.render(); return; }
  S.t += dt; S.loadT += dt;
  envCooldown -= dt;
  if (envDirty && envCooldown <= 0) refreshEnv();
  if (S.autoTime) applyTime(S.hour + dt * 0.1);

  const o = stepBike(dt);
  tmp.fwd.set(o.tx, 0, o.tz); tmp.right.set(o.rx, 0, o.rz);
  bike.state.crank = S.crank; bike.state.wheel = S.wheel; bike.state.steer = S.steer;
  bike.update(dt, S.t);
  rig.updateMatrixWorld(true);

  // 鹈鹕看向哪里：跳鱼 > 镜头（偶尔） > 前方
  let look = null;
  if (life.state.lookFish) look = rig.worldToLocal(tmp.look.copy(life.state.lookFish.p));
  else if (S.t < S.camLookUntil && camRig.mode !== 'pov') look = rig.worldToLocal(tmp.look.copy(camera.position));
  else look = tmp.look.set(6, 1.4, 0);
  S.lookCamT -= dt;
  if (S.lookCamT < 0) { S.lookCamT = 7 + Math.random() * 8; if (camera.position.distanceTo(rig.position) < 9) S.camLookUntil = S.t + 1.8; }

  const grips = bike.grips.map((m) => rig.worldToLocal(m.getWorldPosition(V3())));
  const pedals = [bike.pedalPos(0), bike.pedalPos(1)];
  pel.update({ dt, t: S.t, crank: S.crank, speed: S.v, lean: S.lean, grips, pedals, look, stopped: S.stopped });
  const wind = tmp.fwd.clone().multiplyScalar(-S.v).add(V3(Math.sin(S.t * 0.3) * 1.2 + Math.sin(S.t * 2.1) * 0.4, 0.3, Math.cos(S.t * 0.23) * 1.2));
  pel.updateScarf(dt, wind, rig);

  // 偶尔掉一根羽毛
  if (S.v > 6 && Math.random() < dt * 0.12) life.dropFeather(pel.head.getWorldPosition(V3()).add(V3(0, -0.4, 0)), tmp.fwd.clone().multiplyScalar(S.v));
  life.update(dt, S.t, { pos: rig.position, fwd: tmp.fwd, right: tmp.right });
  world.update(dt, S.t, rig.position, camera);
  // 海鸥叫
  S.gullT -= dt;
  if (S.gullT < 0) { S.gullT = 7 + Math.random() * 12; if (rig.position.distanceTo(world.lighthouse.position) < 90 || Math.random() < 0.3) audio.gull(); }

  // 镜头
  pel.head.getWorldPosition(tmp.head);
  pel.head.getWorldQuaternion(tmp.q);
  tmp.bb.copy(BIKE.bb).applyMatrix4(rig.matrixWorld);
  if (!S.started) idleCamera(dt);
  else camRig.update(dt, {
    bikePos: rig.position, fwd: tmp.fwd, right: tmp.right, head: tmp.head, headQuat: tmp.q, bb: tmp.bb, speed: S.v, t: S.t, lean: S.lean,
    heightAt: world.heightAt, road: world.road, s: S.s, pov: pel.povAnchor, onShot: showShot,
  });

  audio.update(dt, { speed: S.v, pedaling: S.pedaling, wheelOmega: S.omega, night: world.state.night });
  grade.uniforms.uTime.value = S.t;
  composer.render();

  // HUD 10Hz
  hudT -= dt;
  if (hudT < 0) { hudT = 0.1; updateHUD(); }
  // 自动画质
  if (!fpsChecked && S.loadT > 3 && !TEST) {
    fpsAcc += timer.getDelta(); fpsN++;
    if (fpsN > 150) { fpsChecked = true; if (fpsAcc / fpsN > 1 / 28) setQuality('low', true); }
  }
  window.__frames = (window.__frames || 0) + 1;
}

function idleCamera(dt) {
  // 页面刚打开：从海上高处缓缓落到路边的鹈鹕身旁
  const k = reduceMotion ? 1 : ease(clamp(S.loadT / 6.5, 0, 1));
  const P = rig.position;
  const a = 0.25 + S.loadT * 0.045;
  const orbit = P.clone().addScaledVector(tmp.fwd, Math.cos(a) * 3.6).addScaledVector(tmp.right, Math.sin(a) * 3.6).add(V3(0, 1.75, 0));
  const high = P.clone().addScaledVector(tmp.fwd, 55).addScaledVector(tmp.right, -70).add(V3(0, 32, 0));
  const pos = high.lerp(orbit, k);
  const gy = world.heightAt(pos.x, pos.z) + 0.5; if (pos.y < gy) pos.y = gy;
  camera.position.copy(pos);
  camera.lookAt(P.x, P.y + 1.2 - (1 - k) * 0.6, P.z);
  camera.userData.baseFov = lerp(38, 42, k);
  camera.fov = fitFov(camera.userData.baseFov, camera.aspect); camera.updateProjectionMatrix();
}

// ================= 交互 =================
function start() {
  if (S.started) return;
  audio.init();
  S.started = true;
  document.body.classList.add('started');
  $('#intro').classList.add('leaving');
  setTimeout(() => ($('#intro').hidden = true), 700);
  pel.squawk(); audio.squawk();
  setTimeout(() => { bike.ringBell(); audio.bell(); }, 500);
  camRig.startIntro(camera.position, rig.position.clone().add(V3(0, 1.2, 0)), 2.6);
  setCamMode('chase', true);
  setTimeout(() => toast(document.body.classList.contains('touch') ? '按住右下角的「蹬」加速，点「铃」按车铃' : '按住 W 或 ↑ 用力蹬，空格按车铃'), 3200);
}

function setCamMode(m, keepIntro = false) {
  if (!CAM_MODES.includes(m)) m = 'chase';
  camRig.setMode(m, { bikePos: rig.position });
  if (m === 'orbit') { camera.position.copy(rig.position).addScaledVector(tmp.fwd, -4).addScaledVector(tmp.right, 3).add(V3(0, 2.2, 0)); camRig.lastBike = rig.position.clone(); }
  document.querySelectorAll('[data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === m)));
  $('#shot').textContent = '';
  if (m === 'orbit') toast('拖动旋转，滚轮缩放');
  if (m === 'pov') toast('鹈鹕视角：注意别被自己的嘴挡住路');
}
function showShot(name) { const el = $('#shot'); el.textContent = name; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function ring() { audio.init(); bike.ringBell(); audio.bell(); const b = $('#btn-bell'); b.classList.remove('rang'); void b.offsetWidth; b.classList.add('rang'); }
function greet() {
  audio.init();
  if (pel.isBusy()) return;
  pel.squawk(); pel.wave(); audio.squawk();
  S.camLookUntil = S.t + 2.5;
  for (let i = 0; i < 3; i++) life.dropFeather(pel.head.getWorldPosition(V3()).add(V3(0, -0.5, 0)), tmp.fwd.clone().multiplyScalar(S.v));
  const lines = ['嘎！', '让一让，鹈鹕要过弯了', '篮子里的鱼不是给你的', '今天的海风刚刚好', '头盔是安全第一'];
  toast('鹈鹕：' + lines[Math.floor(Math.random() * lines.length)]);
}

function photo() {
  audio.init(); audio.shutter();
  composer.render();
  const name = `鹈鹕骑车-${fmtHour(S.hour).replace(':', '')}.png`;
  canvas.toBlob((b) => {
    if (!b) { toast('这次没拍成，再按一次试试'); return; }
    const url = URL.createObjectURL(b);
    if (document.body.classList.contains('touch')) {
      // 手机上很多浏览器不支持直接下载：弹出图片，长按保存
      const v = $('#photo-view'); v.querySelector('img').src = url; v.hidden = false;
      toast('长按图片保存到相册');
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('照片已保存：' + name);
    }
  }, 'image/png');
  const f = $('#flash'); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
}

function setQuality(level, auto = false) {
  Q.level = level;
  Q.pr = level === 'high' ? Math.min(devicePixelRatio, 2) : Math.min(devicePixelRatio, 1);
  Q.bloom = level === 'high';
  renderer.setPixelRatio(Q.pr);
  world.setPR(Q.pr); life.setPR(Q.pr);
  world.sun.shadow.mapSize.set(level === 'high' ? 2048 : 1024, level === 'high' ? 2048 : 1024);
  world.sun.shadow.map?.dispose(); world.sun.shadow.map = null;
  buildComposer();
  applyTime(S.hour);
  $('#btn-quality').setAttribute('aria-pressed', String(level === 'high'));
  $('#btn-quality .lbl').textContent = level === 'high' ? '高画质' : '流畅';
  if (auto) toast('画面有点卡，已切换到流畅画质');
}

function bindUI() {
  const onKey = (e, down) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.tagName === 'INPUT' && e.target.type === 'range' && e.code.startsWith('Arrow')) return;
    if ((e.code === 'Space' || e.code === 'Enter') && e.target.closest && e.target.closest('button')) return; // 让聚焦的按钮自己响应
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': S.boost = down; if (down) { audio.init(); if (!S.started) start(); } e.preventDefault(); break;
      case 'KeyS': case 'ArrowDown': S.brake = down; e.preventDefault(); break;
      case 'Space': case 'KeyB': if (down && !e.repeat) ring(); e.preventDefault(); break;
      case 'Enter': if (down && !S.started) start(); break;
      default:
        if (!down || e.repeat) return;
        if (e.code === 'KeyC') setCamMode(CAM_MODES[(CAM_MODES.indexOf(camRig.mode) + 1) % 4]);
        else if (/^Digit[1-4]$/.test(e.code)) setCamMode(CAM_MODES[+e.code.slice(5) - 1]);
        else if (e.code === 'KeyP') photo();
        else if (e.code === 'KeyH') document.body.classList.toggle('hide-ui');
        else if (e.code === 'KeyM') toggleSound();
        else if (e.code === 'KeyT') toggleAuto();
        else if (e.code === 'KeyG') greet();
        else if (e.code === 'BracketLeft') applyTime(S.hour - 0.5);
        else if (e.code === 'BracketRight') applyTime(S.hour + 0.5);
    }
    if (down) $('#hints').classList.add('used');
  };
  addEventListener('keydown', (e) => onKey(e, true));
  addEventListener('keyup', (e) => onKey(e, false));
  addEventListener('blur', () => { S.boost = S.brake = false; });

  $('#btn-start').addEventListener('click', start);
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => setCamMode(b.dataset.cam)));
  $('#btn-bell').addEventListener('click', ring);
  $('#btn-sound').addEventListener('click', toggleSound);
  $('#btn-music').addEventListener('click', () => { audio.init(); audio.setMusic(!audio.musicOn); $('#btn-music').setAttribute('aria-pressed', String(audio.musicOn)); });
  $('#btn-photo').addEventListener('click', photo);
  $('#btn-hide').addEventListener('click', () => { document.body.classList.add('hide-ui'); toast('按 H 或点一下画面恢复界面'); });
  $('#btn-quality').addEventListener('click', () => setQuality(Q.level === 'high' ? 'low' : 'high'));
  $('#btn-auto').addEventListener('click', toggleAuto);
  // 鼠标点完按钮后把焦点还给画面，空格继续按铃
  document.querySelectorAll('#dock button').forEach((b) => b.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') b.blur(); }));
  $('#photo-view').addEventListener('click', () => { const v = $('#photo-view'); URL.revokeObjectURL(v.querySelector('img').src); v.hidden = true; });
  const slider = $('#time');
  slider.addEventListener('pointerdown', () => (sliderDragging = true));
  addEventListener('pointerup', () => (sliderDragging = false));
  slider.addEventListener('change', () => refreshEnv());
  slider.addEventListener('input', () => { S.autoTime = false; $('#btn-auto').setAttribute('aria-pressed', 'false'); applyTime(parseFloat(slider.value)); });
  const cruise = $('#cruise');
  cruise.addEventListener('input', () => { S.cruise = parseFloat(cruise.value) / 3.6; $('#cruise-out').textContent = `${cruise.value} km/h`; });

  // 按住蹬车 / 刹车（触屏）
  const hold = (el, key) => {
    const on = (e) => { e.preventDefault(); audio.init(); if (!S.started) start(); S[key] = true; el.classList.add('down'); el.setPointerCapture?.(e.pointerId); };
    const off = () => { S[key] = false; el.classList.remove('down'); };
    el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
  };
  hold($('#btn-pedal'), 'boost'); hold($('#btn-brake'), 'brake');
  $('#btn-bell-touch').addEventListener('click', ring);

  // 点击鹈鹕
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  let downAt = null;
  const hitPelican = (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(pel.root, true).length > 0;
  };
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]); downAt = null;
    if (moved > 6) return;
    if (document.body.classList.contains('hide-ui')) { document.body.classList.remove('hide-ui'); return; }
    if (hitPelican(e)) greet();
  });
  let hoverT = 0;
  canvas.addEventListener('pointermove', (e) => {
    const now = performance.now(); if (now - hoverT < 120 || e.pointerType !== 'mouse') return; hoverT = now;
    canvas.style.cursor = hitPelican(e) ? 'pointer' : camRig.mode === 'orbit' ? 'grab' : 'default';
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  });
  if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
}
function toggleSound() {
  audio.init();
  audio.setMuted(!audio.muted);
  $('#btn-sound').setAttribute('aria-pressed', String(!audio.muted));
  $('#btn-sound .lbl').textContent = audio.muted ? '已静音' : '声音';
}
function toggleAuto() {
  S.autoTime = !S.autoTime;
  $('#btn-auto').setAttribute('aria-pressed', String(S.autoTime));
  toast(S.autoTime ? '日夜循环：4 分钟过完一整天' : '时间已停在 ' + fmtHour(S.hour));
}

// ================= 码表 HUD 与像素小地图 =================
let mapBase, mapCtx, mapScale, mapN = 104;
function buildMinimap() {
  const c = $('#map'); mapCtx = c.getContext('2d');
  const W = c.width, H = c.height;
  mapBase = document.createElement('canvas'); mapBase.width = W; mapBase.height = H;
  const g = mapBase.getContext('2d');
  const span = 300; mapScale = W / span;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = (x - W / 2) / mapScale, wz = (y - H / 2) / mapScale;
    const h = world.heightAt(wx, wz);
    const i = (y * W + x) * 4;
    if (h > 0.2) { const dots = (x + y) % 2 === 0; img.data[i] = 23; img.data[i + 1] = 35; img.data[i + 2] = 28; img.data[i + 3] = dots ? 70 : 30; }
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(23,35,28,0.95)'; g.lineWidth = 2; g.beginPath();
  for (let i = 0; i <= 200; i++) { const o = world.road.sample((i / 200) * world.road.L); const x = W / 2 + o.x * mapScale, y = H / 2 + o.z * mapScale; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  const lh = world.lighthouse.position; g.fillStyle = 'rgba(23,35,28,1)'; g.fillRect(W / 2 + lh.x * mapScale - 2, H / 2 + lh.z * mapScale - 2, 4, 4);
}
function updateHUD() {
  const kmh = S.v * 3.6;
  $('#spd').textContent = kmh.toFixed(1);
  $('#cad').textContent = S.pedaling ? Math.round((S.omega / BIKE.ratio) * 60 / TAU) : 0;
  $('#dst').textContent = (S.dist / 1000).toFixed(2);
  $('#clk').textContent = fmtHour(S.hour);
  $('#time-out').textContent = fmtHour(S.hour);
  const coast = !S.pedaling && S.v > 0.5;
  $('#coast').classList.toggle('on', coast);
  const W = mapCtx.canvas.width, H = mapCtx.canvas.height;
  mapCtx.clearRect(0, 0, W, H); mapCtx.drawImage(mapBase, 0, 0);
  const x = W / 2 + rig.position.x * mapScale, y = H / 2 + rig.position.z * mapScale;
  mapCtx.save(); mapCtx.translate(x, y); mapCtx.rotate(Math.atan2(tmp.fwd.z, tmp.fwd.x));
  mapCtx.fillStyle = '#17231c'; mapCtx.beginPath(); mapCtx.moveTo(6, 0); mapCtx.lineTo(-4, 4); mapCtx.lineTo(-2, 0); mapCtx.lineTo(-4, -4); mapCtx.closePath(); mapCtx.fill();
  mapCtx.restore();
}

init();
window.__pel = { S, applyTime: (h) => applyTime(h, true), setCamMode, greet, ring, get camRig() { return camRig; }, get bloom() { return bloom; }, get grade() { return grade; }, renderer, scene, get world() { return world; } };
