import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { V3, tubeBetween, sweepTube, canvasTex, TAU, Spring } from './util.js';

// 自行车局部坐标：+X 向前，+Y 向上，+Z 指向骑手右侧（链条侧）
export const BIKE = {
  R: 0.35,
  rear: V3(-0.52, 0.35, 0),
  front: V3(0.57, 0.35, 0),
  bb: V3(-0.06, 0.29, 0),
  seatTop: V3(-0.25, 0.84, 0),
  headTop: V3(0.35, 0.90, 0),
  headBot: V3(0.40, 0.76, 0),
  saddle: V3(-0.30, 0.975, 0),
  crank: 0.17,
  pedalZ: 0.145,
  r1: 0.095, // 牙盘节圆半径
  r2: 0.0345, // 飞轮节圆半径
};
BIKE.ratio = BIKE.r1 / BIKE.r2;

export function makeMaterials() {
  return {
    frame: new THREE.MeshPhysicalMaterial({ color: 0x5fb8a6, metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 1, roughness: 0.16 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6d7378, metalness: 0.9, roughness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, metalness: 0.2, roughness: 0.55 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.92 }),
    gum: new THREE.MeshStandardMaterial({ color: 0xb58a5a, roughness: 0.85 }),
    leather: new THREE.MeshPhysicalMaterial({ color: 0x6b3b22, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.4 }),
    lens: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 0.0, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0xa01010, emissive: 0xff2010, emissiveIntensity: 0.0, roughness: 0.3 }),
  };
}

/** 按材质收集几何体，最后合并成少量网格 */
class Batch {
  constructor() { this.map = new Map(); }
  add(mat, geo) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (!this.map.has(mat)) this.map.set(mat, []);
    this.map.get(mat).push(g);
  }
  build(parent) {
    for (const [mat, list] of this.map) {
      const m = new THREE.Mesh(mergeGeometries(list), mat);
      m.castShadow = true; m.receiveShadow = true;
      parent.add(m);
    }
  }
}

function gearShape(teeth, rOuter, rRoot, holes = 0, holeR = 0, holeDist = 0, bore = 0.012) {
  const s = new THREE.Shape();
  const n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const phase = i % 4;
    const r = phase === 1 || phase === 2 ? rOuter : rRoot;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  for (let h = 0; h < holes; h++) {
    const a = (h / holes) * TAU + 0.3;
    const p = new THREE.Path();
    p.absarc(Math.cos(a) * holeDist, Math.sin(a) * holeDist, holeR, 0, TAU, true);
    s.holes.push(p);
  }
  if (bore) { const p = new THREE.Path(); p.absarc(0, 0, bore, 0, TAU, true); s.holes.push(p); }
  return s;
}

function makeWheel(M) {
  const g = new THREE.Group();
  const b = new Batch();
  const R = BIKE.R;
  // 轮胎 + 奶油色胎侧
  b.add(M.tire, new THREE.TorusGeometry(R - 0.034, 0.034, 14, 72));
  const gw = new THREE.TorusGeometry(R - 0.05, 0.022, 10, 72);
  b.add(M.gum, gw.clone().translate(0, 0, 0.014));
  b.add(M.gum, gw.clone().translate(0, 0, -0.014));
  // 轮圈
  b.add(M.chrome, new THREE.TorusGeometry(R - 0.066, 0.011, 8, 72));
  // 花鼓
  b.add(M.chrome, new THREE.CylinderGeometry(0.018, 0.018, 0.1, 16).rotateX(Math.PI / 2));
  b.add(M.chrome, new THREE.CylinderGeometry(0.03, 0.03, 0.006, 20).rotateX(Math.PI / 2).translate(0, 0, 0.034));
  b.add(M.chrome, new THREE.CylinderGeometry(0.03, 0.03, 0.006, 20).rotateX(Math.PI / 2).translate(0, 0, -0.034));
  // 36 根交叉辐条
  const spokes = 36, rimR = R - 0.07;
  for (let i = 0; i < spokes; i++) {
    const side = i % 2 ? 1 : -1;
    const a = (i / spokes) * TAU;
    const cross = (i % 4 < 2 ? 1 : -1) * 0.42;
    const hub = V3(Math.cos(a) * 0.027, Math.sin(a) * 0.027, side * 0.034);
    const rim = V3(Math.cos(a + cross) * rimR, Math.sin(a + cross) * rimR, side * 0.004);
    b.add(M.chrome, tubeBetween(hub, rim, 0.0016, 0.0016, 4));
  }
  b.build(g);
  // 气门芯（让旋转更容易被看出）
  const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 6), M.chrome);
  valve.position.set(0, R - 0.085, 0);
  g.add(valve);
  // 反光片
  const refl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.004), new THREE.MeshStandardMaterial({ color: 0xffa51f, emissive: 0x552200, roughness: 0.3 }));
  refl.position.set(0, R * 0.55, 0.012); refl.rotation.z = 0.5;
  g.add(refl);
  return g;
}

function fenderGeo(r, width, phiStart, phiLen) {
  // CylinderGeometry 绕 Y 轴展开，绕 X 旋转 90° 后角度 φ = θ - 90°
  const g = new THREE.CylinderGeometry(r, r, width, 40, 1, true, THREE.MathUtils.degToRad(phiStart + 90), THREE.MathUtils.degToRad(phiLen));
  g.rotateX(Math.PI / 2);
  return g;
}

/** 链条路径：上链从飞轮到牙盘，绕牙盘前方，下链回到飞轮，绕飞轮后方 */
function chainPath() {
  const C1 = V3(BIKE.bb.x, BIKE.bb.y, 0), C2 = V3(BIKE.rear.x, BIKE.rear.y, 0);
  const r1 = BIKE.r1, r2 = BIKE.r2;
  const D = C2.clone().sub(C1);
  const dist = D.length();
  const beta = Math.atan2(D.y, D.x);
  const alpha = Math.acos((r1 - r2) / dist);
  let aTop = beta - alpha, aBot = beta + alpha; // aTop≈90°, aBot≈255°
  if (Math.sin(aTop) < Math.sin(aBot)) [aTop, aBot] = [aBot, aTop];
  const pt = (C, r, a) => V3(C.x + Math.cos(a) * r, C.y + Math.sin(a) * r, 0);
  const segs = [];
  // 1 上链：飞轮顶 -> 牙盘顶
  segs.push({ type: 'line', a: pt(C2, r2, aTop), b: pt(C1, r1, aTop) });
  // 2 牙盘：从 aTop 顺时针到 aBot（角度递减）
  let a1 = aTop, a2 = aBot; while (a2 > a1) a2 -= TAU;
  segs.push({ type: 'arc', C: C1, r: r1, a0: a1, a1: a2 });
  // 3 下链：牙盘底 -> 飞轮底
  segs.push({ type: 'line', a: pt(C1, r1, aBot), b: pt(C2, r2, aBot) });
  // 4 飞轮：从 aBot 顺时针到 aTop
  let b1 = aBot, b2 = aTop; while (b2 > b1) b2 -= TAU;
  segs.push({ type: 'arc', C: C2, r: r2, a0: b1, a1: b2 });
  for (const s of segs) s.len = s.type === 'line' ? s.a.distanceTo(s.b) : Math.abs(s.a1 - s.a0) * s.r;
  const total = segs.reduce((a, s) => a + s.len, 0);
  function sample(d, P, T) {
    d = ((d % total) + total) % total;
    for (const s of segs) {
      if (d <= s.len) {
        const t = d / s.len;
        if (s.type === 'line') { P.lerpVectors(s.a, s.b, t); T.subVectors(s.b, s.a).normalize(); }
        else {
          const a = s.a0 + (s.a1 - s.a0) * t;
          P.set(s.C.x + Math.cos(a) * s.r, s.C.y + Math.sin(a) * s.r, 0);
          T.set(Math.sin(a), -Math.cos(a), 0); // 顺时针切向
        }
        return;
      }
      d -= s.len;
    }
  }
  return { total, sample };
}

function wickerTexture() {
  return canvasTex(256, 128, (c, w, h) => {
    c.fillStyle = '#8a5a2b'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      for (let x = 0; x < w; x += 16) {
        const odd = ((x + y) / 16) % 2;
        const g = c.createLinearGradient(x, y, x + (odd ? 16 : 0), y + (odd ? 0 : 16));
        g.addColorStop(0, '#c89556'); g.addColorStop(0.5, '#e0b47a'); g.addColorStop(1, '#a8743c');
        c.fillStyle = g;
        c.beginPath();
        if (c.roundRect) c.roundRect(x + 1.5, y + 1.5, 13, 13, 5); else c.rect(x + 1.5, y + 1.5, 13, 13);
        c.fill();
      }
    }
  }, { repeat: [3, 1] });
}

function makeFish(color = 0x9fb4c4) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.3 });
  const pts = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector2(Math.sin(Math.PI * t) * 0.03 * (0.6 + 0.4 * t), (t - 0.5) * 0.2)); }
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 14), mat);
  body.scale.set(1, 1, 0.55);
  body.rotation.z = -Math.PI / 2;
  g.add(body);
  const tailShape = new THREE.Shape();
  tailShape.moveTo(0, 0); tailShape.lineTo(-0.06, 0.04); tailShape.lineTo(-0.045, 0); tailShape.lineTo(-0.06, -0.04); tailShape.lineTo(0, 0);
  const tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape), new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.35, side: THREE.DoubleSide }));
  tail.position.x = -0.09;
  g.add(tail);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  eye.position.set(0.07, 0.008, 0.012); g.add(eye);
  const eye2 = eye.clone(); eye2.position.z = -0.012; g.add(eye2);
  g.userData.tail = tail;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
export { makeFish };

export function createBicycle() {
  const M = makeMaterials();
  const root = new THREE.Group();
  root.name = 'bicycle';
  const frame = new Batch();

  // ---------- 车架 ----------
  const { bb, seatTop, headTop, headBot, rear } = BIKE;
  const ttEnd = headTop.clone().lerp(headBot, 0.2);
  frame.add(M.frame, tubeBetween(seatTop.clone().add(V3(0.005, -0.03, 0)), ttEnd, 0.017));
  frame.add(M.frame, tubeBetween(bb, headBot.clone().lerp(headTop, 0.15), 0.021));
  frame.add(M.frame, tubeBetween(bb, seatTop, 0.018));
  frame.add(M.frame, tubeBetween(headBot, headTop, 0.024, 0.024, 16));
  frame.add(M.frame, new THREE.SphereGeometry(0.03, 16, 12).translate(bb.x, bb.y, bb.z));
  frame.add(M.chrome, new THREE.CylinderGeometry(0.026, 0.026, 0.09, 16).rotateX(Math.PI / 2).translate(bb.x, bb.y, 0));
  for (const s of [-1, 1]) {
    frame.add(M.frame, tubeBetween(V3(bb.x - 0.03, bb.y, s * 0.02), V3(rear.x + 0.02, rear.y, s * 0.062), 0.011, 0.009));
    frame.add(M.frame, tubeBetween(V3(seatTop.x + 0.01, seatTop.y - 0.04, s * 0.015), V3(rear.x + 0.015, rear.y + 0.01, s * 0.062), 0.009, 0.008));
    frame.add(M.chrome, new THREE.CylinderGeometry(0.009, 0.009, 0.018, 10).rotateX(Math.PI / 2).translate(rear.x, rear.y, s * 0.068));
  }
  // 座管 + 弹簧皮座
  const seatDir = seatTop.clone().sub(bb).normalize();
  const postTop = seatTop.clone().addScaledVector(seatDir, 0.1);
  frame.add(M.chrome, tubeBetween(seatTop, postTop, 0.012));
  frame.add(M.chrome, tubeBetween(postTop, BIKE.saddle.clone().add(V3(0.02, -0.03, 0)), 0.01));
  const saddle = new THREE.SphereGeometry(1, 28, 16);
  {
    const p = saddle.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const tt = (x + 1) / 2; // 0 后 1 前
      z *= 0.085 * (1 - 0.62 * Math.pow(tt, 1.4));
      y = y > 0 ? y * 0.03 : y * 0.018;
      x *= 0.135;
      p.setXYZ(i, x, y, z);
    }
    saddle.computeVertexNormals();
    saddle.translate(BIKE.saddle.x, BIKE.saddle.y, 0);
  }
  frame.add(M.leather, saddle);
  for (const s of [-1, 1]) {
    const helix = new THREE.Curve();
    helix.getPoint = (t, v = new THREE.Vector3()) => v.set(Math.cos(t * TAU * 5) * 0.012, t * 0.045, Math.sin(t * TAU * 5) * 0.012);
    const coil = new THREE.TubeGeometry(helix, 80, 0.0022, 5, false);
    coil.translate(BIKE.saddle.x - 0.07, BIKE.saddle.y - 0.06, s * 0.045);
    frame.add(M.chrome, coil);
  }
  // 挡泥板（后）+ 尾灯
  frame.add(M.frame, fenderGeo(0.39, 0.058, 25, 165).translate(rear.x, rear.y, 0));
  frame.add(M.chrome, tubeBetween(V3(rear.x - 0.3, rear.y + 0.02, 0.06), V3(rear.x, rear.y, 0.062), 0.004));
  frame.add(M.chrome, tubeBetween(V3(rear.x - 0.3, rear.y + 0.02, -0.06), V3(rear.x, rear.y, -0.062), 0.004));
  frame.build(root);

  const tailLight = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.04, 0.05), M.tail);
  tailLight.position.set(rear.x - 0.385, rear.y + 0.06, 0);
  tailLight.rotation.z = -0.3;
  root.add(tailLight);

  // ---------- 车轮 ----------
  const rearWheel = makeWheel(M); rearWheel.position.copy(rear); root.add(rearWheel);
  // 飞轮随后轮转动
  const cog = new THREE.Mesh(new THREE.ExtrudeGeometry(gearShape(16, BIKE.r2 + 0.005, BIKE.r2 - 0.002, 0, 0, 0, 0.01), { depth: 0.004, bevelEnabled: false }), M.steel);
  cog.position.set(0, 0, 0.042);
  rearWheel.add(cog);

  // ---------- 前叉组（绕转向轴旋转） ----------
  const steerAxis = headTop.clone().sub(headBot).normalize();
  const front = new THREE.Group(); front.position.copy(headBot); root.add(front);
  const frontInner = new THREE.Group(); frontInner.position.copy(headBot).negate(); front.add(frontInner);
  const fb = new Batch();
  const crown = headBot.clone().addScaledVector(steerAxis, -0.03);
  fb.add(M.chrome, new THREE.BoxGeometry(0.05, 0.02, 0.12).translate(crown.x, crown.y, 0));
  for (const s of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      V3(crown.x, crown.y, s * 0.05), V3(crown.x + 0.075, crown.y - 0.2, s * 0.053), V3(BIKE.front.x, BIKE.front.y, s * 0.055),
    ]);
    fb.add(M.frame, new THREE.TubeGeometry(curve, 16, 0.012, 8, false));
    fb.add(M.chrome, new THREE.CylinderGeometry(0.009, 0.009, 0.018, 10).rotateX(Math.PI / 2).translate(BIKE.front.x, BIKE.front.y, s * 0.062));
  }
  // 立管 + 弯把
  const stemTop = headTop.clone().addScaledVector(steerAxis, 0.12);
  const clamp = stemTop.clone().add(V3(0.05, 0.02, 0));
  fb.add(M.chrome, tubeBetween(headTop, stemTop, 0.013));
  fb.add(M.chrome, tubeBetween(stemTop, clamp, 0.012));
  const barPts = [
    V3(0.19, 1.07, -0.305), V3(0.27, 1.064, -0.29), V3(0.345, 1.045, -0.2), V3(clamp.x, clamp.y, -0.06), V3(clamp.x, clamp.y, 0.06),
    V3(0.345, 1.045, 0.2), V3(0.27, 1.064, 0.29), V3(0.19, 1.07, 0.305),
  ];
  fb.add(M.chrome, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(barPts), 60, 0.011, 8, false));
  const grips = []; // [右(+Z), 左(-Z)]，与鹈鹕肩膀顺序一致
  for (const s of [1, -1]) {
    const a = V3(0.262, 1.064, s * 0.291), b = V3(0.178, 1.07, s * 0.306);
    fb.add(M.leather, tubeBetween(a, b, 0.017, 0.017, 12));
    fb.add(M.leather, new THREE.SphereGeometry(0.017, 12, 8).translate(b.x, b.y, b.z));
    // 刹把
    fb.add(M.chrome, tubeBetween(V3(0.29, 1.062, s * 0.26), V3(0.235, 1.05, s * 0.31), 0.005));
    const marker = new THREE.Object3D(); marker.position.copy(a).lerp(b, 0.55); frontInner.add(marker); grips.push(marker);
  }
  // 前挡泥板
  fb.add(M.frame, fenderGeo(0.39, 0.058, -15, 150).translate(BIKE.front.x, BIKE.front.y, 0));
  // 车篮支架
  const basketC = V3(0.62, 0.975, 0);
  for (const s of [-1, 1]) fb.add(M.chrome, tubeBetween(V3(basketC.x + 0.02, basketC.y - 0.09, s * 0.08), V3(BIKE.front.x, BIKE.front.y, s * 0.06), 0.005));
  fb.add(M.chrome, tubeBetween(V3(basketC.x - 0.16, basketC.y + 0.02, 0), clamp, 0.006));
  fb.build(frontInner);

  // 车篮
  const wick = wickerTexture();
  const wmat = new THREE.MeshStandardMaterial({ map: wick, roughness: 0.85, side: THREE.DoubleSide });
  const basket = new THREE.Group(); basket.position.copy(basketC); frontInner.add(basket);
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.17, 32, 1, true), wmat);
  wall.scale.set(1, 1, 0.82); wall.castShadow = true; basket.add(wall);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.14, 32).rotateX(-Math.PI / 2), wmat);
  bottom.scale.set(1, 1, 0.82); bottom.position.y = -0.085; basket.add(bottom);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.011, 8, 48).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9b6a35, roughness: 0.8 }));
  rim.scale.set(1, 0.82, 1); rim.position.y = 0.085; basket.add(rim);
  const fishes = [];
  for (let i = 0; i < 3; i++) {
    const f = makeFish(i === 1 ? 0xc9a36a : 0x9fb4c4);
    f.position.set(-0.03 + i * 0.03, 0.06 + i * 0.012, -0.05 + i * 0.05);
    f.rotation.set(0.3 * (i - 1), i * 0.9 - 0.6, 1.0 + i * 0.25);
    basket.add(f); fishes.push(f);
  }
  // 法棍（海边早餐）
  const bread = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.26, 6, 12), new THREE.MeshStandardMaterial({ color: 0xc98a3f, roughness: 0.75 }));
  bread.position.set(-0.06, 0.1, 0.06); bread.rotation.set(0.3, 0.2, 1.05); bread.castShadow = true;
  basket.add(bread);

  // 车灯
  const lampBody = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.06, 18).rotateZ(Math.PI / 2), M.chrome);
  lampBody.position.set(basketC.x + 0.19, basketC.y - 0.06, 0); frontInner.add(lampBody);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 20).rotateY(Math.PI / 2), M.lens);
  lens.position.set(basketC.x + 0.221, basketC.y - 0.06, 0); frontInner.add(lens);
  const headlight = new THREE.SpotLight(0xfff0d0, 0, 26, 0.5, 0.6, 1.4);
  headlight.position.copy(lens.position);
  const hlTarget = new THREE.Object3D(); hlTarget.position.set(basketC.x + 4, -0.6, 0);
  frontInner.add(headlight, hlTarget); headlight.target = hlTarget;

  // 车铃
  const bell = new THREE.Group(); bell.position.set(0.31, 1.078, -0.225); frontInner.add(bell);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 10, 0, TAU, 0, Math.PI / 2), M.chrome);
  bell.add(dome);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.008), M.steel); lever.position.set(-0.02, -0.004, 0.01); bell.add(lever);
  const bellSpring = new Spring(900, 6);

  const frontWheel = makeWheel(M);
  frontWheel.position.copy(BIKE.front); frontInner.add(frontWheel);

  // ---------- 牙盘、曲柄、脚踏 ----------
  const crankG = new THREE.Group(); crankG.position.copy(bb); root.add(crankG);
  const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(gearShape(44, BIKE.r1 + 0.006, BIKE.r1 - 0.002, 5, 0.022, 0.058, 0.016), { depth: 0.004, bevelEnabled: false }), M.chrome);
  ring.position.z = 0.04; ring.castShadow = true; crankG.add(ring);
  const armGeo = new THREE.BoxGeometry(BIKE.crank + 0.02, 0.022, 0.012).translate(BIKE.crank / 2, 0, 0);
  const armR = new THREE.Mesh(armGeo, M.chrome); armR.position.z = 0.058; crankG.add(armR);
  const armL = new THREE.Mesh(armGeo, M.chrome); armL.position.z = -0.058; armL.rotation.z = Math.PI; crankG.add(armL);
  armR.castShadow = armL.castShadow = true;
  const pedals = [];
  for (const s of [1, -1]) {
    const p = new THREE.Group();
    const plat = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.018, 0.075), M.dark);
    plat.position.z = s * 0.02; plat.castShadow = true; p.add(plat);
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 8).rotateX(Math.PI / 2), M.chrome);
    spindle.position.z = -s * 0.02; p.add(spindle);
    for (const e of [-1, 1]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.098, 0.022, 0.008), M.steel);
      r.position.set(0, 0, s * 0.02 + e * 0.036); p.add(r);
    }
    root.add(p); pedals.push(p);
  }

  // ---------- 链条（实例化链节） ----------
  const chain = chainPath();
  const nLinks = Math.round(chain.total / 0.0127);
  const linkLen = chain.total / nLinks;
  const linkGeo = new THREE.BoxGeometry(linkLen * 1.08, 0.0075, 0.0085);
  const links = new THREE.InstancedMesh(linkGeo, new THREE.MeshStandardMaterial({ color: 0x5a5f63, metalness: 0.85, roughness: 0.35 }), nLinks);
  links.position.z = 0.042; links.castShadow = true; root.add(links);
  const _P = new THREE.Vector3(), _T = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
  const _X = new THREE.Vector3(1, 0, 0);
  function updateChain(offset) {
    for (let i = 0; i < nLinks; i++) {
      chain.sample(i * linkLen + offset, _P, _T);
      _q.setFromUnitVectors(_X, _T);
      _s.set(1, i % 2 ? 1 : 0.8, i % 2 ? 1 : 1.25);
      _m.compose(_P, _q, _s);
      links.setMatrixAt(i, _m);
    }
    links.instanceMatrix.needsUpdate = true;
  }
  updateChain(0);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const state = { crank: 0, wheel: 0, steer: 0 };
  const _pp = new THREE.Vector3();

  return {
    root, front, grips, headlight, lensMat: M.lens, tailMat: M.tail, fishes, bell,
    state,
    ringBell() { bellSpring.kick(40); },
    pedalPos(side, out = new THREE.Vector3()) {
      // side: 0 右 1 左
      const a = -state.crank + (side ? Math.PI : 0);
      return out.set(bb.x + Math.cos(a) * BIKE.crank, bb.y + Math.sin(a) * BIKE.crank, side ? -BIKE.pedalZ : BIKE.pedalZ);
    },
    update(dt, t) {
      rearWheel.rotation.z = -state.wheel;
      frontWheel.rotation.z = -state.wheel;
      crankG.rotation.z = -state.crank;
      front.quaternion.setFromAxisAngle(steerAxis, state.steer);
      updateChain(state.crank * BIKE.r1);
      for (let i = 0; i < 2; i++) pedals[i].position.copy(this.pedalPos(i, _pp));
      const b = bellSpring.step(dt);
      bell.rotation.set(b * 0.02, 0, Math.sin(t * 90) * b * 0.01);
      // 篮子里的鱼偶尔甩尾
      fishes.forEach((f, i) => { f.userData.tail.rotation.y = Math.sin(t * 7 + i * 2) * 0.35 * Math.max(0, Math.sin(t * 0.7 + i * 1.7)); });
    },
  };
}
