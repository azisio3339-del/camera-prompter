'use strict';
/* ============================================================
   sw.js / Service Worker
   全ファイルをキャッシュして、2 回目以降はオフラインでも動かす。
   更新するときは CACHE のバージョン番号を上げる（古いキャッシュは自動で消える）。
   ============================================================ */

var CACHE = 'prompter-v13';

var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './platform.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      /* 1 つでも失敗すると全部入らないので、個別に入れる */
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        return name === CACHE ? null : caches.delete(name);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 外部は扱わない

  /* ページの読み込みはキャッシュの index.html で返す（オフライン起動用） */
  if (req.mode === 'navigate') {
    event.respondWith(
      /* GitHub Pages は 10 分の HTTP キャッシュを付けるので、ページだけは毎回サーバーに確認する */
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  /* それ以外はキャッシュ優先、無ければ取得してキャッシュに入れる */
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
