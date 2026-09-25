import * as THREE from 'three';
import { V3, TAU, rr, rand, clamp, lerp, damp } from './util.js';
import { makeFish } from './bicycle.js';
import { waveHeight } from './world.js';

// ---------- 飞鸟（鹈鹕编队 + 海鸥） ----------
function makeBird({ span = 2.6, body = 0xf3f2ee, tip = 0x1d1d20, bill = 0xf2b33d, billLen = 0.5, pouch = true }) {
  const g = new THREE.Group();
  const s = span / 2.6;
  const white = new THREE.MeshStandardMaterial({ color: body, roughness: 0.8 });
  const black = new THREE.MeshStandardMaterial({ color: tip, roughness: 0.6 });
  const yellow = new THREE.MeshStandardMaterial({ color: bill, roughness: 0.4 });
  const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), white);
  torso.scale.set(0.55 * s, 0.17 * s, 0.19 * s); g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * s, 12, 10), white); head.position.set(0.5 * s, 0.1 * s, 0); g.add(head);
  const b = new THREE.Mesh(new THREE.ConeGeometry(0.05 * s, billLen * s, 8).rotateZ(-Math.PI / 2), yellow);
  b.scale.set(1, 0.6, 1); b.position.set((0.55 + billLen / 2) * s, 0.06 * s, 0); b.rotation.z = -0.15; g.add(b);
  if (pouch) { const p = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), yellow); p.scale.set(billLen * 0.4 * s, 0.045 * s, 0.04 * s); p.position.set((0.6 + billLen * 0.35) * s, 0.0, 0); g.add(p); }
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1 * s, 0.3 * s, 6).rotateZ(Math.PI / 2), white); tail.scale.set(1, 0.3, 1); tail.position.set(-0.6 * s, 0, 0); g.add(tail);
  const wings = [];
  for (const side of [1, -1]) {
    const inner = new THREE.Group(); inner.position.set(0.05 * s, 0.05 * s, side * 0.12 * s); g.add(inner);
    const iw = new THREE.Mesh(new THREE.BoxGeometry(0.36 * s, 0.03 * s, 0.62 * s).translate(0, 0, side * 0.31 * s), white); inner.add(iw);
    const trail = new THREE.Mesh(new THREE.BoxGeometry(0.12 * s, 0.02 * s, 0.62 * s).translate(-0.2 * s, 0, side * 0.31 * s), black); inner.add(trail);
    const outer = new THREE.Group(); outer.position.set(0, 0, side * 0.62 * s); inner.add(outer);
    const ow = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.025 * s, 0.6 * s).translate(-0.03 * s, 0, side * 0.3 * s), black); outer.add(ow);
    wings.push({ inner, outer, side });
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, wings, phase: rand() * TAU };
}

function flap(bird, t, glide) {
  const f = Math.sin(t * 5 + bird.phase);
  for (const w of bird.wings) {
    const a = glide ? 0.08 + Math.sin(t * 0.8 + bird.phase) * 0.04 : f * 0.55;
    w.inner.rotation.x = -w.side * a;
    w.outer.rotation.x = -w.side * (glide ? 0.05 : Math.sin(t * 5 + bird.phase - 0.7) * 0.45);
  }
}

// ---------- 帆船 ----------
function makeBoat(sailColor) {
  const g = new THREE.Group();
  const hull = new THREE.BoxGeometry(4, 0.9, 1.5, 12, 2, 4);
  const p = hull.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const bow = x > 0 ? 1 - Math.pow(x / 2, 2) : 1 - 0.25 * Math.pow(x / 2, 2);
    const keel = y < 0 ? 0.55 : 1;
    p.setXYZ(i, x, y + (x > 1 ? (x - 1) * 0.2 : 0), z * bow * keel);
  }
  hull.computeVertexNormals();
  g.add(new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.5 })));
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.1, 1.52), new THREE.MeshStandardMaterial({ color: 0x1f2f5a })); stripe.position.y = 0.2; stripe.scale.z = 0.92; g.add(stripe);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 6, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.3 }));
  mast.position.set(0.4, 3.4, 0); g.add(mast);
  const sailShape = new THREE.Shape(); sailShape.moveTo(0, 0); sailShape.lineTo(0, 5.4); sailShape.lineTo(-2.4, 0.1); sailShape.lineTo(0, 0);
  const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), new THREE.MeshStandardMaterial({ color: sailColor, side: THREE.DoubleSide, roughness: 0.8 }));
  sail.position.set(0.35, 0.8, 0); g.add(sail);
  const jibShape = new THREE.Shape(); jibShape.moveTo(0, 0); jibShape.lineTo(0, 4.6); jibShape.lineTo(1.5, 0); jibShape.lineTo(0, 0);
  const jib = new THREE.Mesh(new THREE.ShapeGeometry(jibShape), new THREE.MeshStandardMaterial({ color: 0xf4f1ea, side: THREE.DoubleSide, roughness: 0.8 }));
  jib.position.set(0.5, 0.8, 0.02); g.add(jib);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.sail = sail;
  return g;
}

// ---------- 水花粒子 ----------
function makeSplash(max = 400) {
  const pos = new Float32Array(max * 3), life = new Float32Array(max);
  const vel = Array.from({ length: max }, () => new THREE.Vector3());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('life', new THREE.BufferAttribute(life, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPR: { value: 1 }, uLight: { value: 1 } }, transparent: true, depthWrite: false,
    vertexShader: `attribute float life; varying float vL; uniform float uPR; void main(){ vL = life; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = (life > 0.0 ? 90.0 : 0.0) * uPR / -mv.z * (0.5 + life); }`,
    fragmentShader: `varying float vL; uniform float uLight; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(vec3(0.92,0.97,1.0)*uLight, smoothstep(0.5,0.1,d)*clamp(vL,0.0,1.0)*0.9); }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false;
  let head = 0;
  return {
    pts, mat,
    burst(p, n = 40, power = 3) {
      for (let k = 0; k < n; k++) {
        const i = head; head = (head + 1) % max;
        pos.set([p.x, p.y, p.z], i * 3);
        const a = rand() * TAU, r = rand();
        vel[i].set(Math.cos(a) * r * power * 0.5, power * (0.6 + rand() * 0.8), Math.sin(a) * r * power * 0.5);
        life[i] = 1;
      }
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;
        vel[i].y -= 9.8 * dt;
        pos[i * 3] += vel[i].x * dt; pos[i * 3 + 1] += vel[i].y * dt; pos[i * 3 + 2] += vel[i].z * dt;
        life[i] -= dt * 1.2;
      }
      g.attributes.position.needsUpdate = true; g.attributes.life.needsUpdate = true;
    },
  };
}

export function createLife(scene, world, hooks = {}) {
  // 鹈鹕编队
  const flock = [];
  for (let i = 0; i < 7; i++) {
    const b = makeBird({ span: 2.7 });
    const row = Math.ceil(i / 2), side = i === 0 ? 0 : i % 2 ? 1 : -1;
    b.offset = V3(-row * 3.2, row * 0.3, side * row * 2.8);
    scene.add(b.g); flock.push(b);
  }
  // 海鸥
  const gulls = [];
  for (let i = 0; i < 6; i++) {
    const b = makeBird({ span: 1.1, body: 0xf7f7f5, tip: 0x2a2a2e, bill: 0xf0c040, billLen: 0.18, pouch: false });
    b.center = i < 3 ? world.lighthouse.position.clone() : V3(Math.cos(3.75) * 120, 0, Math.sin(3.75) * 120);
    b.r = rr(12, 30); b.h = rr(14, 26); b.w = rr(0.25, 0.45) * (rand() < 0.5 ? 1 : -1);
    scene.add(b.g); gulls.push(b);
  }
  // 帆船
  const boats = [];
  const sails = [0xf4f1ea, 0xf2b33d, 0x1f2f5a, 0x5fb8a6];
  for (let i = 0; i < 4; i++) {
    const g = makeBoat(sails[i]);
    g.userData.r = 175 + i * 28; g.userData.a = rand() * TAU; g.userData.w = (0.008 + rand() * 0.006) * (i % 2 ? 1 : -1);
    scene.add(g); boats.push(g);
  }
  // 跳鱼
  const splash = makeSplash();
  scene.add(splash.pts);
  const fishes = [];
  for (let i = 0; i < 3; i++) {
    const f = makeFish(i === 1 ? 0xc9b07a : 0x8fb0c8);
    f.scale.setScalar(3.2); f.visible = false;
    scene.add(f);
    fishes.push({ m: f, active: false, p: V3(), v: V3() });
  }
  let nextJump = 3;
  const tmpQ = new THREE.Quaternion();

  // 羽毛飘落
  const feathers = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial({ color: 0xf6f5f0, transparent: true, roughness: 0.9 }));
    m.scale.set(0.05, 0.004, 0.018); m.visible = false; scene.add(m);
    feathers.push({ m, life: 0, v: V3(), spin: V3() });
  }
  let fi = 0;

  const state = { lookFish: null };

  return {
    state,
    dropFeather(p, vel) {
      const f = feathers[fi]; fi = (fi + 1) % feathers.length;
      f.m.position.copy(p); f.v.copy(vel).multiplyScalar(0.7).add(V3(rr(-0.5, 0.5), rr(0.5, 1.4), rr(-0.5, 0.5)));
      f.spin.set(rr(-4, 4), rr(-4, 4), rr(-4, 4)); f.life = 5; f.m.visible = true;
    },
    update(dt, t, bike) {
      // 编队绕岛盘旋，时而滑翔
      const fa = t * 0.035;
      const center = V3(Math.cos(fa) * 150, 34 + Math.sin(t * 0.2) * 4, Math.sin(fa) * 150);
      const heading = fa + Math.PI / 2;
      const glide = Math.sin(t * 0.5) > 0.2;
      for (const b of flock) {
        const off = b.offset.clone().applyAxisAngle(V3(0, 1, 0), -heading);
        b.g.position.copy(center).add(off);
        b.g.rotation.set(0, -heading, 0.12, 'YXZ');
        flap(b, t, glide);
      }
      for (const b of gulls) {
        const a = t * b.w + b.phase;
        b.g.position.set(b.center.x + Math.cos(a) * b.r, b.h + Math.sin(t * 0.7 + b.phase) * 2, b.center.z + Math.sin(a) * b.r);
        b.g.rotation.set(Math.sign(b.w) * 0.35, -(a + Math.sign(b.w) * Math.PI / 2), 0, 'YXZ');
        flap(b, t * 1.6, Math.sin(t + b.phase) > 0.4);
      }
      for (const g of boats) {
        g.userData.a += g.userData.w * dt;
        const a = g.userData.a, r = g.userData.r;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        g.position.set(x, waveHeight(x, z, t) + 0.15, z);
        g.rotation.set(Math.sin(t * 1.1 + r) * 0.06, -(a + Math.sign(g.userData.w) * Math.PI / 2), Math.sin(t * 0.8 + r) * 0.04, 'YXZ');
      }
      // 跳鱼：在自行车前方的海里
      nextJump -= dt;
      if (nextJump < 0 && bike) {
        nextJump = rr(4, 9);
        const f = fishes.find((x) => !x.active);
        if (f) {
          const fwd = bike.fwd, right = bike.right;
          for (let k = 0; k < 8; k++) {
            const p = bike.pos.clone().addScaledVector(fwd, rr(14, 34)).addScaledVector(right, -rr(14, 30));
            if (world.heightAt(p.x, p.z) < -1.0) {
              p.y = 0; f.p.copy(p); f.active = true; f.m.visible = true;
              f.v.copy(fwd).multiplyScalar(rr(-2, 2)).addScaledVector(right, rr(1, 2.5)); f.v.y = rr(6, 8);
              splash.burst(p, 30, 3); hooks.onSplash?.(p, 0.6);
              state.lookFish = f;
              break;
            }
          }
        }
      }
      for (const f of fishes) {
        if (!f.active) continue;
        f.v.y -= 9.8 * dt;
        f.p.addScaledVector(f.v, dt);
        f.m.position.copy(f.p);
        const dir = f.v.clone().normalize();
        tmpQ.setFromUnitVectors(V3(1, 0, 0), dir);
        f.m.quaternion.copy(tmpQ);
        f.m.userData.tail.rotation.y = Math.sin(t * 30) * 0.5;
        if (f.p.y < 0 && f.v.y < 0) {
          f.active = false; f.m.visible = false; splash.burst(f.p, 55, 4); hooks.onSplash?.(f.p, 1);
          if (state.lookFish === f) state.lookFish = null;
        }
      }
      splash.update(dt);
      for (const f of feathers) {
        if (f.life <= 0) continue;
        f.life -= dt;
        f.v.multiplyScalar(Math.exp(-2.2 * dt)); f.v.y -= 0.35 * dt;
        f.v.x += Math.sin(t * 3 + f.spin.x) * 0.4 * dt; f.v.z += Math.cos(t * 2.3 + f.spin.y) * 0.4 * dt;
        f.m.position.addScaledVector(f.v, dt);
        f.m.rotation.x += f.spin.x * dt; f.m.rotation.y += f.spin.y * dt; f.m.rotation.z = Math.sin(t * 4 + f.spin.z) * 0.8;
        const gy = world.heightAt(f.m.position.x, f.m.position.z);
        if (f.m.position.y < gy + 0.02) { f.m.position.y = gy + 0.02; f.v.set(0, 0, 0); }
        f.m.material.opacity = clamp(f.life, 0, 1);
        if (f.life <= 0) f.m.visible = false;
      }
    },
    setLight(k) { splash.mat.uniforms.uLight.value = k; },
    setPR(pr) { splash.mat.uniforms.uPR.value = pr; },
  };
}
