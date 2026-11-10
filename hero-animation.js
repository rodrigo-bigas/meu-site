/* =========================================================================
   HERO ANIMATION — Rede neural em Canvas 2D (Vanilla JS, sem dependências)
   -------------------------------------------------------------------------
   Camadas desenhadas a cada quadro (de trás para frente):
     1. Grid em perspectiva (piso digital que avança lentamente)
     2. Conexões entre partículas próximas (agrupadas por opacidade)
     3. Partículas em 3 profundidades (tamanho, brilho e parallax por "z")
     4. Sinais: impulsos de luz que percorrem a rede, saltando de nó em nó
   Otimizações: hash espacial O(n), sprites de brilho pré-renderizados,
   pausa fora da tela / aba oculta, DPR limitado, contagem por área,
   respeito a prefers-reduced-motion e ao tema claro/escuro do site.
   ========================================================================= */
(() => {
    'use strict';

    const hero = document.querySelector('.hero');
    const canvas = document.getElementById('hero-canvas');
    if (!hero || !canvas || !canvas.getContext) return;

    const ctx = canvas.getContext('2d');
    const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mqCoarse = window.matchMedia('(hover: none), (pointer: coarse)');

    /* ---------- Paletas (acompanham data-theme do <body>) ---------- */
    const PALETTES = {
        dark: {
            core: [150, 235, 255],      // núcleo dos pontos
            cyan: [0, 210, 255],        // destaque (accent do site)
            blue: [77, 163, 255],       // primary do tema escuro
            line: [90, 175, 255],
            lineAlpha: 0.42,
            nodeAlpha: 0.95,
            gridAlpha: 0.15,
            blend: 'lighter'            // soma de luz sobre fundo escuro
        },
        light: {
            core: [0, 70, 150],
            cyan: [0, 150, 200],
            blue: [0, 86, 179],
            line: [0, 86, 179],
            lineAlpha: 0.3,
            nodeAlpha: 0.85,
            gridAlpha: 0.11,
            blend: 'source-over'        // 'lighter' some em fundo claro
        }
    };

    /* ---------- Estado ---------- */
    let W = 0, H = 0, dpr = 1;
    let palette = PALETTES.dark;
    let sprites = {};
    let particles = [];
    let signals = [];
    let pairs = [];                 // pares conectados no último quadro (a, b)
    let pairCount = 0;
    let linkDist = 120;
    let rafId = 0;
    let running = false;
    let heroVisible = true;
    let lastTime = 0;
    let time = 0;
    let gridOffset = 0;
    let nextSignalAt = 0;
    let reduced = mqReduce.matches;
    let coarse = mqCoarse.matches;

    const pointer = { cx: 0, cy: 0, x: 0, y: 0, active: false, has: false };
    const parallax = { x: 0, y: 0 };

    const BUCKETS = 10;                              // faixas de opacidade das linhas
    const bucketPaths = new Array(BUCKETS);

    /* ---------- Utilitários ---------- */
    const rand = (a, b) => a + Math.random() * (b - a);
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    function currentTheme() {
        return document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    /* Sprite de brilho radial pré-renderizado: drawImage é muito mais barato
       que shadowBlur ou criar gradientes a cada quadro. */
    function makeGlow(color, size) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const r = size / 2;
        const grad = g.createRadialGradient(r, r, 0, r, r, r);
        grad.addColorStop(0, rgba(color, 0.9));
        grad.addColorStop(0.18, rgba(color, 0.45));
        grad.addColorStop(0.45, rgba(color, 0.12));
        grad.addColorStop(1, rgba(color, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        return c;
    }

    function buildSprites() {
        sprites = {
            cyan: makeGlow(palette.cyan, 64),
            blue: makeGlow(palette.blue, 64),
            core: makeGlow(palette.core, 32)
        };
    }

    /* ---------- Partículas ---------- */
    function targetCount() {
        const area = W * H;
        let n = area / 7500;
        if (coarse || W < 768) n *= 0.45;
        if ((navigator.hardwareConcurrency || 8) <= 4) n *= 0.75;
        return Math.round(clamp(n, 28, coarse ? 70 : 190));
    }

    function createParticle(x, y) {
        // Três camadas de profundidade: fundo, meio e frente
        const layer = Math.random();
        const z = layer < 0.45 ? rand(0.25, 0.45) : layer < 0.85 ? rand(0.5, 0.72) : rand(0.8, 1);
        return {
            x: x !== undefined ? x : Math.random() * W,
            y: y !== undefined ? y : Math.random() * H,
            z,
            vx: rand(-0.15, 0.15),
            vy: rand(-0.15, 0.15),
            seed: Math.random() * 1000,
            phase: Math.random() * Math.PI * 2,
            twinkle: rand(0.0006, 0.0016),
            hub: Math.random() < 0.11,                // nós de destaque com brilho
            tint: Math.random() < 0.5 ? 'cyan' : 'blue',
            sx: 0, sy: 0, a: 0
        };
    }

    function syncParticles(scaleX, scaleY) {
        if (scaleX !== 1 || scaleY !== 1) {
            for (const p of particles) { p.x *= scaleX; p.y *= scaleY; }
        }
        const n = targetCount();
        while (particles.length < n) particles.push(createParticle());
        if (particles.length > n) particles.length = n;
        signals = [];
    }

    /* ---------- Tamanho do canvas ---------- */
    function resize() {
        const rect = hero.getBoundingClientRect();
        const newW = Math.max(1, Math.round(rect.width));
        const newH = Math.max(1, Math.round(rect.height));
        const sx = W ? newW / W : 1;
        const sy = H ? newH / H : 1;

        W = newW; H = newH;
        dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        linkDist = clamp(Math.min(W, H) * 0.19, 90, 150);
        syncParticles(sx, sy);
    }

    /* ---------- Grid em perspectiva ---------- */
    function drawGrid() {
        const horizon = H * 0.6;
        const depth = H - horizon;
        if (depth <= 0) return;

        const vpX = W * 0.5 - parallax.x * 30;
        const ga = palette.gridAlpha;

        ctx.save();
        ctx.lineWidth = 1;

        // Linhas que fogem para o ponto de fuga
        const grad = ctx.createLinearGradient(0, horizon, 0, H);
        grad.addColorStop(0, rgba(palette.blue, 0));
        grad.addColorStop(0.35, rgba(palette.blue, ga * 0.6));
        grad.addColorStop(1, rgba(palette.blue, ga));
        ctx.strokeStyle = grad;
        ctx.beginPath();
        const cols = 18;
        const spread = W * 1.6;
        for (let i = -cols; i <= cols; i++) {
            const bx = vpX + (i / cols) * spread;
            ctx.moveTo(vpX + (bx - vpX) * 0.02, horizon);
            ctx.lineTo(bx, H);
        }
        ctx.stroke();

        // Linhas horizontais: espaçamento 1/z dá a perspectiva; o offset faz avançar
        const rows = 14;
        for (let i = 0; i < rows; i++) {
            const zz = (i + gridOffset) / rows;               // 0 → horizonte, 1 → frente
            const y = horizon + depth * zz * zz;
            const a = ga * Math.min(1, zz * 2.2);
            if (a <= 0.003) continue;
            ctx.strokeStyle = rgba(palette.blue, a.toFixed(3));
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ---------- Física ---------- */
    function update(dt) {
        // Parallax suave: mouse no desktop, deriva automática no toque
        let tx = Math.sin(time * 0.00011) * 0.25;
        let ty = Math.cos(time * 0.00009) * 0.18;
        if (pointer.active) {
            tx = (pointer.x / W - 0.5) * 2;
            ty = (pointer.y / H - 0.5) * 2;
        }
        parallax.x += (tx - parallax.x) * 0.04 * dt;
        parallax.y += (ty - parallax.y) * 0.04 * dt;

        const repelR = 150;
        const repelR2 = repelR * repelR;

        for (const p of particles) {
            // Campo de fluxo orgânico (barato: senos e cossenos defasados)
            const ax = Math.cos(p.seed + time * 0.00021 + p.y * 0.0021) * 0.006;
            const ay = Math.sin(p.seed * 1.37 + time * 0.00017 + p.x * 0.0019) * 0.006;
            p.vx = (p.vx + ax * dt) * 0.992;
            p.vy = (p.vy + ay * dt) * 0.992;

            // Reação discreta ao cursor: afastamento suave dos nós próximos
            if (pointer.active) {
                const dx = p.sx - pointer.x;
                const dy = p.sy - pointer.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < repelR2 && d2 > 0.01) {
                    const d = Math.sqrt(d2);
                    const f = (1 - d / repelR) * 0.035 * p.z;
                    p.vx += (dx / d) * f * dt;
                    p.vy += (dy / d) * f * dt;
                }
            }

            const sp = Math.hypot(p.vx, p.vy);
            const max = 0.45;
            if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }

            const speed = 0.35 + p.z * 0.65;                 // frente se move mais
            p.x += p.vx * speed * dt;
            p.y += p.vy * speed * dt;

            // Volta pelo lado oposto (margem evita "pipocar" na borda)
            const m = 40;
            if (p.x < -m) p.x = W + m; else if (p.x > W + m) p.x = -m;
            if (p.y < -m) p.y = H + m; else if (p.y > H + m) p.y = -m;

            // Posição de tela com parallax proporcional à profundidade
            p.sx = p.x - parallax.x * p.z * 28;
            p.sy = p.y - parallax.y * p.z * 18;

            // Cintilação sutil (nunca pisca: varia entre 65% e 100%)
            const tw = 0.825 + Math.sin(p.phase + time * p.twinkle) * 0.175;
            p.a = (0.22 + p.z * 0.78) * tw * palette.nodeAlpha;
        }

        gridOffset = (gridOffset + 0.0028 * dt) % 1;
    }

    /* ---------- Conexões (hash espacial) ---------- */
    function drawLinks() {
        const cell = linkDist;
        const cols = Math.ceil((W + 120) / cell) + 1;
        const rows = Math.ceil((H + 120) / cell) + 1;
        const grid = new Map();

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const cx = Math.floor((p.sx + 60) / cell);
            const cy = Math.floor((p.sy + 60) / cell);
            const key = cy * cols + cx;
            let arr = grid.get(key);
            if (!arr) { arr = []; grid.set(key, arr); }
            arr.push(i);
            p._cx = cx; p._cy = cy;
        }

        for (let b = 0; b < BUCKETS; b++) bucketPaths[b] = new Path2D();
        pairCount = 0;
        const maxD2 = linkDist * linkDist;

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            for (let oy = 0; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (oy === 0 && ox === -1) continue;        // evita pares duplicados
                    const cx = p._cx + ox, cy = p._cy + oy;
                    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
                    const arr = grid.get(cy * cols + cx);
                    if (!arr) continue;
                    for (const j of arr) {
                        if (oy === 0 && ox === 0 && j <= i) continue;
                        const q = particles[j];
                        if (Math.abs(p.z - q.z) > 0.38) continue;   // só liga camadas vizinhas
                        const dx = p.sx - q.sx, dy = p.sy - q.sy;
                        const d2 = dx * dx + dy * dy;
                        // Camadas do fundo ligam a distâncias menores (mais "longe")
                        const lim = maxD2 * (0.45 + Math.min(p.z, q.z) * 0.55);
                        if (d2 > lim) continue;
                        const t = 1 - d2 / lim;
                        const strength = t * t * Math.min(p.z, q.z);
                        const bucket = Math.min(BUCKETS - 1, (strength * BUCKETS) | 0);
                        const path = bucketPaths[bucket];
                        path.moveTo(p.sx, p.sy);
                        path.lineTo(q.sx, q.sy);
                        if (strength > 0.15) {
                            if (pairCount * 2 >= pairs.length) pairs.push(0, 0);
                            pairs[pairCount * 2] = i;
                            pairs[pairCount * 2 + 1] = j;
                            pairCount++;
                        }
                    }
                }
            }
        }

        ctx.lineWidth = 0.8;
        for (let b = 0; b < BUCKETS; b++) {
            const a = ((b + 0.5) / BUCKETS) * palette.lineAlpha;
            ctx.strokeStyle = rgba(palette.line, a.toFixed(3));
            ctx.stroke(bucketPaths[b]);
        }

        // Linhas do cursor para os nós próximos
        if (pointer.active) {
            const r = linkDist * 1.25, r2 = r * r;
            ctx.lineWidth = 0.7;
            for (const p of particles) {
                if (p.z < 0.5) continue;
                const dx = p.sx - pointer.x, dy = p.sy - pointer.y;
                const d2 = dx * dx + dy * dy;
                if (d2 > r2) continue;
                const t = 1 - d2 / r2;
                ctx.strokeStyle = rgba(palette.cyan, (t * t * palette.lineAlpha * 1.4).toFixed(3));
                ctx.beginPath();
                ctx.moveTo(pointer.x, pointer.y);
                ctx.lineTo(p.sx, p.sy);
                ctx.stroke();
            }
        }
    }

    /* ---------- Nós ---------- */
    function drawNodes() {
        for (const p of particles) {
            const r = 0.6 + p.z * 1.5;
            if (p.hub) {
                const s = (14 + p.z * 26) * (0.85 + p.a * 0.3);
                ctx.globalAlpha = p.a * 0.75;
                ctx.drawImage(sprites[p.tint], p.sx - s / 2, p.sy - s / 2, s, s);
            }
            ctx.globalAlpha = p.a;
            ctx.fillStyle = rgba(p.hub ? palette.core : palette[p.tint], 1);
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, p.hub ? r * 1.25 : r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    /* ---------- Sinais (impulsos que percorrem a rede) ---------- */
    function neighborOf(idx, exclude) {
        const options = [];
        for (let k = 0; k < pairCount; k++) {
            const a = pairs[k * 2], b = pairs[k * 2 + 1];
            if (a === idx && b !== exclude) options.push(b);
            else if (b === idx && a !== exclude) options.push(a);
        }
        return options.length ? options[(Math.random() * options.length) | 0] : -1;
    }

    function spawnSignal() {
        if (!pairCount) return;
        const k = (Math.random() * pairCount) | 0;
        signals.push({
            from: pairs[k * 2],
            to: pairs[k * 2 + 1],
            t: 0,
            speed: rand(0.012, 0.02),
            hops: 2 + ((Math.random() * 4) | 0),
            life: 1
        });
    }

    function updateAndDrawSignals(dt) {
        const maxSignals = coarse ? 3 : 7;
        if (time > nextSignalAt && signals.length < maxSignals) {
            spawnSignal();
            nextSignalAt = time + rand(450, 1300);
        }

        for (let i = signals.length - 1; i >= 0; i--) {
            const s = signals[i];
            const a = particles[s.from], b = particles[s.to];
            if (!a || !b) { signals.splice(i, 1); continue; }

            s.t += s.speed * dt;
            if (s.t >= 1) {
                s.hops--;
                const next = s.hops > 0 ? neighborOf(s.to, s.from) : -1;
                if (next < 0) { signals.splice(i, 1); continue; }
                s.from = s.to; s.to = next; s.t = 0;
                continue;
            }

            // Some se os nós se afastarem demais durante o trajeto
            const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
            if (dist > linkDist * 1.15) { signals.splice(i, 1); continue; }

            const e = s.t * s.t * (3 - 2 * s.t);              // easing suave
            const x = a.sx + (b.sx - a.sx) * e;
            const y = a.sy + (b.sy - a.sy) * e;
            const z = (a.z + b.z) / 2;

            // Rastro curto
            const tt = Math.max(0, e - 0.22);
            ctx.strokeStyle = rgba(palette.cyan, (0.55 * z).toFixed(3));
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(a.sx + (b.sx - a.sx) * tt, a.sy + (b.sy - a.sy) * tt);
            ctx.lineTo(x, y);
            ctx.stroke();

            const size = 18 + z * 16;
            ctx.globalAlpha = 0.9 * z;
            ctx.drawImage(sprites.cyan, x - size / 2, y - size / 2, size, size);
            ctx.globalAlpha = 1;
        }
    }

    /* ---------- Quadro ---------- */
    function render(dt) {
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        drawGrid();
        ctx.globalCompositeOperation = palette.blend;
        drawLinks();
        drawNodes();
        if (!reduced) updateAndDrawSignals(dt);
        ctx.globalCompositeOperation = 'source-over';
    }

    function readPointer() {
        if (!pointer.has || coarse || reduced) { pointer.active = false; return; }
        const rect = hero.getBoundingClientRect();
        const x = pointer.cx - rect.left;
        const y = pointer.cy - rect.top;
        pointer.active = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
        if (pointer.active) {
            // Suaviza o próprio cursor para a reação não parecer "nervosa"
            pointer.x += (x - pointer.x) * 0.25;
            pointer.y += (y - pointer.y) * 0.25;
        }
    }

    function frame(now) {
        if (!running) return;
        const dt = lastTime ? Math.min(now - lastTime, 50) / 16.667 : 1;
        lastTime = now;
        time += dt * 16.667;
        readPointer();
        update(dt);
        render(dt);
        rafId = requestAnimationFrame(frame);
    }

    function start() {
        if (running || reduced || !heroVisible || document.hidden) return;
        running = true;
        lastTime = 0;
        rafId = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        cancelAnimationFrame(rafId);
    }

    /* Movimento reduzido: um único quadro estático e elegante */
    function drawStatic() {
        time = 4000;
        parallax.x = parallax.y = 0;
        pointer.active = false;
        update(1);
        render(1);
    }

    function refresh() {
        if (reduced) { stop(); drawStatic(); } else start();
    }

    /* ---------- Eventos ---------- */
    function onPointerMove(e) {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        if (!pointer.has) {
            const rect = hero.getBoundingClientRect();
            pointer.x = e.clientX - rect.left;
            pointer.y = e.clientY - rect.top;
        }
        pointer.cx = e.clientX;
        pointer.cy = e.clientY;
        pointer.has = true;
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { pointer.has = false; });

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { resize(); if (reduced) drawStatic(); }, 120);
    });
    ro.observe(hero);

    const io = new IntersectionObserver((entries) => {
        heroVisible = entries[0].isIntersecting;
        if (heroVisible) start(); else stop();
    }, { threshold: 0 });
    io.observe(hero);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
    });

    const onReduceChange = () => { reduced = mqReduce.matches; refresh(); };
    const onCoarseChange = () => { coarse = mqCoarse.matches; resize(); refresh(); };
    if (mqReduce.addEventListener) {
        mqReduce.addEventListener('change', onReduceChange);
        mqCoarse.addEventListener('change', onCoarseChange);
    } else {                                    // Safari antigo
        mqReduce.addListener(onReduceChange);
        mqCoarse.addListener(onCoarseChange);
    }

    // Acompanha o botão de tema do site (script.js altera data-theme no <body>)
    new MutationObserver(() => {
        palette = PALETTES[currentTheme()];
        buildSprites();
        if (reduced) drawStatic();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });

    /* ---------- Início ---------- */
    palette = PALETTES[currentTheme()];
    buildSprites();
    resize();
    refresh();
    if (!running) drawStatic();
    // Entrada orquestrada: o CSS faz o fade-in do canvas
    requestAnimationFrame(() => hero.classList.add('hero-fx-ready'));
})();
