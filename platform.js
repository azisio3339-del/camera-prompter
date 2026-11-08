'use strict';
/* ============================================================
   platform.js
   iOS / Android で分岐が必要な処理をここだけに集める。
   ・録画形式（MediaRecorder の MIME）
   ・保存方法（共有シート / ダウンロード）
   ・画面スリープ防止（Screen Wake Lock）
   ・カメラが使えないときの案内文
   app.js はここで公開した window.Platform だけを呼ぶ。
   ============================================================ */

window.Platform = (function () {

  var ua = navigator.userAgent || '';

  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);

  /* ホーム画面から起動しているか（iOS は navigator.standalone） */
  function isStandalone() {
    if (window.navigator.standalone === true) return true;
    try {
      return window.matchMedia('(display-mode: fullscreen)').matches ||
             window.matchMedia('(display-mode: standalone)').matches;
    } catch (e) { return false; }
  }

  /* ---------- 録画形式 ---------- */

  var MP4 = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1,mp4a"',
    'video/mp4;codecs=h264',
    'video/mp4'
  ];
  var WEBM = [
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  /* iOS は video/mp4 を優先。Android は video/webm を優先して mp4 も候補に残す。
     使えそうな形式を順に返す（isTypeSupported が true でも実際の解像度で
     MediaRecorder の生成に失敗することがあるため、順に試せるようにしている） */
  function mimeCandidates() {
    if (typeof MediaRecorder === 'undefined') return [];
    var order = isAndroid ? WEBM.concat(MP4) : MP4.concat(WEBM);
    var out = [];
    for (var i = 0; i < order.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(order[i])) out.push(order[i]);
      } catch (e) { /* isTypeSupported が無い環境は無視して次へ */ }
    }
    out.push('');   // 最後はブラウザ任せ
    return out;
  }

  function pickMimeType() {
    var list = mimeCandidates();
    return list.length ? list[0] : '';
  }

  function canRecord() {
    return typeof MediaRecorder !== 'undefined';
  }

  function extFor(mime) {
    var m = String(mime || '');
    if (m.indexOf('mp4') >= 0) return 'mp4';
    if (m.indexOf('webm') >= 0) return 'webm';
    if (m.indexOf('quicktime') >= 0) return 'mov';
    return isIOS ? 'mp4' : 'webm';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fileName(mime, date) {
    var d = date || new Date();
    return 'prompter-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
           '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
           '.' + extFor(mime);
  }

  /* ---------- 保存 ---------- */

  /* navigator.share（files 指定）を優先し、使えなければダウンロードにする。
     戻り値: 'shared' | 'cancelled' | 'downloaded' | 'failed' */
  function saveVideo(blob, name) {
    var type = (blob && blob.type) || (isIOS ? 'video/mp4' : 'video/webm');
    var file = null;
    try { file = new File([blob], name, { type: type }); } catch (e) { file = null; }

    var canShareFiles = false;
    if (file && navigator.share && navigator.canShare) {
      try { canShareFiles = navigator.canShare({ files: [file] }); } catch (e) { canShareFiles = false; }
    }

    if (canShareFiles) {
      return navigator.share({ files: [file] })
        .then(function () { return 'shared'; })
        .catch(function (err) {
          if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return 'cancelled';
          return download(blob, name);
        });
    }
    return Promise.resolve(download(blob, name));
  }

  function download(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
      return 'downloaded';
    } catch (e) {
      return 'failed';
    }
  }

  /* ---------- 画面スリープ防止 ---------- */

  var sentinel = null;
  var wanted = false;

  function wakeLockSupported() {
    return !!(navigator.wakeLock && navigator.wakeLock.request);
  }

  function requestWakeLock() {
    wanted = true;
    if (!wakeLockSupported()) return Promise.resolve(false);   // 使えない環境では何もしない
    if (sentinel) return Promise.resolve(true);
    return navigator.wakeLock.request('screen').then(function (s) {
      sentinel = s;
      s.addEventListener('release', function () { sentinel = null; });
      return true;
    }).catch(function () { return false; });
  }

  function releaseWakeLock() {
    wanted = false;
    if (!sentinel) return;
    try { sentinel.release(); } catch (e) { /* 失敗しても困らない */ }
    sentinel = null;
  }

  /* 画面を隠すと解除されるので、戻ってきたら取り直す */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wanted && !sentinel) requestWakeLock();
  });

  /* ---------- カメラが使えないときの案内 ---------- */

  function cameraHelp(err) {
    var name = (err && err.name) || 'Error';
    var settingsPath = isIOS
      ? '「設定」アプリ →「Safari」→「カメラ」／「マイク」を「確認」または「許可」にしてから、このページを再読み込みしてください。\nホーム画面から起動したときは、「設定」→ アプリ名 → カメラ／マイクを確認してください。'
      : '「設定」→「アプリ」→ ブラウザ →「権限」→「カメラ」／「マイク」を許可してから、このページを再読み込みしてください。';

    if (!window.isSecureContext) {
      return {
        title: 'HTTPS が必要です',
        body: 'カメラは HTTPS か localhost でしか使えません。README の手順で HTTPS で配信してから開いてください。'
      };
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return { title: 'カメラの許可が必要です', body: 'カメラとマイクの使用が許可されていません。\n' + settingsPath };
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return { title: 'カメラが見つかりません', body: '前面カメラが見つかりませんでした。他のアプリがカメラを使っていないか確認して、もう一度試してください。' };
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return { title: 'カメラを開けません', body: '他のアプリがカメラを使っている可能性があります。他のアプリを閉じてから、もう一度試してください。' };
    }
    if (name === 'NotSupportedError') {
      return { title: 'この環境では使えません', body: 'このブラウザはカメラの取得に対応していません。iPhone は Safari で開いてください。' };
    }
    return { title: 'カメラを使えません', body: 'カメラを開けませんでした（' + name + '）。もう一度試してください。' };
  }

  /* ---------- 公開 ---------- */

  return {
    isIOS: isIOS,
    isAndroid: isAndroid,
    isStandalone: isStandalone,
    canRecord: canRecord,
    mimeCandidates: mimeCandidates,
    pickMimeType: pickMimeType,
    extFor: extFor,
    fileName: fileName,
    saveVideo: saveVideo,
    wakeLockSupported: wakeLockSupported,
    requestWakeLock: requestWakeLock,
    releaseWakeLock: releaseWakeLock,
    cameraHelp: cameraHelp
  };
})();
