/*
 * Service Worker：让课间十分钟断网也能玩
 * ----------------------------------------
 * 单文件 HTML 游戏本来就是零外部依赖，加个缓存就能离线。
 * 校园 WiFi 不稳、地铁上没信号，孩子照样能开局。
 *
 * 策略：network-first（导航请求优先走网络）
 *   - 联网 → 永远拿最新版，顺手更新缓存。不会因为缓存而看不到新版本。
 *   - 断网 → 回退到缓存，游戏照常打开。
 * 早先那种 cache-first 会让用户一直看到旧版本，这里刻意不用。
 */

var CACHE = 'fsg-v1';
var ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-maskable.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .catch(function () { /* 预缓存失败不影响安装 */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
  );
});
