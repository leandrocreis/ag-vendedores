/* E Se? Studio — motor de cenas (Canvas 2D, determinístico).
 * Contrato (compatível com o "page contract" do Lemo-Opuscar: READY + render determinístico):
 *   window.__SCENE      dados da cena (injetados antes do carregamento)
 *   window.READY        true quando imagens e fontes estão carregadas
 *   window.renderFrame(n)  desenha o quadro n da cena: t = (frameStart + n) * den / num  (sem relógio real)
 *   window.CAPS         capacidades reais deste motor (exibidas na interface)
 * Técnicas de movimento inspiradas em bang-motion/references/techniques.md (MIT): câmera motivada,
 * tamanhos de plano, push-in, desfoque direcional em whip, hierarquia de transições.
 */
(function () {
  "use strict";
  const S = window.__SCENE;
  const cv = document.getElementById("c");
  cv.width = S.w; cv.height = S.h;
  const ctx = cv.getContext("2d");
  const W = S.w, H = S.h, V = H > W; // vertical (9:16)
  const U = Math.min(W, H) / 1080; // unidade de escala

  window.CAPS = {
    codigo: ["cenários procedurais em 3–5 planos de parallax", "personagens com rig articulado (andar, correr, agachar, olhar, lanterna, cair, estender o braço)", "câmera: push-in, pull-out, pan, tilt, tremor, travelling, tamanhos de plano", "luz: noite, fogueira, lanterna, alerta", "efeitos: chuva, neblina, brasas, olhos no escuro, folhas"],
    camadas: ["imagens em camadas com parallax e movimento de câmera", "respiração/balanço leve dos recortes de personagem", "SEM articulação de membros em imagens (apenas deslocamento, escala e luz)"],
  };

  /* ---------------- utilidades determinísticas ---------------- */
  function mulberry(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  const ss = (t) => t * t * (3 - 2 * t);
  const eio = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function hash(n) { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function vnoise(x) { const i = Math.floor(x), f = x - i; return lerp(hash(i), hash(i + 1), ss(f)); }

  /* ---------------- cor e família de estilo ---------------- */
  function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgb(c, a) { return a == null ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function sat(c) { const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0; }

  const PAL = (S.style.palette && S.style.palette.length ? S.style.palette : ["#14213d", "#1f3b57", "#e9c46a", "#f4a261", "#e76f51"]).map(hexToRgb);
  const byLum = [...PAL].sort((a, b) => lum(a) - lum(b));
  const accent = [...PAL].sort((a, b) => sat(b) - sat(a))[0];
  const FAM = S.style.family || "cel";
  const F = {
    cel: { outline: 4, ink: [17, 17, 24], shade: 0.22, alpha: 1, jitter: 0 },
    "vetor-plano": { outline: 0, ink: [20, 20, 30], shade: 0.12, alpha: 1, jitter: 0 },
    aquarela: { outline: 0, ink: [70, 50, 40], shade: 0.15, alpha: 0.78, jitter: 1.5, paper: [241, 233, 218] },
    nanquim: { outline: 2, ink: [25, 25, 25], shade: 0.3, alpha: 0.85, jitter: 1, gray: true, paper: [236, 230, 216] },
    giz: { outline: 3, ink: [235, 235, 225], shade: 0.1, alpha: 0.35, jitter: 2.5, board: [38, 52, 46] },
    "giz-cera": { outline: 3, ink: [60, 40, 30], shade: 0.1, alpha: 0.9, jitter: 3, paper: [250, 244, 230] },
    oleo: { outline: 0, ink: [30, 20, 15], shade: 0.3, alpha: 1, jitter: 2 },
    "papel-recortado": { outline: 0, ink: [0, 0, 0], shade: 0.0, alpha: 1, jitter: 0, cutShadow: true },
    gravura: { outline: 2.5, ink: [30, 24, 20], shade: 0.25, alpha: 1, jitter: 0.5, hatch: true },
    reticula: { outline: 2, ink: [30, 30, 40], shade: 0.2, alpha: 1, jitter: 0, halftone: true },
    "crt-neon": { outline: 2, ink: [80, 255, 200], shade: 0.1, alpha: 1, jitter: 0, scan: true, glow: true },
    pixel: { outline: 0, ink: [10, 10, 20], shade: 0.25, alpha: 1, jitter: 0, pixel: 6 },
    "cinema-mudo": { outline: 2, ink: [15, 15, 15], shade: 0.25, alpha: 1, jitter: 0, gray: true, sepia: true, grain: 0.18, vignette: 0.6, flicker: 0.06 },
    vhs: { outline: 0, ink: [20, 20, 20], shade: 0.15, alpha: 1, jitter: 0, vhs: true, grain: 0.12 },
    planta: { outline: 2, ink: [230, 240, 255], shade: 0, alpha: 0.18, jitter: 0, board: [22, 60, 120], lineOnly: true },
    isometrico: { outline: 0, ink: [30, 30, 40], shade: 0.2, alpha: 1, jitter: 0 },
    documental: { outline: 0, ink: [20, 20, 20], shade: 0.15, alpha: 1, jitter: 0, grain: 0.1 },
  }[FAM] || { outline: 3, ink: [17, 17, 24], shade: 0.2, alpha: 1, jitter: 0 };

  /* ---------------- imagens (modo camadas/híbrido) ---------------- */
  const IMG = {};
  const toLoad = [];
  for (const sh of S.shots) for (const l of sh.layers || []) if (l.src && !IMG[l.src]) { const im = new Image(); IMG[l.src] = im; toLoad.push(new Promise((res) => { im.onload = res; im.onerror = res; im.src = l.src; })); }

  /* ---------------- desenho com a "mão" da família ---------------- */
  let R = mulberry(1);
  function fillShape(path, color, opts = {}) {
    const a = (opts.alpha ?? 1) * F.alpha;
    if (F.cutShadow && !opts.noShadow) { ctx.save(); ctx.translate(6 * U, 8 * U); ctx.fillStyle = "rgba(0,0,0,.28)"; path(); ctx.fill(); ctx.restore(); }
    if (!F.lineOnly) {
      ctx.fillStyle = rgb(color, a); path(); ctx.fill();
      if (F.shade > 0 && !opts.flat) {
        // cel shading em faixa: sombra na metade inferior da forma
        ctx.save(); path(); ctx.clip();
        const g = ctx.createLinearGradient(0, opts.y0 ?? 0, 0, opts.y1 ?? H);
        g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.55, "rgba(0,0,0,0)"); g.addColorStop(0.551, `rgba(0,0,0,${F.shade * a})`); g.addColorStop(1, `rgba(0,0,0,${F.shade * a})`);
        ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3); ctx.restore();
      }
    }
    if (F.outline > 0 && !opts.noOutline) {
      ctx.lineWidth = F.outline * U * (opts.lineScale ?? 1); ctx.strokeStyle = rgb(F.ink, F.lineOnly ? 0.9 : 1); ctx.lineJoin = "round"; ctx.lineCap = "round";
      if (F.jitter) { for (let k = 0; k < 2; k++) { ctx.save(); ctx.translate((R() - 0.5) * F.jitter * U, (R() - 0.5) * F.jitter * U); path(); ctx.stroke(); ctx.restore(); } }
      else { path(); ctx.stroke(); }
    }
  }
  function limb(x1, y1, x2, y2, w, color) {
    ctx.lineCap = "round";
    if (F.outline > 0) { ctx.strokeStyle = rgb(F.ink); ctx.lineWidth = w + F.outline * 2 * U; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    if (!F.lineOnly) { ctx.strokeStyle = rgb(color, F.alpha); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  }

  /* ---------------- luz e paleta do ambiente ---------------- */
  function envColors(light) {
    const dark = byLum[0], mid = byLum[Math.min(1, byLum.length - 1)], hi = byLum[byLum.length - 1];
    const base = {
      noite: { sky0: mix(dark, [8, 12, 30], 0.6), sky1: mix(mid, [30, 40, 70], 0.5), ground: mix(dark, [12, 18, 16], 0.5), tree: mix(dark, [10, 22, 20], 0.55), amb: 0.45 },
      fogueira: { sky0: mix(dark, [10, 10, 25], 0.6), sky1: mix(mid, [40, 30, 50], 0.5), ground: mix(dark, [30, 20, 14], 0.5), tree: mix(dark, [14, 20, 18], 0.6), amb: 0.5 },
      lanterna: { sky0: [4, 6, 12], sky1: [12, 16, 26], ground: [12, 14, 14], tree: [8, 12, 12], amb: 0.25 },
      alerta: { sky0: mix(dark, [40, 5, 8], 0.5), sky1: mix(mid, [90, 20, 20], 0.4), ground: mix(dark, [25, 10, 10], 0.5), tree: mix(dark, [20, 8, 8], 0.6), amb: 0.5 },
      entardecer: { sky0: mix(accent, [240, 140, 80], 0.5), sky1: mix(hi, [255, 210, 150], 0.4), ground: mix(mid, [60, 50, 40], 0.5), tree: mix(dark, [40, 50, 40], 0.4), amb: 0.8 },
      dia: { sky0: mix(hi, [150, 200, 240], 0.5), sky1: mix(hi, [220, 235, 250], 0.5), ground: mix(mid, [90, 120, 70], 0.5), tree: mix(mid, [50, 90, 60], 0.5), amb: 1 },
    }[light] || null;
    const e = base || { sky0: dark, sky1: mid, ground: mid, tree: dark, amb: 0.7 };
    if (F.board) { e.sky0 = F.board; e.sky1 = mix(F.board, [255, 255, 255], 0.06); e.ground = mix(F.board, [0, 0, 0], 0.15); e.tree = mix(F.board, [255, 255, 255], 0.1); }
    if (F.paper) { e.sky0 = mix(e.sky0, F.paper, 0.35); e.sky1 = mix(e.sky1, F.paper, 0.45); }
    return e;
  }

  /* ---------------- cenário (planos de parallax) ---------------- */
  function sky(env, light, t) {
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.75);
    g.addColorStop(0, rgb(env.sky0)); g.addColorStop(1, rgb(env.sky1));
    ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3);
    if (light === "noite" || light === "fogueira" || light === "lanterna") {
      const r = mulberry(77);
      for (let i = 0; i < 140; i++) { const x = r() * W * 1.6 - W * 0.3, y = r() * H * 0.55; const tw = 0.5 + 0.5 * Math.sin(t * 2 + i); ctx.fillStyle = `rgba(255,255,240,${0.25 + 0.5 * tw * r()})`; ctx.fillRect(x, y, 2 * U, 2 * U); }
      ctx.fillStyle = rgb(mix([250, 245, 220], accent, 0.1), 0.95); ctx.beginPath(); ctx.arc(W * 0.78, H * 0.16, 42 * U, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(250,245,220,0.08)`; ctx.beginPath(); ctx.arc(W * 0.78, H * 0.16, 110 * U, 0, 7); ctx.fill();
    }
  }
  function mountains(env, depth, seed) {
    const r = mulberry(seed); const y0 = H * (0.5 + depth * 0.05);
    fillShape(() => { ctx.beginPath(); ctx.moveTo(-W, H); let x = -W; ctx.lineTo(x, y0); while (x < W * 2) { x += (80 + r() * 160) * U; ctx.lineTo(x, y0 - r() * 140 * U * (1.2 - depth)); } ctx.lineTo(W * 2, H); ctx.closePath(); }, mix(env.sky1, env.tree, 0.35 + depth * 0.4), { noOutline: depth < 0.3, flat: true });
  }
  function pine(x, y, h, color) {
    fillShape(() => { ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x - h * 0.28, y - h * 0.35); ctx.lineTo(x - h * 0.12, y - h * 0.38); ctx.lineTo(x - h * 0.36, y); ctx.lineTo(x + h * 0.36, y); ctx.lineTo(x + h * 0.12, y - h * 0.38); ctx.lineTo(x + h * 0.28, y - h * 0.35); ctx.closePath(); }, color, { y0: y - h, y1: y });
  }
  function treeRow(env, depth, seed, yBase, count) {
    const r = mulberry(seed);
    for (let i = 0; i < count; i++) { const x = -W * 0.5 + (i / count) * W * 2 + r() * 60 * U; const h = (160 + r() * 200) * U * (0.5 + depth); pine(x, yBase, h, mix(env.tree, env.sky1, 0.5 - depth * 0.45)); }
  }
  function ground(env, y) { fillShape(() => { ctx.beginPath(); ctx.rect(-W, y, W * 3, H * 2); }, env.ground, { noOutline: true, flat: true }); }

  function tent(x, y, s, color) {
    fillShape(() => { ctx.beginPath(); ctx.moveTo(x - 160 * s, y); ctx.lineTo(x, y - 150 * s); ctx.lineTo(x + 160 * s, y); ctx.closePath(); }, color, { y0: y - 150 * s, y1: y });
    fillShape(() => { ctx.beginPath(); ctx.moveTo(x - 30 * s, y); ctx.lineTo(x, y - 110 * s); ctx.lineTo(x + 30 * s, y); ctx.closePath(); }, mix(color, [0, 0, 0], 0.5), { flat: true });
  }
  function campfire(x, y, s, t) {
    for (let i = -1; i <= 1; i++) limb(x - 50 * s, y + i * 4 * s, x + 50 * s, y - i * 6 * s, 14 * s, [90, 60, 40]);
    for (let k = 0; k < 3; k++) {
      const f = 0.8 + 0.2 * vnoise(t * 6 + k * 3); const hh = (90 - k * 22) * s * f;
      fillShape(() => { ctx.beginPath(); ctx.moveTo(x - (40 - k * 10) * s, y); ctx.quadraticCurveTo(x - 20 * s, y - hh * 0.6, x + (vnoise(t * 3 + k) - 0.5) * 20 * s, y - hh); ctx.quadraticCurveTo(x + 20 * s, y - hh * 0.6, x + (40 - k * 10) * s, y); ctx.closePath(); }, [[240, 120, 40], [250, 180, 60], [255, 240, 160]][k], { noOutline: k > 0, flat: true });
    }
  }
  function car(x, y, s, color, lightsOn) {
    fillShape(() => { ctx.beginPath(); ctx.roundRect(x - 200 * s, y - 90 * s, 400 * s, 70 * s, 18 * s); }, color, { y0: y - 90 * s, y1: y });
    fillShape(() => { ctx.beginPath(); ctx.moveTo(x - 120 * s, y - 90 * s); ctx.lineTo(x - 80 * s, y - 150 * s); ctx.lineTo(x + 90 * s, y - 150 * s); ctx.lineTo(x + 130 * s, y - 90 * s); ctx.closePath(); }, mix(color, [180, 210, 230], 0.4), {});
    for (const wx of [-120, 120]) fillShape(() => { ctx.beginPath(); ctx.arc(x + wx * s, y - 20 * s, 32 * s, 0, 7); }, [20, 20, 22], {});
    if (lightsOn) { const g = ctx.createRadialGradient(x + 200 * s, y - 60 * s, 5, x + 200 * s, y - 60 * s, 420 * s); g.addColorStop(0, "rgba(255,250,210,.55)"); g.addColorStop(1, "rgba(255,250,210,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x + 200 * s, y - 60 * s); ctx.lineTo(x + 700 * s, y - 180 * s); ctx.lineTo(x + 700 * s, y + 40 * s); ctx.closePath(); ctx.fill(); }
  }
  function cabinInterior(env) {
    fillShape(() => { ctx.beginPath(); ctx.rect(-W, -H, W * 3, H * 3); }, mix([70, 50, 38], byLum[0], 0.4), { noOutline: true, flat: true });
    for (let i = -6; i < 16; i++) limb(i * 140 * U, -H, i * 140 * U, H * 2, 3 * U, mix([50, 34, 26], byLum[0], 0.4));
    fillShape(() => { ctx.beginPath(); ctx.rect(W * 0.58, H * 0.2, W * 0.22, H * 0.28); }, mix(env.sky0, [20, 30, 60], 0.3), {});
    limb(W * 0.69, H * 0.2, W * 0.69, H * 0.48, 8 * U, [60, 40, 30]); limb(W * 0.58, H * 0.34, W * 0.8, H * 0.34, 8 * U, [60, 40, 30]);
    fillShape(() => { ctx.beginPath(); ctx.rect(W * 0.12, H * 0.25, W * 0.16, H * 0.55); }, [80, 56, 40], {});
    fillShape(() => { ctx.beginPath(); ctx.rect(-W, H * 0.8, W * 3, H); }, [48, 34, 26], { noOutline: true, flat: true });
  }
  function road(env, y) {
    fillShape(() => { ctx.beginPath(); ctx.rect(-W, y, W * 3, H * 0.2); }, mix([50, 50, 55], env.ground, 0.4), { flat: true, noOutline: true });
    for (let i = -10; i < 30; i++) { ctx.fillStyle = "rgba(240,230,160,.7)"; ctx.fillRect(i * 160 * U, y + H * 0.09, 80 * U, 8 * U); }
  }
  function skyline(env, y) {
    const r = mulberry(9);
    let x = -W;
    while (x < W * 2) { const w = (80 + r() * 140) * U, h = (120 + r() * 420) * U; fillShape(() => { ctx.beginPath(); ctx.rect(x, y - h, w, h); }, mix(env.tree, env.sky1, 0.3), { y0: y - h, y1: y }); for (let k = 0; k < 8; k++) if (r() > 0.55) { ctx.fillStyle = "rgba(255,220,140,.6)"; ctx.fillRect(x + r() * w * 0.8, y - r() * h * 0.9, 10 * U, 14 * U); } x += w + 10 * U; }
  }
  function lake(env, y) {
    const g = ctx.createLinearGradient(0, y, 0, y + H * 0.3); g.addColorStop(0, rgb(mix(env.sky1, [40, 60, 90], 0.4))); g.addColorStop(1, rgb(mix(env.sky0, [10, 20, 40], 0.5)));
    ctx.fillStyle = g; ctx.fillRect(-W, y, W * 3, H * 0.3);
  }

  /* ---------------- personagens articulados ---------------- */
  function figure(a, t, s) {
    // a: {x (0..1 do quadro), y, kind, action, facing, colors[]}
    const zombie = a.kind === "zumbi";
    const skin = zombie ? [126, 150, 112] : hexToRgb(a.colors?.[2] || "#e0b896");
    const shirt = a.colors?.[0] ? hexToRgb(a.colors[0]) : zombie ? [75, 75, 62] : accent;
    const pants = hexToRgb(a.colors?.[1] || (zombie ? "#34342c" : "#2f3d52"));
    const dir = a.facing === "esq" ? -1 : 1;
    const sp = { idle: 0, walk: 1.6, run: 3.2, crouch: 0, look: 0, flashlight: 0.9, fall: 0, reach: 0, lurch: 1.1 }[a.action] ?? 0;
    const ph = t * (zombie ? 3 : 5) * (sp > 2 ? 1.7 : 1) + a.seed;
    const swing = sp ? Math.sin(ph) * (sp > 2 ? 0.95 : 0.55) : Math.sin(t * 1.3 + a.seed) * 0.04;
    const crouch = a.action === "crouch" ? 0.35 : 0;
    const fall = a.action === "fall" ? ss(seg(a.p, 0.1, 0.6)) : 0;
    const hunch = zombie ? 0.35 : sp > 2 ? 0.25 : 0;
    const x = a.px, y = a.py;
    const L = 120 * s; // perna
    const T = 135 * s; // tronco
    const breath = Math.sin(t * 2.1 + a.seed) * 2 * s;
    ctx.save(); ctx.translate(x, y); ctx.rotate(fall * dir * 1.35); ctx.scale(dir, 1);
    const hipY = -L * (1 - crouch * 0.6) + Math.abs(Math.sin(ph)) * (sp ? 6 * s : 0);
    const shX = Math.sin(hunch) * T, shY = hipY - Math.cos(hunch) * T + breath;
    // pernas
    for (const sgn of [-1, 1]) {
      const ang = swing * sgn;
      const kx = Math.sin(ang) * L * 0.5 + crouch * 30 * s, ky = hipY + Math.cos(ang) * L * 0.5;
      const fx = kx + Math.sin(ang - (sp ? Math.max(0, -Math.sin(ph * sgn)) * 0.8 : 0) - crouch) * L * 0.5, fy = Math.min(0, ky + L * 0.5);
      limb(0, hipY, kx, ky, 26 * s, sgn < 0 ? mix(pants, [0, 0, 0], 0.25) : pants);
      limb(kx, ky, fx, fy, 22 * s, sgn < 0 ? mix(pants, [0, 0, 0], 0.25) : pants);
    }
    // tronco
    limb(0, hipY, shX, shY, 46 * s, shirt);
    // braços (ângulo a partir da vertical para baixo; positivo = para a frente)
    for (const sgn of [-1, 1]) {
      let ua, la;
      if (zombie || a.action === "reach") { ua = 1.45 + sgn * 0.06 + Math.sin(t * 2 + sgn) * 0.05; la = -0.1; }
      else if (a.action === "flashlight" && sgn > 0) { ua = 1.3; la = 0.05; }
      else { ua = swing * sgn * 0.9; la = sp > 2 ? 1.3 : 0.35; }
      const e1x = shX + Math.sin(ua) * 62 * s, e1y = shY + Math.cos(ua) * 62 * s;
      const h1x = e1x + Math.sin(ua + la) * 58 * s, h1y = e1y + Math.cos(ua + la) * 58 * s;
      limb(shX, shY, e1x, e1y, 18 * s, sgn < 0 ? mix(shirt, [0, 0, 0], 0.25) : shirt);
      limb(e1x, e1y, h1x, h1y, 15 * s, skin);
      if (a.action === "flashlight" && sgn > 0) {
        ctx.save(); ctx.globalCompositeOperation = "lighter";
        const g = ctx.createRadialGradient(h1x, h1y, 4, h1x, h1y, 900 * s); g.addColorStop(0, "rgba(255,250,215,.55)"); g.addColorStop(1, "rgba(255,250,215,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(h1x, h1y); ctx.lineTo(h1x + 1100 * s, h1y - 380 * s); ctx.lineTo(h1x + 1100 * s, h1y + 300 * s); ctx.closePath(); ctx.fill(); ctx.restore();
      }
    }
    // cabeça
    const look = a.action === "look" ? Math.sin(t * 1.2 + a.seed) * 0.6 : 0;
    const hx = shX + 10 * s * (zombie ? 1.6 : 0.4), hy = shY - 52 * s;
    fillShape(() => { ctx.beginPath(); ctx.arc(hx, hy, 42 * s, 0, 7); }, skin, { y0: hy - 42 * s, y1: hy + 42 * s });
    if (!zombie && a.colors?.[3]) fillShape(() => { ctx.beginPath(); ctx.arc(hx, hy - 8 * s, 44 * s, Math.PI * 1.05, Math.PI * 1.95); ctx.closePath(); }, hexToRgb(a.colors[3]), { flat: true });
    // olhos: medo = olhos maiores
    const fear = /medo|pânico|susto/.test(a.emotion || "") || sp > 2;
    const ey = hy - 4 * s, ex2 = hx + 14 * s + look * 8 * s;
    ctx.fillStyle = zombie ? "rgba(230,240,170,1)" : "#fff";
    ctx.beginPath(); ctx.ellipse(ex2, ey, (fear ? 9 : 7) * s, (fear ? 11 : 7) * s, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(ex2 + 18 * s, ey, (fear ? 8 : 6) * s, (fear ? 10 : 6) * s, 0, 0, 7); ctx.fill();
    if (!zombie) { ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(ex2 + 2 * s, ey + 1 * s, 3.5 * s, 0, 7); ctx.arc(ex2 + 20 * s, ey + 1 * s, 3.5 * s, 0, 7); ctx.fill(); }
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 3 * s; ctx.beginPath();
    if (fear) { ctx.ellipse(hx + 22 * s, hy + 20 * s, 6 * s, 8 * s, 0, 0, 7); } else { ctx.moveTo(hx + 12 * s, hy + 20 * s); ctx.lineTo(hx + 30 * s, hy + 18 * s); }
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- efeitos ---------------- */
  function fx(name, t, env) {
    const r = mulberry(name.length * 31);
    if (name === "chuva") { ctx.strokeStyle = "rgba(200,210,230,.35)"; ctx.lineWidth = 2 * U; ctx.beginPath(); for (let i = 0; i < 260; i++) { const x = ((r() * W * 1.2 + t * 220 * U) % (W * 1.2)) - W * 0.1, y = ((r() * H + t * 1600 * U * (0.8 + r() * 0.4)) % (H * 1.1)) - H * 0.05; ctx.moveTo(x, y); ctx.lineTo(x - 8 * U, y + 30 * U); } ctx.stroke(); }
    if (name === "neblina") { for (let i = 0; i < 5; i++) { const y = H * (0.55 + i * 0.08), x = ((t * 18 * (i + 1)) % W) - W * 0.5; const g = ctx.createLinearGradient(0, y - 90 * U, 0, y + 90 * U); g.addColorStop(0, "rgba(200,210,220,0)"); g.addColorStop(0.5, `rgba(200,210,220,${0.08 + 0.03 * i})`); g.addColorStop(1, "rgba(200,210,220,0)"); ctx.fillStyle = g; ctx.fillRect(x - W, y - 90 * U, W * 3, 180 * U); } }
    if (name === "brasas") { for (let i = 0; i < 40; i++) { const life = (t * 0.6 + r()) % 1; const x = W * (0.45 + (r() - 0.5) * 0.15) + Math.sin(t * 2 + i) * 20 * U, y = H * 0.78 - life * H * 0.5; ctx.fillStyle = `rgba(255,${150 + r() * 80},60,${(1 - life) * 0.9})`; ctx.fillRect(x, y, 4 * U, 4 * U); } }
    if (name === "olhos") { for (let i = 0; i < 6; i++) { const blink = vnoise(t * 0.8 + i * 7) > 0.25 ? 1 : 0; if (!blink) continue; const x = W * (0.1 + r() * 0.8), y = H * (0.5 + r() * 0.18); ctx.fillStyle = "rgba(220,255,160,.85)"; ctx.beginPath(); ctx.arc(x, y, 4 * U, 0, 7); ctx.arc(x + 16 * U, y, 4 * U, 0, 7); ctx.fill(); } }
    if (name === "folhas") { for (let i = 0; i < 30; i++) { const x = ((r() * W + t * 60 * U) % W), y = ((r() * H + t * 90 * U) % H); ctx.fillStyle = rgb(mix(env.tree, accent, 0.4), 0.7); ctx.beginPath(); ctx.ellipse(x, y, 8 * U, 4 * U, t + i, 0, 7); ctx.fill(); } }
  }

  /* ---------------- câmera ---------------- */
  const SHOT_ZOOM = { geral: 1, medio: 1.35, close: 1.85, detalhe: 2.5 };
  function camera(sh, p, t) {
    const z0 = SHOT_ZOOM[sh.camera.shot] || 1, k = sh.camera.intensity ?? 0.5;
    let z = z0, dx = 0, dy = 0, rot = 0;
    const e = eio(p);
    switch (sh.camera.move) {
      case "push-in": z = z0 * (1 + 0.18 * k * e); break;
      case "pull-out": z = z0 * (1 + 0.18 * k * (1 - e)); break;
      case "pan-esq": dx = (0.5 - e) * 220 * k * U; break;
      case "pan-dir": dx = (e - 0.5) * 220 * k * U; break;
      case "tilt-cima": dy = (e - 0.5) * 160 * k * U; break;
      case "tilt-baixo": dy = (0.5 - e) * 160 * k * U; break;
      case "travelling": dx = (e - 0.5) * 520 * k * U; break;
      case "tremor": dx = (vnoise(t * 9) - 0.5) * 22 * k * U; dy = (vnoise(t * 9 + 50) - 0.5) * 22 * k * U; rot = (vnoise(t * 5 + 9) - 0.5) * 0.012 * k; break;
    }
    // foco motivado: o primeiro ator
    const fa = sh.actors[0];
    const fx_ = fa ? fa.x * W : W / 2, fy_ = H * 0.62;
    return { z, dx, dy, rot, fx: lerp(W / 2, fx_, z > 1 ? 0.6 : 0), fy: lerp(H / 2, fy_, z > 1 ? 0.5 : 0) };
  }

  /* ---------------- composição de um plano ---------------- */
  function drawShot(sh, t, si) {
    R = mulberry(si * 1013 + 7);
    const p = seg(t, sh.t0, sh.t1);
    const env = envColors(sh.light);
    const cam = camera(sh, p, t);
    const layer = (depth, fn) => { ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(cam.rot); const zz = 1 + (cam.z - 1) * depth; ctx.scale(zz, zz); ctx.translate(-cam.fx - cam.dx * depth, -cam.fy - cam.dy * depth); fn(); ctx.restore(); };
    const horizon = H * (V ? 0.66 : 0.72);
    const hasImages = (sh.layers || []).some((l) => IMG[l.src] && IMG[l.src].naturalWidth);
    if (hasImages) {
      // modo camadas: cada imagem é um plano com parallax; sem articulação
      ctx.fillStyle = rgb(env.sky0); ctx.fillRect(0, 0, W, H);
      for (const l of [...sh.layers].sort((a, b) => a.depth - b.depth)) {
        const im = IMG[l.src]; if (!im || !im.naturalWidth) continue;
        layer(l.depth, () => {
          const scale = Math.max(W / im.naturalWidth, H / im.naturalHeight) * (l.role === "personagem" ? 0.55 : 1.12);
          const iw = im.naturalWidth * scale, ih = im.naturalHeight * scale;
          const bob = l.role === "personagem" ? Math.sin(t * 2 + l.depth * 5) * 4 * U : 0;
          const x = l.role === "personagem" ? (l.x ?? 0.5) * W - iw / 2 : (W - iw) / 2, y = l.role === "personagem" ? horizon - ih + bob + 40 * U : (H - ih) / 2;
          ctx.drawImage(im, x, y, iw, ih);
        });
      }
    } else {
      layer(0.05, () => sky(env, sh.light, t));
      const sp = sh.setPiece;
      if (sp === "cabana-interior") layer(0.7, () => cabinInterior(env));
      else if (sp === "cidade") { layer(0.2, () => skyline(env, horizon)); layer(1, () => ground(env, horizon)); }
      else {
        layer(0.15, () => mountains(env, 0.1, 11));
        layer(0.3, () => mountains(env, 0.4, 23));
        if (sp === "lago") layer(0.6, () => lake(env, horizon - 20 * U));
        layer(0.45, () => treeRow(env, 0.2, 5, horizon - 10 * U, 26));
        layer(1, () => ground(env, horizon));
        if (sp === "estrada") layer(1, () => road(env, horizon + 20 * U));
        if (sp !== "estrada" && sp !== "lago") layer(0.8, () => treeRow(env, 0.7, 13, horizon + 10 * U, 12));
      }
      // objetos
      layer(1, () => {
        const s = U * (V ? 1.1 : 1);
        if (sh.props.includes("barraca")) tent(W * 0.3, horizon + 40 * U, s * 1.1, mix(accent, [200, 120, 60], 0.3));
        if (sh.props.includes("carro")) car(W * 0.62, horizon + 70 * U, s, mix(byLum[1] || accent, [120, 30, 30], 0.4), sh.light === "noite" || sh.light === "lanterna");
        if (sh.props.includes("fogueira")) campfire(W * 0.5, horizon + 60 * U, s, t);
        if (sh.props.includes("mochila")) fillShape(() => { ctx.beginPath(); ctx.roundRect(W * 0.4, horizon + 10 * U, 70 * U, 90 * U, 14 * U); }, mix(accent, [60, 80, 40], 0.5), {});
        if (sh.props.includes("radio")) fillShape(() => { ctx.beginPath(); ctx.roundRect(W * 0.56, horizon + 30 * U, 90 * U, 55 * U, 8 * U); }, [60, 60, 64], {});
        const actors = [...sh.actors].sort((a, b) => (a.kind === "zumbi") - (b.kind === "zumbi"));
        actors.forEach((a, i) => {
          const move = { walk: 0.06, run: 0.16, lurch: 0.04, flashlight: 0.03 }[a.action] || 0;
          const px = (a.x + (a.facing === "esq" ? -1 : 1) * move * p) * W;
          figure({ ...a, px, py: horizon + (70 + (i % 2) * 18) * U, p, seed: i * 1.7 + si }, t, s * (V ? 1.25 : 1.05) * (a.kind === "zumbi" ? 1.04 : 1));
        });
      });
    }
    // luz ambiente
    if (sh.light === "fogueira") { const f = 0.85 + 0.15 * vnoise(t * 8); const g = ctx.createRadialGradient(W * 0.5, horizon + 40 * U, 10, W * 0.5, horizon, W * 0.65); g.addColorStop(0, `rgba(255,170,80,${0.35 * f})`); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (sh.light === "lanterna" || sh.light === "noite") { const g = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.2, W / 2, H * 0.5, W * 0.75); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,10,${sh.light === "lanterna" ? 0.75 : 0.45})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    if (sh.light === "alerta") { ctx.fillStyle = `rgba(200,20,20,${0.12 + 0.1 * Math.max(0, Math.sin(t * 6))})`; ctx.fillRect(0, 0, W, H); }
    for (const f of sh.fx) fx(f, t, env);
    // legenda de tela (texto como camada editável)
    if (sh.caption) {
      const a = ss(seg(t, sh.t0 + 0.2, sh.t0 + 0.6)) * (1 - ss(seg(t, sh.t1 - 0.4, sh.t1)));
      ctx.save(); ctx.globalAlpha = a; ctx.font = `700 ${Math.round(64 * U)}px ${FONT_TITLE}`; ctx.textAlign = "center";
      ctx.lineWidth = 10 * U; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.strokeText(sh.caption, W / 2, H * (V ? 0.22 : 0.16));
      ctx.fillStyle = rgb(mix(accent, [255, 255, 255], 0.5)); ctx.fillText(sh.caption, W / 2, H * (V ? 0.22 : 0.16)); ctx.restore();
    }
  }

  const FONT_TITLE = { aquarela: "Georgia, serif", nanquim: "Georgia, serif", "cinema-mudo": "Georgia, serif", gravura: "Georgia, serif", "crt-neon": "monospace", pixel: "monospace", planta: "monospace" }[FAM] || "Arial Black, Arial, sans-serif";
  const FONT_SUB = { aquarela: "italic 600 {s}px Georgia, serif", "cinema-mudo": "600 {s}px Georgia, serif", "crt-neon": "600 {s}px monospace", pixel: "700 {s}px monospace" }[FAM] || "700 {s}px Arial, sans-serif";

  /* ---------------- pós-processamento da família ---------------- */
  let paperTex = null, halftone = null;
  function post(t, n) {
    if (F.gray || F.sepia) { const id = ctx.getImageData(0, 0, W, H); const d = id.data; for (let i = 0; i < d.length; i += 4) { const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; if (F.sepia) { d[i] = Math.min(255, g * 1.07 + 18); d[i + 1] = Math.min(255, g * 0.95 + 8); d[i + 2] = g * 0.78; } else { d[i] = d[i + 1] = d[i + 2] = g; } } ctx.putImageData(id, 0, 0); }
    if (F.paper) { if (!paperTex) { paperTex = document.createElement("canvas"); paperTex.width = 512; paperTex.height = 512; const p = paperTex.getContext("2d"); const r = mulberry(5); for (let i = 0; i < 9000; i++) { p.fillStyle = `rgba(${r() > 0.5 ? 255 : 120},${r() > 0.5 ? 240 : 100},${r() > 0.5 ? 220 : 80},${r() * 0.06})`; p.fillRect(r() * 512, r() * 512, 1 + r() * 3, 1); } } ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = ctx.createPattern(paperTex, "repeat"); ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (F.halftone) { if (!halftone) { halftone = document.createElement("canvas"); halftone.width = halftone.height = 12; const h = halftone.getContext("2d"); h.fillStyle = "rgba(0,0,0,.22)"; h.beginPath(); h.arc(6, 6, 3, 0, 7); h.fill(); } ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = ctx.createPattern(halftone, "repeat"); ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (F.hatch) { ctx.save(); ctx.globalAlpha = 0.08; ctx.strokeStyle = rgb(F.ink); ctx.lineWidth = 1.2 * U; ctx.beginPath(); for (let x = -H; x < W; x += 9 * U) { ctx.moveTo(x, H); ctx.lineTo(x + H, 0); } ctx.stroke(); ctx.restore(); }
    if (F.scan) { ctx.save(); ctx.fillStyle = "rgba(0,0,0,.25)"; for (let y = 0; y < H; y += 4 * U) ctx.fillRect(0, y, W, 1.5 * U); ctx.restore(); }
    if (F.vhs) { const r = mulberry(n * 7 + 3); ctx.save(); for (let i = 0; i < 3; i++) { ctx.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.05})`; ctx.fillRect(0, r() * H, W, (2 + r() * 6) * U); } ctx.restore(); }
    if (F.grain) { const r = mulberry(n * 13 + 1); ctx.save(); for (let i = 0; i < 2600; i++) { ctx.fillStyle = r() > 0.5 ? `rgba(255,255,255,${F.grain * r()})` : `rgba(0,0,0,${F.grain * r()})`; ctx.fillRect(r() * W, r() * H, 2 * U, 2 * U); } ctx.restore(); }
    if (F.vignette) { const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${F.vignette})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    if (F.flicker) { ctx.fillStyle = `rgba(255,255,255,${F.flicker * vnoise(t * 14)})`; ctx.fillRect(0, 0, W, H); }
  }

  function subtitles(t) {
    if (!S.burnSubtitles) return;
    const cue = (S.subtitles || []).find((c) => t >= c.t0 && t < c.t1); if (!cue) return;
    const size = Math.round((V ? 54 : 44) * U);
    ctx.save(); ctx.font = FONT_SUB.replace("{s}", size); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const lines = cue.text.split("\n"); const safe = V ? (S.safeArea?.bottom ?? 0.22) : 0.08;
    lines.forEach((ln, i) => { const y = H * (1 - safe) - (lines.length - 1 - i) * size * 1.25; ctx.lineWidth = 8 * U; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.lineJoin = "round"; ctx.strokeText(ln, W / 2, y); ctx.fillStyle = "#fff"; ctx.fillText(ln, W / 2, y); });
    ctx.restore();
  }

  /* ---------------- quadro ---------------- */
  let pix = null;
  window.renderFrame = function (n) {
    const t = ((S.frameStart + n) * S.fps.den) / S.fps.num; // tempo absoluto no master
    let si = S.shots.findIndex((s) => t >= s.t0 && t < s.t1); if (si < 0) si = t < S.shots[0].t0 ? 0 : S.shots.length - 1;
    const sh = S.shots[si];
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const tr = sh.transitionIn, dt = t - sh.t0;
    if (tr === "whip" && dt < 0.25 && si > 0) {
      // desfoque direcional: amostras do plano anterior e do atual deslocadas
      const k = dt / 0.25;
      for (let j = 0; j < 5; j++) { ctx.save(); ctx.globalAlpha = 0.22; ctx.translate((1 - k) * W * 0.35 * (j / 4 - 0.5) * 2, 0); drawShot(k < 0.5 ? S.shots[si - 1] : sh, k < 0.5 ? S.shots[si - 1].t1 - 0.001 : t, k < 0.5 ? si - 1 : si); ctx.restore(); }
    } else if (tr === "fusao" && dt < 0.5 && si > 0) {
      drawShot(S.shots[si - 1], S.shots[si - 1].t1 - 0.001 + dt, si - 1);
      ctx.save(); ctx.globalAlpha = ss(dt / 0.5); drawShot(sh, t, si); ctx.restore();
    } else drawShot(sh, t, si);
    if (tr === "escuro" && dt < 0.6) { ctx.fillStyle = `rgba(0,0,0,${1 - ss(dt / 0.6)})`; ctx.fillRect(0, 0, W, H); }
    if (sh.fadeOut && sh.t1 - t < 0.6) { ctx.fillStyle = `rgba(0,0,0,${ss(1 - (sh.t1 - t) / 0.6)})`; ctx.fillRect(0, 0, W, H); }
    if (F.pixel) { if (!pix) { pix = document.createElement("canvas"); pix.width = Math.round(W / F.pixel); pix.height = Math.round(H / F.pixel); } const p = pix.getContext("2d"); p.imageSmoothingEnabled = false; p.drawImage(cv, 0, 0, pix.width, pix.height); ctx.imageSmoothingEnabled = false; ctx.drawImage(pix, 0, 0, W, H); }
    post(t, S.frameStart + n);
    subtitles(t);
    return { t, shot: si };
  };

  Promise.all(toLoad).then(() => (document.fonts ? document.fonts.ready : null)).then(() => { window.READY = true; });
})();
