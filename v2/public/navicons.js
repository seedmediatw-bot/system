// 選單圖示：每個圖示在兩個符號之間循環形變（Morphicons 引擎，Lucide 圖示）。
// 節奏沿用 Sam 認可的圖鑑：端點停留長、形變短（320–440 毫秒），五組週期與起始時間錯開。
// 一個計時器推動全部圖示；分頁在背景時停止；系統設定「減少動態」時固定顯示 A 符號。
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var N = {
    house: [['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }], ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
    chart: [['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }], ['path', { d: 'M18 17V9' }], ['path', { d: 'M13 17V5' }], ['path', { d: 'M8 17v-3' }]],
    receipt: [['path', { d: 'M12 17V7' }], ['path', { d: 'M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8' }], ['path', { d: 'M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z' }]],
    coin: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8' }], ['path', { d: 'M12 18V6' }]],
    calendar: [['path', { d: 'M8 2v3' }], ['path', { d: 'M16 2v3' }], ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M3 9h18' }]],
    sun: [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M12 20v2' }], ['path', { d: 'm4.93 4.93 1.41 1.41' }], ['path', { d: 'm17.66 17.66 1.41 1.41' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M20 12h2' }], ['path', { d: 'm6.34 17.66-1.41 1.41' }], ['path', { d: 'm19.07 4.93-1.41 1.41' }]],
    clock: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 6v6l4 2' }]],
    check: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm16 9-5.5 5.5L8 12' }]],
    briefcase: [['path', { d: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }], ['rect', { width: '20', height: '14', x: '2', y: '6', rx: '2' }]],
    sprout: [['path', { d: 'M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3' }], ['path', { d: 'M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4' }], ['path', { d: 'M5 21h14' }]],
    tree: [['path', { d: 'M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z' }], ['path', { d: 'M12 19v3' }]],
    users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['path', { d: 'M16 3.128a4 4 0 0 1 0 7.744' }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['circle', { cx: '9', cy: '7', r: '4' }]]
  };
  // 每一條輪廓有 a（起點）與 b（終點）：兩者都有就形變；只有 a 就收回；只有 b 就畫出。
  // 一組內「主輪廓」永遠連續，多出來的細節各自展開或收回，不硬把線條拉成一團。
  var CONFIG = {
    home: [[{ a: N.house[1], b: N.chart[0] }, { a: N.house[0] }, { b: N.chart[1] }, { b: N.chart[2] }, { b: N.chart[3] }], [4400, 320, 1300, 650]],
    expense: [[{ a: N.receipt[2], b: N.coin[0] }, { a: N.receipt[1], b: N.coin[1] }, { a: N.receipt[0], b: N.coin[2] }], [5300, 360, 1850, 1300]],
    leave: [[{ a: N.calendar[2], b: N.sun[0] }, { a: N.calendar[0] }, { a: N.calendar[1] }, { a: N.calendar[3] }].concat(N.sun.slice(1).map(function (b) { return { b: b }; })), [6100, 380, 2150, 2050]],
    checkin: [[{ a: N.clock[0], b: N.check[0] }, { a: N.clock[1], b: N.check[1] }], [4900, 360, 1750, 2800]],
    brand: [[{ a: N.sprout[1], b: N.tree[0] }, { a: N.sprout[0], b: N.tree[1] }, { a: N.sprout[2] }], [5700, 400, 2000, 900]],
    clients: [[{ a: N.briefcase[1], b: N.users[3] }, { a: N.briefcase[0], b: N.users[0] }, { b: N.users[1] }, { b: N.users[2] }], [6500, 440, 2300, 3500]]
  };

  var clamp = function (x) { return Math.max(0, Math.min(1, x)); };
  var ease = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var pairs = [];
  var raf = 0, last = 0;

  function makeChannel(svg, c) {
    var node = document.createElementNS(NS, 'path');
    node.setAttribute('pathLength', '1');
    svg.appendChild(node);
    var a = c.a ? [c.a] : null, b = c.b ? [c.b] : null;
    var buffer = { d: '', setAttribute: function (k, v) { if (k === 'd') this.d = v; } };
    var morph = Morphicons.createMorph(buffer, a || b);
    var ad = a ? Morphicons.canonicalD(a) : null, bd = b ? Morphicons.canonicalD(b) : null;
    node.setAttribute('d', ad || bd);
    return { node: node, morph: morph, a: a, b: b, buffer: buffer, ad: ad, bd: bd };
  }
  function paint(ch, t) {
    if (ch.a && ch.b) {
      if (t === 0) ch.node.setAttribute('d', ch.ad);
      else if (t === 1) ch.node.setAttribute('d', ch.bd);
      else { ch.morph.seek(ch.b, t); ch.node.setAttribute('d', ch.buffer.d); }
      return;
    }
    var amount = ch.b ? ease(clamp((t - 0.28) / 0.72)) : 1 - ease(clamp(t / 0.64));
    ch.node.style.strokeDasharray = '1';
    ch.node.style.strokeDashoffset = String(1 - amount);
    ch.node.style.opacity = amount < 0.015 ? '0' : '1';
  }

  function create(key) {
    var cfg = CONFIG[key];
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'navicon');
    var channels = cfg[0].map(function (c) { return makeChannel(svg, c); });
    var ch = cfg[1];
    var pair = { svg: svg, channels: channels, t: 0, to: 0, from: 0, elapsed: 0, active: false, local: 0, cycle: ch[0], dur: ch[1], hold: ch[2], next: ch[3] };
    pair.render = function (t) { pair.t = t; channels.forEach(function (c) { paint(c, t); }); };
    pair.render(0);
    pairs.push(pair);
    wake();
    return svg;
  }

  // 推進 dt 毫秒（計時器與驗收共用）
  function step(dt) {
    pairs.forEach(function (p) {
      p.local += dt;
      if (p.local >= p.next && !p.active) {
        p.from = p.t; p.to = 1 - p.to; p.elapsed = 0; p.active = true;
        // 轉到 B 後停留 hold，再回 A 後停到週期結束，端點停留比形變久
        p.next = p.local + (p.to ? p.hold : p.cycle - p.hold);
      }
      if (p.active) {
        p.elapsed += dt;
        var u = clamp(p.elapsed / p.dur);
        p.render(p.from + (p.to - p.from) * ease(u));
        if (u === 1) p.active = false;
      }
    });
  }
  function tick(now) {
    raf = 0;
    var dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    if (document.hidden || reduced.matches) { last = 0; return; }
    step(dt);
    raf = requestAnimationFrame(tick);
  }
  function wake() { if (!raf && !document.hidden && !reduced.matches) { last = 0; raf = requestAnimationFrame(tick); } }
  document.addEventListener('visibilitychange', function () { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; last = 0; } else wake(); });
  reduced.addEventListener('change', function () {
    if (reduced.matches) { cancelAnimationFrame(raf); raf = 0; pairs.forEach(function (p) { p.to = 0; p.active = false; p.render(0); }); }
    else wake();
  });

  window.NavIcons = { create: create, step: step };
})();
