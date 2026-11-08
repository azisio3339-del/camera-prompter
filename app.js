'use strict';
/* ============================================================
   app.js
   画面遷移、原稿、スクロール、カメラ、録画、保存
   （iOS / Android の分岐は platform.js にまとめてある）

   原稿は「原稿画面」ではなく原稿枠を直接タップして入力する。
   原稿枠はドラッグで移動、ピンチで拡大縮小できる。
   ============================================================ */

(function () {

  var P = window.Platform;
  function $(sel) { return document.querySelector(sel); }
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ---------- 設定の初期値と範囲（SPEC 4. 設定項目） ---------- */

  var DEFAULTS = {
    duration: 60,   // 秒：全文をスクロールし終えるまでの時間
    fontSize: 22,   // px：原稿の文字の大きさ
    readLine: 40,   // %：枠の高さに対する「読むライン」の位置
    /* 枠の位置と大きさは画面の向きごとに別で覚える（%）。
       横画面はレンズが左なので左上、縦画面はレンズが上なので上辺いっぱい。 */
    land: { w: 75, h: 30, x: 0, y: 0 },
    port: { w: 94, h: 24, x: 50, y: 0 }
  };

  var LIMITS = {
    duration: { min: 10, max: 600, step: 5 },
    fontSize: { min: 10, max: 48, step: 1 },
    readLine: { min: 0, max: 100, step: 1 }
  };

  /* 枠の位置・大きさの範囲（% ・1 刻み） */
  var GEO_LIMITS = {
    w: { min: 4, max: 100 }, h: { min: 5, max: 100 },     // PC の広い画面でも小さくできるよう % の下限は低め
    x: { min: 0, max: 100 }, y: { min: 0, max: 100 }
  };

  /* 行の高さ = 文字サイズ x 1.55（UI 参照の 22px / 34px に合わせた比率） */
  var LINE_RATIO = 1.55;

  /* 入力中の最小文字サイズ。これ未満だと iOS がページを勝手に拡大する */
  var EDIT_MIN_FONT = 16;

  /* 画面に小さく出す版。sw.js の CACHE（prompter-vNN）と同じ番号に合わせて上げる */
  var APP_VERSION = 'v16';

  var KEY_SCRIPT = 'prompter.script.v1';
  var KEY_SETTINGS = 'prompter.settings.v1';

  /* 行の折り返しを測るので、長すぎる原稿は入力行をそのまま 1 行として扱う */
  var MAX_MEASURE_CHARS = 20000;

  /* 1 アイコン 1 項目。枠のサイズと位置はスライダーを置かず、枠を直接操作する */
  var POP_TITLES = { time: '時間', text: '文字サイズ' };

  /* ---------- localStorage（失敗しても初期値で動かす） ---------- */

  var store = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* 保存できなくても続ける */ }
    },
    getJSON: function (key, fallback) {
      try {
        var v = localStorage.getItem(key);
        if (!v) return fallback;
        var o = JSON.parse(v);
        return (o && typeof o === 'object') ? o : fallback;
      } catch (e) { return fallback; }
    },
    setJSON: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 同上 */ }
    }
  };

  /* ---------- 状態 ---------- */

  var S = {
    screen: 'standby',          // 'standby' | 'recording' | 'review'
    rot: 0,                     // OS の回転角（0 / 90 / 180 / 270）。UI はこの逆回転で縦向きに固定する
    shortViewport: false,       // iOS ホーム画面起動で表示領域が画面より短いとき
    editRect: null,             // 入力中に固定しておく枠の実寸
    relayoutRaf: 0,
    editing: false,             // 原稿枠に入力中
    gesturing: false,           // 枠をドラッグ／ピンチ中
    popGroup: null,             // 開いている設定パネルの種類
    settings: null,
    script: '',

    lines: [],                  // 画面上の 1 行ずつに分割した原稿
    lineEls: [],
    lineH: 34,
    curLine: -1,
    layoutSig: null,

    progress: 0,                // 0〜1。スクロールの進み具合（これが位置の元）
    scroll: { running: false, startedAt: 0, elapsed: 0 },
    rafId: 0,

    stream: null,               // カメラ（プレビュー用）
    mirror: true,               // 鏡像で表示・録画するか（背面カメラだけ false）
    recStream: null,            // 録画用（前面カメラのときは鏡像の canvas から作る）
    mirroredRecording: false,

    counting: false,
    countdownTimer: 0,

    rec: {
      recorder: null, chunks: [], blob: null, url: null,
      startedAt: 0, duration: 0, timer: 0
    },

    toastTimer: 0,
    saveTimer: 0
  };

  /* ---------- 小物 ---------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDuration(sec) {                       // 「1:00」
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + pad2(sec % 60);
  }
  function fmtElapsed(sec) {                        // 「00:23」
    sec = Math.max(0, Math.floor(sec));
    return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
  }

  function showToast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------- 設定の読み書き ---------- */

  function clampSetting(key, value) {
    var lim = LIMITS[key];
    if (!lim) return value;
    var v = Number(value);
    if (!isFinite(v)) return DEFAULTS[key];
    v = Math.round(v / lim.step) * lim.step;
    return Math.min(lim.max, Math.max(lim.min, v));
  }

  function clampGeo(key, value) {
    var lim = GEO_LIMITS[key];
    var v = Math.round(Number(value));
    if (!isFinite(v)) return DEFAULTS.land[key];
    return Math.min(lim.max, Math.max(lim.min, v));
  }

  /* ---------- 向き（縦向き固定の UI） ----------
     iPhone のカメラと同じく、UI は縦向きのレイアウトのまま物理的に固定し、
     OS が画面を横にしたぶんだけ #ui を逆回転させる。絵柄（アイコン・文字）だけ正立させる。
     カメラ映像と録画後の再生は OS の向きに従う（重力に対して正立するため）。
     入力中（キーボードが出ている間）は向きを変えない。 */
  function osAngle() {
    var a = null;
    if (typeof window.orientation === 'number') a = window.orientation;   // iOS：90 = 上が左、-90 = 上が右
    else if (screen.orientation && typeof screen.orientation.angle === 'number') a = screen.orientation.angle;
    if (a === null) a = 0;
    a = ((a % 360) + 360) % 360;
    /* 角度と実際の縦横が食い違うとき（PC のウィンドウなど）は回転しない */
    var landscape = window.innerWidth > window.innerHeight;
    if ((a === 90 || a === 270) !== landscape) a = 0;
    return a;
  }

  function updateRotation(force) {
    if (S.editing && !force) return false;      // 入力中は固定
    var a = osAngle();
    var changed = a !== S.rot;
    S.rot = a;
    var ui = $('#ui');
    var sideways = (a === 90 || a === 270);
    ui.style.width = (sideways ? window.innerHeight : window.innerWidth) + 'px';
    ui.style.height = (sideways ? window.innerWidth : window.innerHeight) + 'px';
    if (changed) renderScreenClass();
    return changed;
  }

  function isPortrait() { return true; }        // UI は常に縦向きレイアウト

  /* 枠の位置・大きさ（UI は縦固定なので 1 組だけ使う） */
  function geo() { return S.settings.port; }

  /* 画面上の指の移動量 → UI（縦固定）座標の移動量 */
  function toUI(dx, dy) {
    if (S.rot === 90) return { x: -dy, y: dx };
    if (S.rot === 270) return { x: dy, y: -dx };
    if (S.rot === 180) return { x: -dx, y: -dy };
    return { x: dx, y: dy };
  }

  function loadSettings() {
    var raw = store.getJSON(KEY_SETTINGS, {});
    var out = {
      duration: DEFAULTS.duration,
      fontSize: DEFAULTS.fontSize,
      readLine: DEFAULTS.readLine,
      deviceId: (typeof raw.deviceId === 'string') ? raw.deviceId : '',   // 前回使ったカメラ
      land: { w: DEFAULTS.land.w, h: DEFAULTS.land.h, x: DEFAULTS.land.x, y: DEFAULTS.land.y },
      port: { w: DEFAULTS.port.w, h: DEFAULTS.port.h, x: DEFAULTS.port.x, y: DEFAULTS.port.y }
    };
    Object.keys(LIMITS).forEach(function (k) {
      if (raw[k] !== undefined && raw[k] !== null) out[k] = clampSetting(k, raw[k]);
    });

    /* 旧形式（frameW / frameH / frameX / frameY）は横画面の設定として引き継ぐ */
    if (raw.frameW !== undefined) {
      out.land = {
        w: clampGeo('w', raw.frameW), h: clampGeo('h', raw.frameH),
        x: clampGeo('x', raw.frameX), y: clampGeo('y', raw.frameY)
      };
    }
    ['land', 'port'].forEach(function (k) {
      var src = raw[k];
      if (src && typeof src === 'object') {
        out[k] = {
          w: clampGeo('w', src.w), h: clampGeo('h', src.h),
          x: clampGeo('x', src.x), y: clampGeo('y', src.y)
        };
      }
    });
    return out;
  }

  function saveSettings() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(function () { store.setJSON(KEY_SETTINGS, S.settings); }, 150);
  }

  /* ---------- 行の分割（画面上の 1 行ずつに切る） ---------- */

  function computeVisualLines(text, width, fontPx, lineH) {
    var src = text.split('\n');
    if (text.length > MAX_MEASURE_CHARS) return src;

    var m = $('#measure');
    m.style.width = Math.max(1, width) + 'px';
    m.style.fontSize = fontPx + 'px';
    m.style.lineHeight = lineH + 'px';

    var out = [];
    var range = document.createRange();

    for (var s = 0; s < src.length; s++) {
      var line = src[s];
      if (line === '') { out.push(''); continue; }

      m.textContent = line;
      var node = m.firstChild;
      var n = line.length;

      var topOf = function (i) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        var rects = range.getClientRects();
        return rects.length ? rects[0].top : NaN;
      };

      var start = 0;
      var guard = 0;
      while (start < n && guard++ < 10000) {
        var t0 = topOf(start);
        var lo = start, hi = n - 1, best = start;
        while (lo <= hi) {                           // 同じ行の最後の文字を二分探索
          var mid = (lo + hi) >> 1;
          var t = topOf(mid);
          if (!(t > t0 + 1)) { best = mid; lo = mid + 1; }   // NaN もここ（安全側）
          else { hi = mid - 1; }
        }
        out.push(line.slice(start, best + 1));
        start = best + 1;
      }
      if (start < n) out.push(line.slice(start));
    }
    return out;
  }

  function relayout(force) {
    var clip = $('#frame-clip');
    var w = clip.clientWidth;

    /* 枠が隠れている間は幅が 0 になる。そのまま測ると 1 文字 1 行になって重いので後回し */
    if (w < 20) { S.layoutSig = null; return; }

    /* ドラッグ・ピンチの最中も折り返しを追従させる。
       ただし 1 フレームに 1 回までにまとめて、指の動きが重くならないようにする */
    if (S.gesturing && !force) {
      applyScrollPosition();
      if (!S.relayoutRaf) {
        S.relayoutRaf = requestAnimationFrame(function () {
          S.relayoutRaf = 0;
          relayout(true);
        });
      }
      return;
    }

    var fontPx = S.settings.fontSize;
    var lineH = Math.max(1, Math.round(fontPx * LINE_RATIO));
    var sig = w + '|' + fontPx + '|' + lineH + '|' + S.script;

    if (force || sig !== S.layoutSig) {
      S.layoutSig = sig;
      S.lineH = lineH;
      S.lines = S.script.length ? computeVisualLines(S.script, w, fontPx, lineH) : [];

      var box = $('#lines');
      box.style.fontSize = fontPx + 'px';
      box.style.setProperty('--line-h', lineH + 'px');
      box.textContent = '';

      var frag = document.createDocumentFragment();
      for (var i = 0; i < S.lines.length; i++) {
        var d = document.createElement('div');
        d.className = 'line';
        d.textContent = S.lines[i];
        frag.appendChild(d);
      }
      box.appendChild(frag);

      S.lineEls = Array.prototype.slice.call(box.children);
      S.curLine = -1;
    }
    applyScrollPosition();
  }

  /* ---------- スクロール位置の反映 ---------- */

  function applyScrollPosition() {
    var clip = $('#frame-clip');
    var h = clip.clientHeight;
    var readY = Math.round(h * S.settings.readLine / 100);
    var n = S.lines.length;
    var lineH = S.lineH;

    /* 1 行目が読むラインから始まり、最後の行が読むラインを通過し終えるよう上下に余白を入れる。
       移動距離は本文の高さそのものになる。 */
    $('#pad-top').style.height = readY + 'px';
    $('#pad-bottom').style.height = Math.max(0, h - readY) + 'px';

    var distance = n * lineH;
    var offset = distance * S.progress;
    $('#flow').style.transform = 'translate3d(0,' + (-offset) + 'px,0)';

    /* マーカーは「読むライン」そのものに置く。現在行は必ずこの位置を跨いでいる */
    $('#marker').style.top = readY + 'px';
    $('#frame-progress-bar').style.width = (S.progress * 100) + '%';

    setCurrentLine(n ? Math.min(n - 1, Math.floor(offset / lineH)) : -1);
  }

  function setCurrentLine(cur) {
    if (cur === S.curLine) return;
    var els = S.lineEls;
    var prev = S.curLine;

    if (prev >= 0 && els[prev]) els[prev].classList.remove('is-current');

    var from = Math.max(0, Math.min(prev < 0 ? 0 : prev, cur < 0 ? 0 : cur));
    var to = Math.min(els.length - 1, Math.max(prev, cur));
    for (var i = from; i <= to; i++) {
      if (els[i]) els[i].classList.toggle('is-read', i < cur);
    }
    if (cur >= 0 && els[cur]) {
      els[cur].classList.remove('is-read');
      els[cur].classList.add('is-current');
    }
    S.curLine = cur;
  }

  /* ---------- スクロールの進行 ---------- */

  function scrollTick() {
    if (!S.scroll.running) { S.rafId = 0; return; }
    var total = S.settings.duration * 1000;
    var elapsed = S.scroll.elapsed + (performance.now() - S.scroll.startedAt);
    var p = total > 0 ? elapsed / total : 1;
    if (p >= 1) {
      p = 1;
      S.scroll.running = false;
      S.scroll.elapsed = total;
    }
    S.progress = p;
    applyScrollPosition();
    if (S.scroll.running) S.rafId = requestAnimationFrame(scrollTick);
    else { S.rafId = 0; syncPauseButton(); }
  }

  function startScroll() {
    S.progress = 0;
    S.scroll.elapsed = 0;
    S.scroll.startedAt = performance.now();
    S.scroll.running = true;
    applyScrollPosition();
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = requestAnimationFrame(scrollTick);
  }

  function pauseScroll() {
    if (!S.scroll.running) return;
    S.scroll.elapsed += performance.now() - S.scroll.startedAt;
    S.scroll.running = false;
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = 0;
  }

  function resumeScroll() {
    if (S.scroll.running || S.progress >= 1) return;
    S.scroll.startedAt = performance.now();
    S.scroll.running = true;
    S.rafId = requestAnimationFrame(scrollTick);
  }

  function resetScroll() {
    pauseScroll();
    S.progress = 0;
    S.scroll.elapsed = 0;
    applyScrollPosition();
  }

  /* ---------- 枠の位置・大きさ ---------- */

  function stageSize() {
    var s = $('#stage');
    return { w: s.clientWidth, h: s.clientHeight };
  }

  function framePx() {
    var g = geo(), s = stageSize();
    var w = s.w * g.w / 100;
    var h = s.h * g.h / 100;
    return {
      w: w, h: h,
      x: (s.w - w) * g.x / 100,
      y: (s.h - h) * g.y / 100,
      sw: s.w, sh: s.h
    };
  }

  /* 実寸で決めた位置・大きさを % に戻して設定に反映する（ドラッグ／ピンチ用） */
  var FRAME_MIN_PX = { w: 72, h: 40 };   // これより小さいとつまみが押せない

  function setFramePx(x, y, w, h) {
    var s = stageSize();
    var g = geo();
    w = Math.max(FRAME_MIN_PX.w, w);
    h = Math.max(FRAME_MIN_PX.h, h);
    g.w = clampGeo('w', w / s.w * 100);
    g.h = clampGeo('h', h / s.h * 100);
    var fw = s.w * g.w / 100;
    var fh = s.h * g.h / 100;
    var freeW = Math.max(1, s.w - fw);
    var freeH = Math.max(1, s.h - fh);
    g.x = clampGeo('x', Math.min(freeW, Math.max(0, x)) / freeW * 100);
    g.y = clampGeo('y', Math.min(freeH, Math.max(0, y)) / freeH * 100);
    applySettings();
    saveSettings();
  }

  /* ホーム画面から起動した iOS では、表示領域の高さが端末の画面より短いことがある
     （キーボードを閉じたあとに iOS が元に戻し忘れる、など）。その外には何も描けないので、
     アプリの高さを無理に画面に合わせるのではなく（シャッターが切れる）、
     描ける範囲の中で操作列をいちばん下に寄せ、表示領域を戻すきっかけを与える。
     iOS の screen.width/height は向きによらず縦持ちの値を返す。 */
  var lastShort = null;
  function fitApp() {
    var app = $('#app');
    app.style.height = '';
    app.style.width = '';
    if (S.editing) return;                           // 入力中は enterEdit で固定した寸法のまま
    var short = false;
    if (P.isIOS && P.isStandalone()) {
      var a = Math.min(screen.width, screen.height), b = Math.max(screen.width, screen.height);
      var expectH = (S.rot === 90 || S.rot === 270) ? a : b;
      short = window.innerHeight < expectH - 1;
    }
    if (short !== S.shortViewport) {
      S.shortViewport = short;
      renderScreenClass();
    }
    if (short && lastShort !== true) nudgeViewport();
    lastShort = short;
  }

  /* ---------- プレビューの描画 ----------
     <video> は iOS ではネイティブのレイヤーで描かれ、回転アニメーション中にページより先に
     動いて一瞬小さく見える（ページ側で後から隠しても間に合わない）。
     そこで <video> は見えなくしておき、毎フレーム canvas（#view）に描き写したものを
     プレビューにする。canvas は普通の要素なのでレイアウトに即座に追従する。
     鏡像もここで掛け、録画とサムネイルも同じ canvas から取る。 */
  var previewToken = 0;
  function startPreviewLoop() {
    var token = ++previewToken;
    var v = $('#preview'), c = $('#view');
    var ctx = c.getContext('2d');
    var last = 0;
    function draw() {
      if (token !== previewToken) return;
      if (v.videoWidth && v.videoHeight) {
        if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
          c.width = v.videoWidth;              // 向きが変わると映像の縦横も入れ替わる
          c.height = v.videoHeight;
        }
        try {
          if (S.mirror) ctx.setTransform(-1, 0, 0, 1, c.width, 0);
          else ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(v, 0, 0, c.width, c.height);
        } catch (e) { /* 1 コマ取れなくても次へ */ }
      }
      schedule();
    }
    function schedule() {
      if (token !== previewToken) return;
      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(function () { draw(); });   // 映像の新しいコマごと
      } else {
        requestAnimationFrame(function (t) {                     // 無い環境は約 30fps
          if (t - last >= 28) { last = t; draw(); } else schedule();
        });
      }
    }
    schedule();
  }
  function stopPreviewLoop() { previewToken++; }

  /* 縮んだままの表示領域を iOS に見直させる（スクロール位置と高さを一瞬だけ動かす） */
  function nudgeViewport() {
    try { window.scrollTo(0, 1); window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    var de = document.documentElement;
    de.style.height = '100.1%';
    requestAnimationFrame(function () { de.style.height = ''; });
  }

  function applySettings() {
    updateRotation();
    fitApp();
    var s = stageSize();
    var fw, fh, fx, fy;

    if (S.editing && S.editRect) {
      /* 入力中はキーボードで画面の寸法が変わっても枠を動かさない */
      fw = S.editRect.w; fh = S.editRect.h;
      fx = S.editRect.x; fy = S.editRect.y;
    } else {
      var g = geo();
      fw = Math.round(s.w * g.w / 100);
      fh = Math.round(s.h * g.h / 100);
      fx = Math.round((s.w - fw) * g.x / 100);
      fy = Math.round((s.h - fh) * g.y / 100);
    }

    var f = $('#frame');
    f.style.width = fw + 'px';
    f.style.height = fh + 'px';
    f.style.left = fx + 'px';
    f.style.top = fy + 'px';

    /* 中身は正立させるので、横向きのときは中身の幅と高さを入れ替える */
    var fin = $('#frame-in');
    var sideways = (S.rot === 90 || S.rot === 270);
    fin.style.width = (sideways ? fh : fw) + 'px';
    fin.style.height = (sideways ? fw : fh) + 'px';

    /* 枠の下にラベルを置く。下に入らないときは枠の上に出す */
    var badges = $('#frame-badges');
    var below = fy + fh + 6;
    badges.style.left = fx + 'px';
    badges.style.top = (below + 24 > s.h ? Math.max(0, fy - 26) : below) + 'px';

    renderDial();
    relayout();
  }

  /* ---------- 設定パネル（押したアイコンの項目だけ出す） ---------- */

  var SLIDERS = {
    fontSize: 'set-fontsize'
  };

  function valueLabel(key, v) {
    return key === 'fontSize' ? v + 'pt' : v + '%';
  }

  function syncPop() {
    Object.keys(SLIDERS).forEach(function (key) {
      var input = document.getElementById(SLIDERS[key]);
      var label = document.getElementById(SLIDERS[key].replace('set-', 'val-'));
      if (input) input.value = S.settings[key];
      if (label) label.textContent = valueLabel(key, S.settings[key]);
    });
  }

  /* ---------- 時間のダイヤル ---------- */

  var DIAL_R = 150;                 // 円の半径（px）＝目盛りの位置
  var DIAL_LABEL_R = 118;           // 目盛りの数字の位置（目盛りより内側）
  var DIAL_STEP_DEG = 4;            // 5 秒きざみ 1 つぶんの角度
  var DIAL_WINDOW = 18;             // 針の前後に描く目盛りの数
  var DIAL_PX_PER_STEP = DIAL_R * DIAL_STEP_DEG * Math.PI / 180;   // なぞる距離 ÷ 1 きざみ
  var DIAL_MAX = (LIMITS.duration.max - LIMITS.duration.min) / LIMITS.duration.step;
  var dialPos = 0;                  // 針の位置（きざみ単位。なぞっている間は小数）

  function durToIndex(sec) { return (sec - LIMITS.duration.min) / LIMITS.duration.step; }
  function indexToDur(i) { return LIMITS.duration.min + i * LIMITS.duration.step; }

  function renderDial() {
    var portrait = isPortrait();
    var base = portrait ? -90 : 180;
    /* 指でなぞった向きに目盛りが動くように、並べる向きを画面の向きで変える。
       横画面は下へいくほど長い時間、縦画面は右へいくほど長い時間。 */
    var sign = portrait ? 1 : -1;
    $('#dial').style.setProperty('--dial-base', base + 'deg');

    var box = $('#dial-ticks');
    box.textContent = '';
    var lo = Math.max(0, Math.floor(dialPos) - DIAL_WINDOW);
    var hi = Math.min(DIAL_MAX, Math.ceil(dialPos) + DIAL_WINDOW);
    var frag = document.createDocumentFragment();

    for (var i = lo; i <= hi; i++) {
      var deg = base + sign * (i - dialPos) * DIAL_STEP_DEG;
      var sec = indexToDur(i);
      var major = sec % 30 === 0;      // 30 秒ごとに長い目盛りと数字

      var t = document.createElement('div');
      t.className = 'dial-tick' + (major ? ' is-major' : '');
      t.style.transform = 'rotate(' + deg + 'deg) translateX(' + DIAL_R + 'px)';
      frag.appendChild(t);

      /* 目盛りの数字は弧の中ほどだけに出す。
         端は円から外れて切れるので出さず、針のそばは下の大きい数字と重なるので出さない */
      var off = Math.abs((i - dialPos) * DIAL_STEP_DEG);
      if (major && off >= 7 && off <= 32) {
        var l = document.createElement('div');
        l.className = 'dial-label';
        l.textContent = fmtDuration(sec);
        l.style.transform = 'rotate(' + deg + 'deg) translateX(' + DIAL_LABEL_R +
                            'px) rotate(' + (-deg) + 'deg) rotate(var(--glyph-rot, 0deg))';
        frag.appendChild(l);
      }
    }
    box.appendChild(frag);
    $('#dial-value').textContent = fmtDuration(S.settings.duration);
    var range = $('#dur-range');
    if (range) range.value = S.settings.duration;
  }

  function bindDial() {
    var dial = $('#dial');
    var drag = null;

    dial.addEventListener('pointerdown', function (e) {
      if (S.screen !== 'standby') return;
      if (e.target && e.target.id === 'dur-range') return;   // 読み上げ用のスライダーは別扱い
      try { dial.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pos: dialPos };
      dial.classList.add('is-active');
      closePop();
    });

    dial.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      /* UI 座標での左右の移動量。左へなぞると時間が増える（画面上の向きは回転に合わせて変わる） */
      var moved = toUI(e.clientX - drag.x, e.clientY - drag.y).x;
      dialPos = Math.min(DIAL_MAX, Math.max(0, drag.pos - moved / DIAL_PX_PER_STEP));
      setDuration(indexToDur(Math.round(dialPos)));
      renderDial();
    });

    var end = function () {
      if (!drag) return;
      drag = null;
      dial.classList.remove('is-active');
      dialPos = Math.round(dialPos);        // きざみに合わせる
      setDuration(indexToDur(dialPos));
      renderDial();
    };
    dial.addEventListener('pointerup', end);
    dial.addEventListener('pointercancel', end);

    var range = $('#dur-range');
    if (range) {
      range.addEventListener('input', function () {
        setDuration(range.value);
        dialPos = durToIndex(S.settings.duration);
        renderDial();
      });
    }
  }

  /* 原稿枠と重なるなら反対側へ逃がす（枠は左に置くことが多いので、まずは右下） */
  function placePop() {
    var pop = $('#pop');
    var hits = function () {
      var p = pop.getBoundingClientRect();
      var f = $('#frame').getBoundingClientRect();
      return !(p.right < f.left || p.left > f.right || p.bottom < f.top || p.top > f.bottom);
    };
    pop.classList.remove('at-top');
    pop.classList.add('at-bottom');
    if (!hits()) return;
    pop.classList.remove('at-bottom');
    pop.classList.add('at-top');
    if (!hits()) return;
    pop.classList.remove('at-top');     // どちらでも重なるなら下に戻す
    pop.classList.add('at-bottom');
  }

  function openPop(group) {
    if (S.screen !== 'standby') return;
    if (S.editing) exitEdit();
    if (S.popGroup === group) { closePop(); return; }   // 同じボタンをもう一度押したら閉じる
    S.popGroup = group;
    $('#pop-title').textContent = POP_TITLES[group] || '設定';
    all('.pop-group').forEach(function (el) {
      el.classList.toggle('is-on', el.getAttribute('data-group') === group);
    });
    all('[data-pop]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-pop') === group);
    });
    $('#pop').hidden = false;
    placePop();
    syncPop();
  }

  function closePop() {
    S.popGroup = null;
    $('#pop').hidden = true;
    all('[data-pop]').forEach(function (b) { b.classList.remove('is-on'); });
  }

  function setSetting(key, value) {
    S.settings[key] = clampSetting(key, value);
    if (SLIDERS[key]) {
      var el = document.getElementById(SLIDERS[key].replace('set-', 'val-'));
      if (el) el.textContent = valueLabel(key, S.settings[key]);
    }
    applySettings();
    saveSettings();
  }

  function setDuration(sec) {
    S.settings.duration = clampSetting('duration', sec);
    $('#dial-value').textContent = fmtDuration(S.settings.duration);
    $('#rec-total').textContent = '/ ' + fmtDuration(S.settings.duration);
    saveSettings();
  }

  /* ---------- 画面の状態 ---------- */

  function setScreen(name) {
    if (S.screen === 'review' && name !== 'review') {
      try { $('#playback').pause(); } catch (e) { /* ignore */ }
      $('#player').classList.remove('is-playing');
    }
    if (name !== 'standby') { S.editing = false; closePop(); }
    S.screen = name;
    renderScreenClass();
    if (name === 'standby') applySettings();
  }

  function renderScreenClass() {
    var cls = 'screen-' + S.screen;
    if (S.editing) cls += ' editing';
    if (S.gesturing) cls += ' sizing';
    if (S.script.length) cls += ' has-script';
    if (S.shortViewport) cls += ' short-viewport';
    cls += ' rot' + S.rot;
    $('#app').className = cls;
  }

  /* ---------- 原稿（枠に直接入力する） ---------- */

  function setScript(text) {
    var changed = text !== S.script;
    S.script = text;
    store.set(KEY_SCRIPT, text);
    if (changed) {
      S.progress = 0;
      S.scroll.elapsed = 0;
    }
    renderScreenClass();
    relayout();
  }

  function enterEdit() {
    if (S.screen !== 'standby' || S.editing) return;
    closePop();
    var p = framePx();
    S.editRect = {
      x: Math.round(p.x), y: Math.round(p.y),
      w: Math.round(p.w), h: Math.round(p.h)
    };
    S.editing = true;

    /* キーボードが出ると iOS はページの高さそのものを縮める。
       そのままだと下の操作列やダイヤルが上に押し上げられて枠に重なるので、
       アプリ全体の寸法を入力前の値で固定し、キーボードは単に下を覆うだけにする。 */
    var app = $('#app');
    app.style.width = app.clientWidth + 'px';
    app.style.height = app.clientHeight + 'px';

    var ta = $('#frame-input');
    ta.value = S.script;
    /* iOS は 16px 未満の入力欄にフォーカスすると、user-scalable=no を無視して
       ページを拡大してしまう（画面が切り取られたように見える）。
       入力中だけは 16px 以上にして拡大を起こさせない。 */
    var editFs = Math.max(EDIT_MIN_FONT, S.settings.fontSize);
    ta.style.fontSize = editFs + 'px';
    ta.style.lineHeight = Math.max(1, Math.round(editFs * LINE_RATIO)) + 'px';
    renderScreenClass();
    applySettings();
    /* focus はタップの処理の中で同期的に呼ぶ。setTimeout で遅らせると iOS は
       フォーカスだけ当ててキーボードを出さず、もう一度タップしないと出てこない。 */
    focusScriptInput();
  }

  function focusScriptInput() {
    var ta = $('#frame-input');
    try {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch (e) { /* ignore */ }
  }

  function exitEdit() {
    if (!S.editing) return;
    var ta = $('#frame-input');
    S.editing = false;
    S.editRect = null;
    try { ta.blur(); } catch (e) { /* ignore */ }
    var app = $('#app');
    app.style.width = '';            // 固定していた寸法を戻す
    app.style.height = '';
    renderScreenClass();
    setScript(ta.value);
    applySettings();
    /* 向きの取り直しはすぐにはやらない。この時点ではまだキーボードが引っ込んでおらず
       画面が縮んだままのことがあり、一瞬だけ横画面と誤判定してしまう。
       通常は resize が来て直るが、来ない環境のために少し待ってからも見る。 */
    setTimeout(function () {
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }   // キーボード後にずれた表示位置を戻す
      updateRotation();
      applySettings();
    }, 400);
  }

  /* ---------- 原稿枠のドラッグ移動・ピンチ拡大縮小・タップ入力 ---------- */

  function bindFrameGestures() {
    var frame = $('#frame');
    var ptrs = {};
    var count = 0;
    var g = null;

    function beginGesture() {
      if (S.gesturing) return;
      S.gesturing = true;
      renderScreenClass();
    }
    function endGesture() {
      if (!S.gesturing) return;
      S.gesturing = false;
      renderScreenClass();
      relayout(true);          // 指を離したところで行を測り直す
    }

    frame.addEventListener('pointerdown', function (e) {
      if (S.screen !== 'standby' || S.editing) return;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      count = Object.keys(ptrs).length;
      try { frame.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      var p = framePx();
      if (count === 1) {
        var onHandle = e.target && e.target.closest && e.target.closest('#frame-resize');
        if (onHandle) {
          /* 右下のつまみ：左上を固定したまま幅と高さを変える */
          g = { mode: 'resize', id: String(e.pointerId), sx: e.clientX, sy: e.clientY,
                x0: p.x, y0: p.y, w0: p.w, h0: p.h };
          beginGesture();
        } else {
          g = { mode: 'drag', id: String(e.pointerId), sx: e.clientX, sy: e.clientY,
                x0: p.x, y0: p.y, w: p.w, h: p.h, moved: 0, t0: Date.now() };
        }
      } else if (count === 2) {
        var k = Object.keys(ptrs);
        var a = ptrs[k[0]], b = ptrs[k[1]];
        g = { mode: 'pinch', d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
              w0: p.w, h0: p.h, cx: p.x + p.w / 2, cy: p.y + p.h / 2 };
        beginGesture();
      }
    });

    frame.addEventListener('pointermove', function (e) {
      if (!g || !ptrs[e.pointerId]) return;
      ptrs[e.pointerId].x = e.clientX;
      ptrs[e.pointerId].y = e.clientY;

      if (g.mode === 'drag' && String(e.pointerId) === g.id) {
        var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        g.moved = Math.max(g.moved, Math.hypot(dx, dy));
        if (g.moved < 6) return;                     // 小さい動きはタップ扱い
        beginGesture();
        var u = toUI(dx, dy);
        setFramePx(g.x0 + u.x, g.y0 + u.y, g.w, g.h);
      } else if (g.mode === 'resize' && String(e.pointerId) === g.id) {
        /* つまみは利用者から見た右下にある。利用者の見た目の幅・高さに指の動きを足し、
           UI の幅・高さに戻す。固定するのは利用者から見た左上の角 */
        var rdx = e.clientX - g.sx, rdy = e.clientY - g.sy;
        var side = (S.rot === 90 || S.rot === 270);
        var iw0 = side ? g.h0 : g.w0, ih0 = side ? g.w0 : g.h0;
        var iw = Math.max(1, iw0 + rdx), ih = Math.max(1, ih0 + rdy);
        var nw = side ? ih : iw, nh = side ? iw : ih;
        var nx = g.x0, ny = g.y0;
        if (S.rot === 90) nx = g.x0 + g.w0 - nw;                       // UI の右上を固定
        else if (S.rot === 270) ny = g.y0 + g.h0 - nh;                 // UI の左下を固定
        else if (S.rot === 180) { nx = g.x0 + g.w0 - nw; ny = g.y0 + g.h0 - nh; }
        setFramePx(nx, ny, nw, nh);
      } else if (g.mode === 'pinch') {
        var k = Object.keys(ptrs);
        if (k.length < 2) return;
        var a = ptrs[k[0]], b = ptrs[k[1]];
        var d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        var scale = d / g.d0;
        var w = g.w0 * scale, h = g.h0 * scale;
        setFramePx(g.cx - w / 2, g.cy - h / 2, w, h);   // 中心を保ったまま拡大縮小
      }
    });

    function onUp(e) {
      if (!ptrs[e.pointerId]) return;
      var wasTap = g && g.mode === 'drag' && String(e.pointerId) === g.id &&
                   g.moved < 6 && (Date.now() - g.t0) < 600;
      delete ptrs[e.pointerId];
      count = Object.keys(ptrs).length;

      if (count === 0) {
        g = null;
        endGesture();
        if (wasTap) enterEdit();
      } else if (count === 1) {
        /* ピンチから指が 1 本になったらドラッグに引き継ぐ */
        var id = Object.keys(ptrs)[0];
        var p = framePx();
        g = { mode: 'drag', id: id, sx: ptrs[id].x, sy: ptrs[id].y,
              x0: p.x, y0: p.y, w: p.w, h: p.h, moved: 99, t0: 0 };
      }
    }
    frame.addEventListener('pointerup', onUp);
    frame.addEventListener('pointercancel', onUp);
  }

  /* ---------- カメラ ---------- */

  function stopStream() {
    stopPreviewLoop();
    if (!S.stream) return;
    try { S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    S.stream = null;
  }

  /* つながっているカメラ（映像入力）の一覧。許可が下りる前はラベルが空のことがある */
  function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices()
      .then(function (list) { return list.filter(function (d) { return d.kind === 'videoinput'; }); })
      .catch(function () { return []; });
  }

  /* 切り替えボタンは、カメラが 2 台以上あるときだけ出す（PC の複数 Web カメラ、iPhone の前面／背面） */
  function updateSwitchButton() {
    listCameras().then(function (cams) {
      var b = $('#btn-switch');
      if (b) b.hidden = cams.length < 2;
    });
  }

  /* 既定は前面カメラ。deviceId を指定するとそのカメラを開く（PC で Web カメラを選ぶ用）。
     背面カメラ以外は鏡像で表示・録画する。 */
  function openCamera(deviceId, loose) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var e = new Error('getUserMedia なし');
      e.name = 'NotSupportedError';
      return Promise.reject(e);
    }
    stopStream();
    var video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) video.deviceId = loose ? { ideal: deviceId } : { exact: deviceId };
    else video.facingMode = { ideal: 'user' };

    return navigator.mediaDevices.getUserMedia({ audio: true, video: video }).then(function (stream) {
      S.stream = stream;
      var track = stream.getVideoTracks()[0];
      var st = (track && track.getSettings) ? track.getSettings() : {};
      S.mirror = st.facingMode !== 'environment';        // 背面カメラだけ反転しない
      S.settings.deviceId = st.deviceId || deviceId || '';
      saveSettings();

      var v = $('#preview');
      v.srcObject = stream;
      v.muted = true;                 // ハウリング防止（録画には音声が入る）
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* 自動再生が止められても描画ループでコマは取れる */ });
      startPreviewLoop();
      hideCamError();
      updateSwitchButton();
      return stream;
    });
  }

  function ensureCamera() {
    if (S.stream) return Promise.resolve(true);
    /* 前回使ったカメラがあればそれを試し、だめなら前面カメラに戻す */
    var saved = S.settings.deviceId;
    var first = saved ? openCamera(saved).catch(function () { return openCamera(''); }) : openCamera('');
    return first
      .then(function () { return true; })
      .catch(function (err) { showCamError(err); return false; });
  }

  /* つながっているカメラを順に切り替える */
  function switchCamera() {
    if (S.screen !== 'standby') return;
    if (S.editing) exitEdit();
    listCameras().then(function (cams) {
      if (cams.length < 2) { showToast('切り替えられるカメラがありません'); return; }
      var cur = S.settings.deviceId;
      var idx = -1;
      for (var i = 0; i < cams.length; i++) { if (cams[i].deviceId === cur) { idx = i; break; } }
      var nextIdx = (idx + 1) % cams.length;
      var next = cams[nextIdx];
      var name = next.label || ('カメラ ' + (nextIdx + 1) + ' / ' + cams.length);
      openCamera(next.deviceId)
        .catch(function () { return openCamera(next.deviceId, true); })   // exact で開けなければ ideal で
        .then(function () { showToast(name); })
        .catch(function (err) {
          openCamera(cur || '').catch(function (e2) { showCamError(e2); });
          showToast('カメラを切り替えられませんでした（' + ((err && err.name) || 'Error') + '）');
        });
    });
  }

  function showCamError(err) {
    if (S.stream && S.stream.active) return;   // 別経路ですでに開けていれば出さない（起動時の失敗が遅れて届くことがある）
    var help = P.cameraHelp(err);
    $('#cam-error-title').textContent = help.title;
    $('#cam-error-body').textContent = help.body;
    $('#cam-error').hidden = false;
  }

  function hideCamError() { $('#cam-error').hidden = true; }

  /* ---------- 録画用のストリーム ---------- */

  /* プレビューと同じ見た目（鏡像）のまま録画する。
     プレビュー用の canvas（#view）を captureStream して、カメラの音声と合わせる。 */
  function buildRecordingStream() {
    S.mirroredRecording = false;
    if (!S.mirror) return S.stream;                     // 背面カメラは元の映像をそのまま録る
    var c = $('#view');
    if (!c.width || !c.height || typeof c.captureStream !== 'function') return S.stream;
    var cs;
    try { cs = c.captureStream(30); } catch (e) { cs = null; }
    var vTracks = cs ? cs.getVideoTracks() : [];
    if (!vTracks.length) return S.stream;               // 対応していない環境では反転なしで録る
    var audio = S.stream ? S.stream.getAudioTracks() : [];
    S.recStream = new MediaStream(vTracks.concat(audio));
    S.mirroredRecording = true;
    return S.recStream;
  }

  function stopRecordingStream() {
    if (S.recStream) {
      /* canvas 側の映像トラックだけ止める（音声はカメラのものなので残す） */
      try { S.recStream.getVideoTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      S.recStream = null;
    }
  }

  /* ---------- カウントダウンと録画 ---------- */

  function onShutter() {
    if (S.editing) exitEdit();
    closePop();
    if (S.screen !== 'standby' || S.counting) return;
    if (!P.canRecord()) { showToast('この端末では録画できません'); return; }
    if (!S.stream) {
      ensureCamera().then(function (ok) { if (ok) beginCountdown(); });
      return;
    }
    beginCountdown();
  }

  function beginCountdown() {
    setScreen('recording');
    S.counting = true;
    resetScroll();
    syncPauseButton();

    var n = 3;
    var cd = $('#countdown');
    cd.hidden = false;
    $('#countdown-num').textContent = String(n);
    $('#rec-elapsed').textContent = '00:00';
    $('#rec-total').textContent = '/ ' + fmtDuration(S.settings.duration);
    P.requestWakeLock();

    var step = function () {
      if (!S.counting) return;
      n -= 1;
      if (n <= 0) {
        cd.hidden = true;
        S.counting = false;
        startRecording();
        return;
      }
      $('#countdown-num').textContent = String(n);
      S.countdownTimer = setTimeout(step, 1000);
    };
    S.countdownTimer = setTimeout(step, 1000);
  }

  function cancelCountdown() {
    S.counting = false;
    clearTimeout(S.countdownTimer);
    $('#countdown').hidden = true;
    P.releaseWakeLock();
    resetScroll();
    setScreen('standby');
  }

  function startRecording() {
    var src = buildRecordingStream();
    /* 対応していそうな形式から順に試す。解像度によっては生成に失敗することがある */
    var candidates = P.mimeCandidates();
    var rec = null;
    for (var i = 0; i < candidates.length && !rec; i++) {
      try {
        rec = candidates[i] ? new MediaRecorder(src, { mimeType: candidates[i] }) : new MediaRecorder(src);
      } catch (e) { rec = null; }
    }
    if (!rec) {
      showToast('この端末では録画できません');
      stopRecordingStream();
      P.releaseWakeLock();
      setScreen('standby');
      return;
    }

    S.rec.recorder = rec;
    S.rec.chunks = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) S.rec.chunks.push(ev.data); };
    rec.onerror = function () { showToast('録画中にエラーが起きました'); };
    rec.onstop = finishRecording;

    try {
      rec.start();                 // timeslice なし（iOS の mp4 を 1 本の blob で受け取る）
    } catch (e) {
      showToast('録画を開始できませんでした');
      stopRecordingStream();
      P.releaseWakeLock();
      setScreen('standby');
      return;
    }

    S.rec.startedAt = performance.now();
    startScroll();                 // 録画とスクロールを同時に始める
    syncPauseButton();

    clearInterval(S.rec.timer);
    S.rec.timer = setInterval(function () {
      $('#rec-elapsed').textContent = fmtElapsed((performance.now() - S.rec.startedAt) / 1000);
    }, 200);
  }

  function onStop() {
    if (S.counting) { cancelCountdown(); return; }   // カウントダウン中は取り消し
    if (!S.rec.recorder) { setScreen('standby'); return; }

    S.rec.duration = (performance.now() - S.rec.startedAt) / 1000;
    clearInterval(S.rec.timer);
    S.rec.timer = 0;
    pauseScroll();

    var rec = S.rec.recorder;
    if (rec.state !== 'inactive') {
      try { rec.stop(); } catch (e) { finishRecording(); }
    } else {
      finishRecording();
    }
  }

  function finishRecording() {
    P.releaseWakeLock();
    captureThumb();

    var rec = S.rec.recorder;
    var type = (rec && rec.mimeType) || P.pickMimeType() || (P.isIOS ? 'video/mp4' : 'video/webm');
    type = String(type).split(';')[0];

    var blob = null;
    try { blob = new Blob(S.rec.chunks, { type: type }); } catch (e) { blob = null; }

    S.rec.chunks = [];
    S.rec.recorder = null;
    stopRecordingStream();

    if (!blob || !blob.size) {
      showToast('録画データが空でした');
      resetScroll();
      setScreen('standby');
      return;
    }

    revokeRecording();
    S.rec.blob = blob;
    S.rec.url = URL.createObjectURL(blob);
    setScreen('review');
    setupPlayback();
  }

  function revokeRecording() {
    if (S.rec.url) {
      try { URL.revokeObjectURL(S.rec.url); } catch (e) { /* ignore */ }
      S.rec.url = null;
    }
  }

  /* 直前の録画のサムネイル（プレビューの 1 コマ。アプリを閉じると消える） */
  function captureThumb() {
    try {
      var src = $('#view');
      if (!src.width || !src.height) return;
      var w = 120;
      var h = Math.max(1, Math.round(w * src.height / src.width));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      var t = $('#thumb');
      t.style.backgroundImage = 'url("' + c.toDataURL('image/jpeg', 0.7) + '")';
      t.classList.add('has-thumb');
    } catch (e) { /* 取れなくても困らない */ }
  }

  function syncPauseButton() {
    var b = $('#btn-pause');
    if (!b) return;
    var paused = !S.scroll.running && !S.counting;
    b.classList.toggle('is-paused', paused);
    b.setAttribute('aria-label', paused ? 'スクロールを再開' : 'スクロールを一時停止');
  }

  /* ---------- 録画後の再生 ---------- */

  function setupPlayback() {
    var v = $('#playback');
    $('#player').classList.remove('is-playing');
    v.src = S.rec.url;
    $('#pb-cur').textContent = '0:00';
    $('#pb-dur').textContent = fmtDuration(S.rec.duration);
    $('#pb-seek').value = 0;
    try { v.load(); } catch (e) { /* ignore */ }
  }

  function playbackDuration() {
    var d = $('#playback').duration;
    /* iOS の MediaRecorder は duration が Infinity になることがある */
    if (isFinite(d) && d > 0 && d < 86400) return d;
    return S.rec.duration || 0;
  }

  function togglePlayback() {
    var v = $('#playback');
    if (v.paused) {
      var p = v.play();
      if (p && p.catch) p.catch(function () { showToast('再生できませんでした'); });
      $('#player').classList.add('is-playing');
    } else {
      v.pause();
      $('#player').classList.remove('is-playing');
    }
  }

  function saveRecording() {
    if (!S.rec.blob) return;
    var name = P.fileName(S.rec.blob.type, new Date());
    $('#btn-save').disabled = true;
    P.saveVideo(S.rec.blob, name).then(function (result) {
      $('#btn-save').disabled = false;
      if (result === 'downloaded') showToast('ダウンロードしました');
      else if (result === 'failed') showToast('保存できませんでした');
    }).catch(function () {
      $('#btn-save').disabled = false;
      showToast('保存できませんでした');
    });
  }

  function retake() {
    /* 動画は保存せず撮影待機に戻る。サムネイルからは直前の録画をもう一度開ける */
    resetScroll();
    setScreen('standby');
  }

  /* ---------- 入力の割り当て ---------- */

  function bindUI() {

    /* 左列：設定アイコン → その項目だけのパネル */
    all('[data-pop]').forEach(function (btn) {
      btn.addEventListener('click', function () { openPop(btn.getAttribute('data-pop')); });
    });
    $('#pop-close').addEventListener('click', closePop);

    /* 右列 */
    $('#btn-switch').addEventListener('click', switchCamera);
    $('#shutter').addEventListener('click', onShutter);

    /* pointerup で focus してもキーボードが出なかった場合の保険。
       同じタップの click でもう一度 focus する（iOS はこれをタップ操作として扱う） */
    $('#frame').addEventListener('click', function () {
      if (S.editing && document.activeElement !== $('#frame-input')) focusScriptInput();
    });
    $('#thumb').addEventListener('click', function () {
      if (!S.rec.url) return;
      setScreen('review');
      setupPlayback();
    });
    $('#btn-pause').addEventListener('click', function () {
      if (S.counting) return;
      if (S.scroll.running) pauseScroll(); else resumeScroll();
      syncPauseButton();
    });
    $('#btn-stop').addEventListener('click', onStop);
    $('#btn-save').addEventListener('click', saveRecording);
    $('#btn-retake').addEventListener('click', retake);

    /* 録画後のプレーヤー */
    var pb = $('#playback');
    $('#play-btn').addEventListener('click', togglePlayback);
    pb.addEventListener('click', togglePlayback);
    pb.addEventListener('loadedmetadata', function () {
      $('#pb-dur').textContent = fmtDuration(playbackDuration());
    });
    pb.addEventListener('timeupdate', function () {
      var d = playbackDuration();
      $('#pb-cur').textContent = fmtDuration(pb.currentTime);
      if (d > 0 && !$('#pb-seek').matches(':active')) {
        $('#pb-seek').value = Math.round(pb.currentTime / d * 1000);
      }
    });
    pb.addEventListener('ended', function () {
      $('#player').classList.remove('is-playing');
      $('#pb-seek').value = 1000;
    });
    pb.addEventListener('pause', function () { $('#player').classList.remove('is-playing'); });
    pb.addEventListener('play', function () { $('#player').classList.add('is-playing'); });
    $('#pb-seek').addEventListener('input', function () {
      var d = playbackDuration();
      if (d > 0) {
        try { pb.currentTime = d * (Number(this.value) / 1000); } catch (e) { /* ignore */ }
      }
    });

    /* 原稿枠への直接入力 */
    var ta = $('#frame-input');
    ta.addEventListener('input', function () {
      store.set(KEY_SCRIPT, ta.value);      // 入力のたびに自動保存
    });
    /* アプリ切り替えなどで iOS 側がキーボードを閉じたときも、入力終了の処理（寸法の固定解除・
       表示領域の戻し）を必ず通す */
    ta.addEventListener('blur', function () {
      setTimeout(function () {
        if (S.editing && document.activeElement !== ta) exitEdit();
      }, 120);
    });
    $('#frame-done').addEventListener('click', function (e) {
      e.stopPropagation();
      exitEdit();
    });
    bindFrameGestures();

    /* 枠の外をタップしたら入力を終える／パネルを閉じる */
    document.addEventListener('pointerdown', function (e) {
      var t = e.target;
      if (S.editing && t.closest && !t.closest('#frame')) exitEdit();
      if (S.popGroup && t.closest && !t.closest('#pop') && !t.closest('[data-pop]')) closePop();
    }, true);

    /* 設定 */
    bindDial();
    Object.keys(SLIDERS).forEach(function (key) {
      var input = document.getElementById(SLIDERS[key]);
      if (!input) return;
      var handler = function () { setSetting(key, input.value); };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    /* カメラの再試行 */
    $('#cam-retry').addEventListener('click', function () {
      hideCamError();
      openCamera().catch(showCamError);
    });

    /* 画面の大きさが変わったら枠と行を作り直す */
    var onResize = function () {
      updateRotation();
      applySettings();
      if (S.popGroup) placePop();
    };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { if (!S.editing) applySettings(); });
    }
    /* orientationchange も強制はしない。入力中に向きが変わったことにされると
       レイアウトが組み替わってしまうため、反映は入力を終えたときに行う */
    window.addEventListener('orientationchange', function () {
      updateRotation();
      applySettings();
      setTimeout(function () { updateRotation(); applySettings(); }, 250);
    });

    /* 拡大・プルリフレッシュ・長押しメニューを止める（入力欄とスライダーは除く） */
    document.addEventListener('touchmove', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('#frame-input, input[type="range"]')) return;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
      document.addEventListener(name, function (e) { e.preventDefault(); }, { passive: false });
    });

    document.addEventListener('contextmenu', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('#frame-input')) return;
      e.preventDefault();
    });

    /* カメラの起動はタップを起点にしたい。起動時に取れていなければ最初のタップで取り直す */
    var firstTap = function () {
      if (!S.stream && $('#cam-error').hidden) ensureCamera();
      document.removeEventListener('pointerdown', firstTap);
    };
    document.addEventListener('pointerdown', firstTap);
  }

  /* ---------- Service Worker ---------- */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var ok = location.protocol === 'https:' ||
             location.hostname === 'localhost' ||
             location.hostname === '127.0.0.1';
    if (!ok) return;

    /* 新しい版の Service Worker に入れ替わったら、安全なときにページを読み直す。
       これがないと、更新直後の 1 回目は古いキャッシュの app.js で動いてしまい、
       2 回目の再読み込みまで新しい版にならない。 */
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) return;          // 初回インストールでは読み直さない
      reloaded = true;
      var safe = S.screen === 'standby' && !S.editing && !S.counting && !S.rec.blob;
      if (safe) location.reload();
      else showToast('新しい版があります。あとで再読み込みしてください');
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        if (reg && reg.update) reg.update().catch(function () { /* ignore */ });
      }).catch(function () { /* 失敗しても通常動作 */ });
    });
  }

  /* ---------- 起動 ---------- */

  function init() {
    S.settings = loadSettings();
    S.script = store.get(KEY_SCRIPT, '');
    dialPos = durToIndex(S.settings.duration);
    S.rot = osAngle();
    $('#app').setAttribute('data-orient', 'portrait');   // UI は常に縦向きレイアウト

    bindUI();
    syncPop();
    renderScreenClass();
    var ver = $('#ver');
    if (ver) ver.textContent = APP_VERSION;
    applySettings();
    syncPauseButton();

    ensureCamera();
    registerSW();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 動作確認用に最小限だけ外へ出す（UI には出さない） */
  window.__prompter = {
    state: S,
    setScript: setScript,
    setSetting: setSetting,
    setDuration: setDuration,
    setScreen: setScreen,
    setFramePx: setFramePx,
    framePx: framePx,
    stageSize: stageSize,
    geo: geo,
    isPortrait: isPortrait,
    applySettings: applySettings,
    openPop: openPop,
    closePop: closePop,
    enterEdit: enterEdit,
    exitEdit: exitEdit,
    onShutter: onShutter,
    onStop: onStop
  };

})();
