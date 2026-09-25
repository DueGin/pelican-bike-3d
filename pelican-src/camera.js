import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { V3, damp, lerp, clamp, rr } from './util.js';
import { HALF_W } from './world.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** 竖屏时适当放大视角，别让鹈鹕挤出画面 */
export function fitFov(fov, aspect) {
  if (aspect >= 1.5) return fov;
  const k = Math.sqrt(1.6 / aspect);
  return Math.min(95, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * k)));
}

export const CAM_MODES = ['chase', 'orbit', 'cinema', 'pov'];

export class CameraRig {
  constructor(camera, dom, reduceMotion = false) {
    this.camera = camera;
    this.reduce = reduceMotion;
    this.mode = 'chase';
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enabled = false; this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 1.2; this.orbit.maxDistance = 40; this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.pos = camera.position.clone(); this.look = V3(); this.fov = 50;
    this.shotIdx = -1; this.shotT = 0; this.shotLen = 6; this.fixed = V3();
    this.order = [0, 5, 2, 3, 1, 4, 6];
    this.lastBike = null;
    this.intro = null;
    this.snap = true;
  }
  setMode(m, ctx) {
    this.mode = m;
    this.orbit.enabled = m === 'orbit';
    if (m === 'orbit' && ctx) { this.orbit.target.copy(ctx.bikePos).add(V3(0, 1.1, 0)); this.lastBike = ctx.bikePos.clone(); }
    if (m === 'cinema') { this.shotIdx = -1; this.shotT = 1e9; }
    if (!this.intro) this.snap = m === 'pov' || m === 'cinema';
  }
  startIntro(from, lookFrom, dur = 2.4) {
    this.intro = { t: 0, dur: this.reduce ? 0.01 : dur, from: from.clone(), lookFrom: lookFrom.clone() };
    this.pos.copy(from); this.look.copy(lookFrom); this.snap = false;
    this.intro.fov0 = this.fov = this.camera.userData.baseFov ?? 42;
  }
  shotName() {
    return ['侧面跟拍', '正面迎面', '路边定机位', '航拍环绕', '传动特写', '鹈鹕肖像', '远景'][this.order[this.shotIdx % this.order.length]];
  }
  update(dt, ctx) {
    const cam = this.camera;
    const { bikePos, fwd, right, head, speed, t } = ctx;
    const up = V3(0, 1, 0);
    let pos = V3(), look = V3(), fov = 50, lp = 4, ll = 8;
    let near = 0.1;

    if (this.mode === 'chase' || this.intro) {
      const back = 3.1 + speed * 0.09;
      pos.copy(bikePos).addScaledVector(fwd, -back).addScaledVector(right, 2.0).addScaledVector(up, 1.6 + speed * 0.03);
      look.copy(bikePos).addScaledVector(up, 1.1).addScaledVector(fwd, 1.2);
      fov = 50 + clamp(speed - 4, 0, 8) * 1.1;
    }
    if (this.mode === 'orbit' && !this.intro) {
      if (!this.lastBike) this.lastBike = bikePos.clone();
      const d = bikePos.clone().sub(this.lastBike);
      cam.position.add(d); this.orbit.target.add(d);
      this.lastBike.copy(bikePos);
      this.orbit.target.lerp(bikePos.clone().add(V3(0, 1.1, 0)), 1 - Math.exp(-6 * dt));
      this.orbit.update();
      const gy = ctx.heightAt(cam.position.x, cam.position.z) + 0.4;
      if (cam.position.y < gy) cam.position.y = gy;
      cam.fov = damp(cam.fov, fitFov(50, cam.aspect), 4, dt); cam.near = 0.1; cam.updateProjectionMatrix();
      this.pos.copy(cam.position); this.look.copy(this.orbit.target);
      return;
    }
    if (this.mode === 'pov' && !this.intro) {
      ctx.pov.getWorldPosition(pos);
      const hf = V3(1, 0, 0).applyQuaternion(ctx.headQuat);
      look.copy(pos).addScaledVector(hf, 5).addScaledVector(fwd, 5).addScaledVector(up, -2.1);
      fov = 72; lp = 30; ll = 12; near = 0.03;
    }
    if (this.mode === 'cinema' && !this.intro) {
      this.shotT += dt;
      if (this.shotT > this.shotLen) {
        this.shotIdx++; this.shotT = 0; this.snap = true;
        const id = this.order[this.shotIdx % this.order.length];
        this.shotLen = id === 2 ? 7.5 : id === 3 ? 8 : 6;
        if (id === 2) {
          const o = ctx.road.sample(ctx.s + Math.max(22, speed * 6));
          this.fixed.set(o.x + o.rx * (HALF_W + 3.2), 0, o.z + o.rz * (HALF_W + 3.2));
          this.fixed.y = Math.max(ctx.heightAt(this.fixed.x, this.fixed.z), o.y) + 1.3;
        }
        ctx.onShot?.(this.shotName());
      }
      const id = this.order[this.shotIdx % this.order.length];
      const tau = this.shotT;
      switch (id) {
        case 0: // 右侧低机位跟拍（能看到链条侧）
          pos.copy(bikePos).addScaledVector(right, 2.7).addScaledVector(up, 0.6).addScaledVector(fwd, -0.8 + tau * 0.12);
          look.copy(bikePos).addScaledVector(up, 0.95).addScaledVector(fwd, 0.1);
          fov = 42; break;
        case 1: // 正面
          pos.copy(bikePos).addScaledVector(fwd, 3.6 - tau * 0.08).addScaledVector(up, 1.25).addScaledVector(right, 0.5);
          look.copy(head).addScaledVector(up, -0.35);
          fov = 45; break;
        case 2: // 路边定机位
          pos.copy(this.fixed);
          look.copy(bikePos).addScaledVector(up, 1.0);
          fov = clamp(30 + bikePos.distanceTo(this.fixed) * 0.9, 30, 55); break;
        case 3: { // 航拍环绕
          const a = tau * 0.16 + 2.2;
          pos.copy(bikePos).addScaledVector(fwd, Math.cos(a) * 11).addScaledVector(right, Math.sin(a) * 11).addScaledVector(up, 7.5);
          look.copy(bikePos).addScaledVector(up, 0.8);
          fov = 45; break;
        }
        case 4: // 传动特写
          pos.copy(ctx.bb).addScaledVector(right, 0.95).addScaledVector(up, 0.2).addScaledVector(fwd, 0.35 - tau * 0.05);
          look.copy(ctx.bb).addScaledVector(up, 0.12).addScaledVector(fwd, -0.12);
          fov = 40; break;
        case 5: // 鹈鹕肖像
          pos.copy(bikePos).addScaledVector(fwd, 1.5).addScaledVector(right, 1.0 - tau * 0.05).addScaledVector(up, 1.85);
          look.copy(head).addScaledVector(fwd, 0.18).addScaledVector(up, -0.08);
          fov = 36; break;
        default: // 远景
          pos.copy(bikePos).addScaledVector(fwd, -14 + tau * 0.6).addScaledVector(right, -11).addScaledVector(up, 5.5);
          look.copy(bikePos).addScaledVector(up, 1.2).addScaledVector(fwd, 3);
          fov = 40;
      }
      lp = 20; ll = 20;
      if (!this.reduce) { pos.x += Math.sin(t * 0.9) * 0.03; pos.y += Math.sin(t * 1.3) * 0.02; }
    }

    // 开场运镜
    if (this.intro) {
      const it = this.intro;
      it.t += dt;
      const k = ease(clamp(it.t / it.dur, 0, 1));
      const p = it.from.clone().lerp(pos, k); p.y += Math.sin(k * Math.PI) * 0.8;
      pos.copy(p);
      look.copy(it.lookFrom.clone().lerp(look, k));
      fov = lerp(it.fov0 ?? 40, fov, k);
      lp = 60; ll = 60;
      if (it.t >= it.dur) { this.intro = null; this.snap = false; }
    }

    // 不钻进地里
    const gy = ctx.heightAt(pos.x, pos.z) + (this.mode === 'pov' ? 0 : 0.35);
    if (pos.y < gy) pos.y = gy;

    if (this.snap) { this.pos.copy(pos); this.look.copy(look); this.fov = fov; this.snap = false; }
    else {
      this.pos.x = damp(this.pos.x, pos.x, lp, dt); this.pos.y = damp(this.pos.y, pos.y, lp, dt); this.pos.z = damp(this.pos.z, pos.z, lp, dt);
      this.look.x = damp(this.look.x, look.x, ll, dt); this.look.y = damp(this.look.y, look.y, ll, dt); this.look.z = damp(this.look.z, look.z, ll, dt);
      this.fov = damp(this.fov, fov, 3, dt);
    }
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    if (this.mode === 'pov') cam.rotateZ(-ctx.lean * 0.4);
    cam.fov = fitFov(this.fov, cam.aspect); cam.near = near; cam.updateProjectionMatrix();
  }
}
