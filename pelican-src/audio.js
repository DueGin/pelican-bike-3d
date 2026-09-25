// 全部音效由 WebAudio 实时合成，无任何音频文件
export class AudioEngine {
  constructor() {
    this.ctx = null; this.muted = false; this.musicOn = true;
    this.nextTick = 0; this.nextNote = 0; this.step = 0; this.bar = 0;
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    // 噪声缓冲
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.985 * b0 + 0.015 * w; d[i] = w * 0.5 + b0 * 6; }
    this.noiseBuf = buf;
    const loopNoise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 2); return s; };
    // 海浪：低通噪声 + 缓慢起伏
    const ocean = loopNoise();
    this.oceanF = ctx.createBiquadFilter(); this.oceanF.type = 'lowpass'; this.oceanF.frequency.value = 420;
    this.oceanG = ctx.createGain(); this.oceanG.gain.value = 0.0;
    ocean.connect(this.oceanF).connect(this.oceanG).connect(this.master);
    // 风声：带通噪声，随速度变化
    const wind = loopNoise();
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.Q.value = 0.6; this.windF.frequency.value = 500;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    wind.connect(this.windF).connect(this.windG).connect(this.master);
    // 链条沙沙声
    const chain = loopNoise();
    this.chainF = ctx.createBiquadFilter(); this.chainF.type = 'bandpass'; this.chainF.frequency.value = 3200; this.chainF.Q.value = 3;
    this.chainG = ctx.createGain(); this.chainG.gain.value = 0;
    chain.connect(this.chainF).connect(this.chainG).connect(this.master);
    // 飞轮棘轮“咔哒”
    const clen = Math.floor(ctx.sampleRate * 0.012);
    this.clickBuf = ctx.createBuffer(1, clen, ctx.sampleRate);
    const cd = this.clickBuf.getChannelData(0);
    for (let i = 0; i < clen; i++) cd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (clen * 0.12));
    this.clickBus = ctx.createBiquadFilter(); this.clickBus.type = 'highpass'; this.clickBus.frequency.value = 2400;
    const cg = ctx.createGain(); cg.gain.value = 0.22; this.clickBus.connect(cg).connect(this.master);
    // 音乐总线
    this.musicG = ctx.createGain(); this.musicG.gain.value = this.musicOn ? 0.5 : 0;
    const delay = ctx.createDelay(); delay.delayTime.value = 0.31;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    this.musicG.connect(this.master);
    this.musicG.connect(delay); delay.connect(fb).connect(delay); delay.connect(wet).connect(this.master);
    this.nextTick = ctx.currentTime; this.nextNote = ctx.currentTime + 0.3;
    this.t0 = ctx.currentTime;
    // 切回页面时恢复（iOS 可能处于 interrupted 状态）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
    });
  }
  get live() { return this.ctx && this.ctx.state === 'running'; }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05); }
  setMusic(on) { this.musicOn = on; if (this.musicG) this.musicG.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.2); }

  update(dt, { speed, pedaling, wheelOmega, night }) {
    const ctx = this.ctx; if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const sp = Math.min(speed / 10, 1);
    this.oceanG.gain.setTargetAtTime(0.16 + 0.1 * Math.sin(now * 0.45) * Math.sin(now * 0.17 + 1), now, 0.3);
    this.oceanF.frequency.setTargetAtTime(300 + 260 * (0.5 + 0.5 * Math.sin(now * 0.45)), now, 0.3);
    this.windG.gain.setTargetAtTime(0.02 + sp * sp * 0.22, now, 0.2);
    this.windF.frequency.setTargetAtTime(350 + sp * 900, now, 0.2);
    this.chainG.gain.setTargetAtTime(pedaling ? 0.018 * sp : 0, now, 0.1);
    // 滑行时的棘轮声：每圈 24 齿
    if (!pedaling && wheelOmega > 0.4) {
      const rate = Math.min((wheelOmega / (Math.PI * 2)) * 24, 180);
      if (this.nextTick < now) this.nextTick = now;
      while (this.nextTick < now + 0.12) {
        const s = ctx.createBufferSource(); s.buffer = this.clickBuf; s.playbackRate.value = 0.9 + Math.random() * 0.2;
        s.connect(this.clickBus); s.start(this.nextTick);
        this.nextTick += 1 / rate;
      }
    } else this.nextTick = now;
    // 音乐
    if (this.musicOn) this.scheduleMusic(now, night);
  }

  // ---------- 生成式小曲：五声音阶马林巴 ----------
  scheduleMusic(now, night) {
    const ctx = this.ctx;
    if (this.nextNote < now) this.nextNote = now + 0.05; // 切走/关掉后回来，不补播错过的音符
    const bpm = night > 0.5 ? 76 : 96;
    const eighth = 60 / bpm / 2;
    const scale = [0, 2, 4, 7, 9];
    const chords = [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]]; // I vi IV V
    const root = 60;
    while (this.nextNote < now + 0.25) {
      const t = this.nextNote;
      const chord = chords[this.bar % 4];
      const swing = this.step % 2 ? eighth * 0.12 : 0;
      if (this.step % 8 === 0) this.bass(t, root - 24 + chord[0], eighth * 7);
      if (this.step % 8 === 4) this.bass(t, root - 24 + chord[0] + 7, eighth * 3);
      // 旋律：偏向和弦音，偶尔休止
      if (Math.random() > (this.step % 2 ? 0.55 : 0.25)) {
        const useChord = Math.random() < 0.6;
        let n;
        if (useChord) n = root + chord[Math.floor(Math.random() * 3)] + (Math.random() < 0.3 ? 12 : 0);
        else n = root + scale[Math.floor(Math.random() * 5)] + 12 * Math.floor(Math.random() * 2);
        this.marimba(t + swing, n, 0.13 * (night > 0.5 ? 0.7 : 1));
      }
      this.nextNote += eighth;
      this.step++;
      if (this.step % 8 === 0) this.bar++;
    }
  }
  marimba(t, midi, vol) {
    const ctx = this.ctx, f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.9);
    g.connect(this.musicG);
    for (const [ratio, amp, dec] of [[1, 1, 0.9], [4, 0.25, 0.12], [10, 0.05, 0.05]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * ratio;
      const og = ctx.createGain(); og.gain.setValueAtTime(amp, t); og.gain.exponentialRampToValueAtTime(0.001, t + dec);
      o.connect(og).connect(g); o.start(t); o.stop(t + 1);
    }
  }
  bass(t, midi, dur) {
    const ctx = this.ctx, f = 440 * Math.pow(2, (midi - 69) / 12);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    o.connect(lp).connect(g).connect(this.musicG); o.start(t); o.stop(t + dur + 0.05);
  }

  // ---------- 一次性音效 ----------
  bell() {
    const ctx = this.ctx; if (!this.live) return;
    const now = ctx.currentTime;
    for (const [off, v] of [[0, 1], [0.17, 0.8]]) {
      const t = now + off;
      for (const [ratio, amp, dec] of [[1, 0.28, 1.6], [2.02, 0.12, 0.9], [2.76, 0.1, 0.6], [5.4, 0.05, 0.25]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 1900 * ratio;
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp * v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
        o.connect(g).connect(this.master); o.start(t); o.stop(t + dec + 0.05);
      }
    }
  }
  squawk() {
    const ctx = this.ctx; if (!this.live) return;
    const t = ctx.currentTime;
    for (const [off, f0] of [[0, 210], [0.28, 170]]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t + off); o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + off + 0.24);
      const vib = ctx.createOscillator(); vib.frequency.value = 32; const vg = ctx.createGain(); vg.gain.value = 18; vib.connect(vg).connect(o.frequency);
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 780; f1.Q.value = 4;
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1350; f2.Q.value = 5;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + off); g.gain.linearRampToValueAtTime(0.5, t + off + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + off + 0.26);
      o.connect(f1).connect(g); o.connect(f2).connect(g); g.connect(this.master);
      o.start(t + off); o.stop(t + off + 0.3); vib.start(t + off); vib.stop(t + off + 0.3);
    }
  }
  gull() {
    const ctx = this.ctx; if (!this.live) return;
    const t0 = ctx.currentTime;
    for (let k = 0; k < 3; k++) {
      const t = t0 + k * 0.22;
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.18);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.22);
    }
  }
  splash(vol = 1) {
    const ctx = this.ctx; if (!this.live) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(4000, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.12 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + 0.5);
  }
  shutter() {
    const ctx = this.ctx; if (!this.live) return;
    const t = ctx.currentTime;
    for (const off of [0, 0.07]) {
      const s = ctx.createBufferSource(); s.buffer = this.clickBuf;
      const g = ctx.createGain(); g.gain.value = 0.8; s.connect(g).connect(this.master); s.start(t + off);
    }
  }
}
