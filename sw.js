/* Eddy@01567 Service Worker · notification + push router + offline shell · v2 */
'use strict';

const DB_NAME = 'dream-messenger-sw-v1';
const DB_VERSION = 1;
const STORE = 'state';

/* ------------------------------------------------------------------
 * 缓存版本：改动 index.html / sw.js / 图标后请 +1，激活时会清理旧壳缓存。
 * 前缀 mobius-shell- 是本 SW 独占的命名空间。
 * 应用自身的 mobius-image-resilience-v1（媒体韧性缓存，最多 64MB 用户媒体）
 * 由页面代码管理，本 SW 绝不可删除或拦截。
 * ------------------------------------------------------------------ */
const CACHE_VERSION = 'eddy-v1';
const SHELL_CACHE = `mobius-shell-${CACHE_VERSION}`;
const SHELL_CACHE_PREFIX = 'mobius-shell-';
const APP_MEDIA_CACHE = 'mobius-image-resilience-v1'; // 应用私有，永不触碰

/* v111z2：通知里的 icon / badge 只能喂「同源网址」。
   data: 在系统那侧表现不稳、blob: 更是页面进程里的临时地址（浏览器进程取不到）——
   两者都可能让 showNotification 直接失败，表现就是「一条通知都不弹」。
   这里做最后一道闸：不是同源网址就换成随包交付的站点图标。
   v111z3：站点图标换成用户自己的真 logo；URL 统一带 `?v=v111z3` 破缓存
   （手机里可能还留着旧占位图；问号只影响抓取，isPrecachedAsset 只比 pathname，见下）。 */
const NOTIF_ICON_FALLBACK = './icons/icon-192.png?v=v111z62';
const NOTIF_BADGE_FALLBACK = './icons/badge-96.png?v=v111z62';
function notifAssetUrl(value, fallback) {
  const s = String(value || '').trim();
  if (!s) return fallback;
  if (/^(data|blob):/i.test(s)) return fallback;
  return s;
}

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png?v=v111z62',
  './icons/icon-512.png?v=v111z62',
  './icons/icon-maskable-512.png?v=v111z62',
  './icons/apple-touch-icon-180.png?v=v111z62',
  './icons/badge-96.png?v=v111z62',
  './icons/favicon-32.png?v=v111z62',
  './icons/favicon-64.png?v=v111z62'
];

// 运行时缓存的第三方资源（lucide 图标库走 CDN，缓存后离线仍有图标）
const RUNTIME_ALLOW_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

/* v111u：页面交接过来的「最近到点」唤醒任务（只为观测与去重，真正靠上面的定时器） */
let wakeJobs = [];
const wakeFiredKeys = new Map();   // v111v：key → 发出时间，避免接力交接时同一条重复发
/* v111z13：并发交接先占坑，避免同一到点任务被多个 SCHEDULE_WAKE 同时发送。 */
const v111z13WakeClaimedKeys = new Set();
/* v111z6：这张表以前只活在内存里 —— Chrome 空闲就会把 SW 杀掉，表跟着丢，
   于是「同一条到点」在页面下一分钟接力时又发一遍（用户报的「通知一直重复」）。
   现在落进 IndexedDB（与 preferences 同一个 state 仓），并保留 24 小时。 */
const WAKE_FIRED_STATE_KEY = 'wakeFired';
const WAKE_FIRED_KEEP_MS = 24 * 60 * 60 * 1000;
let wakeFiredLoaded = false;
async function loadWakeFiredKeys(){
  if (wakeFiredLoaded) return wakeFiredKeys;
  wakeFiredLoaded = true;
  try {
    const saved = await getState(WAKE_FIRED_STATE_KEY, {});
    const now = Date.now();
    Object.entries(saved && typeof saved === 'object' ? saved : {}).forEach(([key, at]) => {
      if (now - Number(at) < WAKE_FIRED_KEEP_MS) wakeFiredKeys.set(String(key), Number(at));
    });
  } catch (_) {}
  return wakeFiredKeys;
}
function persistWakeFiredKeys(){
  try {
    const now = Date.now();
    const out = {};
    wakeFiredKeys.forEach((at, key) => { if (now - Number(at) < WAKE_FIRED_KEEP_MS) out[key] = Number(at); });
    setState(WAKE_FIRED_STATE_KEY, out);
  } catch (_) {}
}

let preferences = {
  systemNotificationEnabled: true,
  notificationOnlyBackground: false,
  notificationDndEnabled: false,
  notificationDndStart: '22:00',
  notificationDndEnd: '08:00',
  notificationSoundEnabled: true,
  notificationVibrateEnabled: true
};

/* ========================== 状态存储（原样保留） ========================== */

function openDb() {
  return new Promise(resolve => {
    let request;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (_) { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  });
}

async function getState(key, fallback) {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; try { db.close(); } catch (_) {} resolve(value); };
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => finish(request.result?.value ?? fallback);
      request.onerror = tx.onerror = tx.onabort = () => finish(fallback);
    } catch (_) { finish(fallback); }
  });
}

async function setState(key, value) {
  const db = await openDb();
  if (!db) return false;
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; try { db.close(); } catch (_) {} resolve(ok); };
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value, updatedAt: Date.now() });
      tx.oncomplete = () => finish(true);
      tx.onerror = tx.onabort = () => finish(false);
    } catch (_) { finish(false); }
  });
}

/* ========================== 免打扰 / 推送载荷（原样保留） ========================== */

function parseMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return match ? (Number(match[1]) % 24) * 60 + Math.min(59, Number(match[2]) || 0) : 0;
}

function isInDnd(settings) {
  if (!settings.notificationDndEnabled) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseMinutes(settings.notificationDndStart || '22:00');
  const end = parseMinutes(settings.notificationDndEnd || '08:00');
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function normalizePushPayload(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const receivedAt = Number(payload.receivedAt || payload.createdAt) || Date.now();
  const routeData = payload.routeData && typeof payload.routeData === 'object' ? payload.routeData : (payload.data && typeof payload.data === 'object' ? payload.data : {});
  return {
    ...payload,
    id: String(payload.id || `push-${receivedAt}-${Math.random().toString(36).slice(2)}`),
    title: String(payload.title || 'Eddy@01567'),
    body: String(payload.body || payload.text || '您有一条新消息'),
    route: String(payload.route || routeData.route || 'home'),
    routeData,
    tag: String(payload.tag || `dream-${receivedAt}`),
    createdAt: Number(payload.createdAt) || receivedAt,
    receivedAt
  };
}

async function appendInbox(payload) {
  const inbox = await getState('pushInbox', []);
  const list = Array.isArray(inbox) ? inbox : [];
  if (!list.some(item => item?.id && item.id === payload.id)) list.push(payload);
  await setState('pushInbox', list.slice(-100));
}

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - String(value).length % 4) % 4);
  const base64 = (String(value) + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

/* ========================== 生命周期 ========================== */

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // 预缓存失败不能阻断安装：单个资源 404 时仍要让通知功能可用。
    try {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(new Request(url, { cache: 'reload' })))
      );
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    preferences = { ...preferences, ...(await getState('preferences', {})) };
    // 只清理本 SW 自己的旧版壳缓存；应用的媒体韧性缓存必须原样保留。
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => {
        if (key === APP_MEDIA_CACHE) return null;
        if (key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE) return caches.delete(key);
        return null;
      }));
    } catch (_) {}
    await self.clients.claim();
    /* v111j12：装好新壳后主动告诉所有已开的页面「缓存版本已经变了」。
       旧写法只在导航请求里比对新旧 index.html 再发消息 —— 那一刻页面正在被替换，
       消息发给了正在卸载的旧页面，等于永远收不到；手机上常年挂着不关的 App
       就这样一直停在旧版本上（用户看到的连连成句气泡还是旧样式、节奏还是老规则）。 */
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(client => client.postMessage({ type: 'SHELL_VERSION', version: CACHE_VERSION }));
    } catch (_) {}
  })());
});

/* ========================== fetch：离线可用 ========================== */

function isPrecachedAsset(url) {
  const path = url.pathname.replace(/\/+$/, '/');
  return PRECACHE_URLS.some(entry => {
    const clean = entry.replace('./', '').split('?')[0];   /* v111z3：预缓存里带了 ?v= 破缓存串，比 pathname 时要剥掉 */
    return clean && (path.endsWith(`/${clean}`) || path === `/${clean}`);
  });
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }

  // 1) 应用私有媒体缓存（https://mobius.local/__media_cache__/...）：完全放行，
  //    由页面自己的 caches API 处理，SW 一旦介入会破坏媒体兜底恢复。
  if (url.hostname === 'mobius.local') return;

  // 2) AI 中继等跨域 API：绝不缓存也不拦截。
  if (url.origin !== self.location.origin) {
    if (RUNTIME_ALLOW_HOSTS.includes(url.hostname)) {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    }
    return;
  }

  // 3) Cloudflare 注入脚本在自托管下会 404，直接放行不缓存。
  if (url.pathname.startsWith('/cdn-cgi/')) return;

  // 4) 页面导航：先给缓存（秒开），后台静默更新，有新版本再通知页面。
  /* ⚠ v111j13：这一段以前对所有导航一视同仁，把「任何页面的响应」都写进 ./index.html 的缓存位。
     于是只要你打开过随包附带的 persona-check.html 或诊断页，App 的缓存就被换成了那个页面 ——
     下次打开 App 可能直接给你测试页，版本自检也跟着乱（缓存长度永远对不上 → 反复换壳）。
     现在只有「打开 App 本身」（路径是 / 或 /index.html）走这套；其它页面直接走网络。 */
  const isShellNavigation = request.mode === 'navigate'
    && (url.pathname === '/' || url.pathname === '' || url.pathname.endsWith('/index.html'));
  if (request.mode === 'navigate' && !isShellNavigation) {
    return;                    // 其它页面（persona-check / 诊断页）走网络，绝不碰壳缓存位
  }
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('./index.html') || await cache.match('./');
      if (cached) {
        /* 记下「这次导航实际发给页面的那份壳有多长」——页面启动自检时拿它跟线上最新比，
           两边不一样就说明页面跑的已经是旧壳（哪怕 sw 自己的版本号没变）。
           没有这一步的话，「内容变了但版本号没动」的上传会让 App 永远停在旧版本。 */
        try { cached.clone().text().then(text => setState('lastServed', { length: text.length, at: Date.now() })).catch(() => {}); } catch (_) {}
      }
      const network = fetch(request).then(async response => {
        if (response && response.ok) {
          await cache.put('./index.html', response.clone()).catch(() => {});
          if (cached) notifyIfShellChanged(cached, response.clone());
        }
        return response;
      }).catch(() => null);

      if (cached) { event.waitUntil(network); return cached; }
      const fresh = await network;
      return fresh || new Response(
        '<!doctype html><meta charset="utf-8"><title>Eddy@01567 离线</title>' +
        '<body style="font-family:system-ui;background:#111318;color:#e8f2f5;display:grid;place-items:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h1 style="font-weight:600">离线</h1>' +
        '<p style="opacity:.7">首次加载需要联网，之后即可离线使用。</p></div>',
        { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 }
      );
    })());
    return;
  }

  // 5) 图标 / manifest 等静态资源：SWR。
  if (isPrecachedAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});

// 对比新旧 index.html，内容变化时提示页面«有新版本»（页面可自行决定是否刷新）。
async function notifyIfShellChanged(oldResponse, newResponse) {
  try {
    const [a, b] = await Promise.all([oldResponse.clone().text(), newResponse.text()]);
    if (a.length === b.length) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: 'SHELL_UPDATED', size: b.length }));
  } catch (_) {}
}

/* ========================== 消息协议（保持向后兼容） ========================== */

self.addEventListener('message', event => {
  const message = event.data || {};
  const reply = value => { try { event.ports?.[0]?.postMessage(value); } catch (_) {} };
  if (message.type === 'SKIP_WAITING') {
    event.waitUntil(Promise.resolve(self.skipWaiting()).then(() => reply({ ok: true })));
    return;
  }
  if (message.type === 'CACHE_NOTIFICATION_AVATAR') {
    event.waitUntil((async () => {
      try {
        const raw=String(message.dataUrl||''); const match=raw.match(/^data:([^;,]+)?;base64,(.*)$/i);
        if (!match || !message.url) return reply({ok:false});
        const binary=atob(match[2]); const bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i+=1) bytes[i]=binary.charCodeAt(i);
        const cache=await caches.open(SHELL_CACHE);
        await cache.put(String(message.url), new Response(bytes,{headers:{'content-type':match[1]||'image/png','cache-control':'max-age=86400'}}));
        reply({ok:true});
      } catch (_) { reply({ok:false}); }
    })());
    return;
  }
  if (message.type === 'CONFIGURE_NOTIFICATIONS') {
    preferences = { ...preferences, ...(message.preferences || {}) };
    event.waitUntil(setState('preferences', preferences).then(ok => reply({ ok })));
    return;
  }
  if (message.type === 'CONFIGURE_PUSH') {
    event.waitUntil(setState('pushConfig', {
      applicationServerKey: message.applicationServerKey || '',
      subscribeEndpoint: message.subscribeEndpoint || ''
    }).then(ok => reply({ ok })));
    return;
  }
  /* ══════════════════════════════════════════════════════════════
     v111u：后台定时唤醒
     --------------------------------------------------------------
     页面被切到后台 / 锁屏时，页内计时器会被系统节流（最小 1 分钟起），
     到点的消息通知就会迟到。页面每次交接把「最近 8 分钟内该发的几条」
     （最多 5 条）送进来，SW 用 waitUntil 把定时器吊住（浏览器最多允许约 5 分钟），
     到点直接发系统通知 —— 准点率比页内计时器高。v111v 起：页面每分钟接力
     续一次（覆盖更远），SW 发完会回报页面（页面用它记「到点准不准」的账）。
     页面被完全冻结或关掉时这条链会断：那种情况只有推送服务能叫醒。
     ══════════════════════════════════════════════════════════════ */
  if (message.type === 'SCHEDULE_WAKE') {
    /* v111z6：整段包进异步 —— 先把持久化的去重表读回来，再决定哪几条要吊 */
    event.waitUntil((async () => {
    const MAX_HOLD_MS = 5 * 60 * 1000;      // 单次吊住的上限（平台限制，约 5 分钟）
    const HORIZON_MS = 8 * 60 * 1000;       // v111v：接 8 分钟内的到点，靠页面每分钟接力续上
    const now = Date.now();
    await loadWakeFiredKeys();
    const jobs = (Array.isArray(message.items) ? message.items : [])
      .map(item => ({
        dueAt: Number(item && item.dueAt) || 0,
        title: String((item && item.title) || '新消息').slice(0, 80),
        body: String((item && item.body) || '').slice(0, 160),
        route: String((item && item.route) || 'home'),
        routeData: (item && item.routeData && typeof item.routeData === 'object') ? item.routeData : {},
        handle: String((item && item.handle) || (item && item.routeData && item.routeData.handle) || ''),
        tag: String((item && item.tag) || '') || undefined
      }))
      .filter(item => item.dueAt > now - 1000 && item.dueAt - now <= HORIZON_MS)
      .filter(item => {
        const key = `${item.tag || item.handle}|${item.dueAt}`;
        const firedAt = wakeFiredKeys.get(key);
        if (v111z13WakeClaimedKeys.has(key)) return false;
        return !(firedAt && Date.now() - firedAt < 15 * 60 * 1000);
      })
      .slice(0, 5);
    jobs.forEach(job => v111z13WakeClaimedKeys.add(`${job.tag || job.handle}|${job.dueAt}`));
    if (!jobs.length) {
      /* v111v：页面每分钟接力一次，常常「这一分钟没有要到点的」——此时不能清掉
         已经挂好的定时器，否则接力反而把定时器打断了。空手来就空手走。 */
      reply({ ok: true, armed: 0, kept: wakeJobs.length });
      return;
    }
    wakeJobs.length = 0;
    jobs.forEach(job => wakeJobs.push(job));
    const hold = new Promise(resolve => {
      const timers = jobs.map(job => setTimeout(async () => {
        let jobDelivered = false, jobSkipped = false;
        try {
          const saved = await getState('preferences', preferences);
          const settings = { ...preferences, ...(saved || {}) };
          if (settings.systemNotificationEnabled === false || isInDnd(settings)) { jobSkipped = true; return; }
          const soundOn = settings.notificationSoundEnabled !== false;
          const vibrateOn = settings.notificationVibrateEnabled !== false;
          /* v111z7：用户要求「每一条都要弹」—— tag 带上这个到点的时间戳，
             不然同一个人连着两个到点会互相覆盖，看着就像「没弹」。 */
          await self.registration.showNotification(job.title, {
            body: job.body,
            /* v111z27RestoreNotificationIcons：恢复原有后台通知 icon / badge 回退。 */
            icon: notifAssetUrl(job.icon, NOTIF_ICON_FALLBACK),
            badge: notifAssetUrl(job.badge, NOTIF_BADGE_FALLBACK),
            actions: [{ action: 'open', title: '打开' }, { action: 'dismiss', title: '忽略' }],
            tag: job.tag ? `${job.tag}:${job.dueAt}` : undefined,
            renotify: soundOn || vibrateOn,
            silent: !(soundOn || vibrateOn),
            timestamp: Date.now(),
            lang: 'zh-CN',
            data: { id: job.tag, route: job.route, routeData: job.routeData, ...job.routeData }
          });
          jobDelivered = true;
        } catch (_) { /* 发不出去就算了，页面回来还有补发 */ }
        finally {
          const claimKey = `${job.tag || job.handle}|${job.dueAt}`;
          v111z13WakeClaimedKeys.delete(claimKey);
          if (jobSkipped) return;
          /* v111v：不管刚才那条通知有没有真发出去，都记下「这个到点处理过了」并回报页面：
             ① 防止页面每分钟接力时把同一条重复排上；② 页面用它记「准点不准点」的账。 */
          try {
            wakeFiredKeys.set(`${job.tag || job.handle}|${job.dueAt}`, Date.now());
            persistWakeFiredKeys();   /* v111z6：落盘，SW 重启后仍然记得 */
            clients.forEach(client => client.postMessage({
              type: 'WAKE_FIRED', handle: job.handle || '', tag: job.tag || '', body: job.body || '',
              dueAt: job.dueAt, firedAt: Date.now(), source: 'sw', delivered: !!jobDelivered
            }));
          } catch (_) {}
        }
      }, Math.max(0, Math.min(MAX_HOLD_MS, job.dueAt - Date.now()))));
      setTimeout(() => { timers.forEach(clearTimeout); resolve(); }, MAX_HOLD_MS);
    });
    reply({ ok: true, armed: jobs.length, firstDueAt: jobs[0] ? jobs[0].dueAt : 0, horizonMs: HORIZON_MS, maxHoldMs: MAX_HOLD_MS });
    await hold;
    })());
    return;
  }
  if (message.type === 'GET_WAKE_STATE') {
    reply({ ok: true, jobs: wakeJobs.map(job => ({ tag: job.tag, dueAt: job.dueAt })) });
    return;
  }
  if (message.type === 'DRAIN_PUSH_INBOX') {
    event.waitUntil((async () => {
      const items = await getState('pushInbox', []);
      await setState('pushInbox', []);
      reply({ ok: true, items: Array.isArray(items) ? items : [] });
    })());
    return;
  }
  /* v111j12：页面启动时自检 —— 缓存里的壳和线上文件长度一致吗？
     不一致就说明这台机器跑的是旧版本，页面据此在后台时机换壳。 */
  if (message.type === 'SHELL_SYNC') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('./index.html') || await cache.match('./');
        const cachedText = cached ? await cached.clone().text() : '';
        let networkLength = 0;
        try {
          const fresh = await fetch(new Request('./index.html', { cache: 'reload' }));
          if (fresh && fresh.ok) { networkLength = (await fresh.clone().text()).length; await cache.put('./index.html', fresh.clone()).catch(() => {}); }
        } catch (_) {}
        /* 上次导航实际交付给页面的那份壳：页面拿它判断「我手上这份是不是已经过时」 */
        let servedLength = 0;
        try { servedLength = Number((await getState('lastServed', {})).length) || 0; } catch (_) {}
        reply({
          ok: true, version: CACHE_VERSION,
          cachedLength: cachedText.length, networkLength, servedLength,
          different: networkLength > 0 && networkLength !== cachedText.length,
          stale: servedLength > 0 && networkLength > 0 && servedLength !== networkLength
        });
      } catch (_) { reply({ ok: false }); }
    })());
    return;
  }
  if (message.type === 'PING') {
    reply({ ok: true, now: Date.now() });
    return;
  }
  // 新增：查询缓存状态，供「存储中心」展示离线就绪情况。
  if (message.type === 'CACHE_STATUS') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        const keys = await cache.keys();
        reply({ ok: true, version: CACHE_VERSION, cached: keys.length, urls: keys.map(r => r.url) });
      } catch (_) { reply({ ok: false }); }
    })());
    return;
  }
  // 新增：强制刷新离线壳（存储中心「更新离线缓存」按钮可调用）。
  if (message.type === 'REFRESH_SHELL') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.allSettled(PRECACHE_URLS.map(url => cache.add(new Request(url, { cache: 'reload' }))));
        reply({ ok: true });
      } catch (_) { reply({ ok: false }); }
    })());
    return;
  }
  reply({ ok: false, error: 'unknown-message' });
});

/* ========================== 推送（原样保留） ========================== */

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let raw = {};
    try { raw = event.data?.json() || {}; }
    catch (_) { raw = { body: event.data?.text() || '您有一条新消息' }; }
    const payload = normalizePushPayload(raw);

    // 不再等待 inbox 完整读写后才显示通知：持久化、客户端投递和系统通知并行进行。
    const inboxPromise = appendInbox(payload);
    const clientsPromise = self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const settingsPromise = getState('preferences', preferences).then(saved => ({ ...preferences, ...(saved || {}) }));
    const [clients, settings] = await Promise.all([clientsPromise, settingsPromise]);
    preferences = settings;

    const clientDelivery = Promise.allSettled(clients.map(client => Promise.resolve().then(() => client.postMessage({ type: 'PUSH_RECEIVED', payload }))));
    const hasVisibleClient = clients.some(client => client.visibilityState === 'visible');
    let notificationPromise = Promise.resolve();
    if (settings.systemNotificationEnabled !== false && !isInDnd(settings) && !(settings.notificationOnlyBackground && hasVisibleClient)) {
      const options = {
        body: payload.body,
        icon: notifAssetUrl(payload.icon, NOTIF_ICON_FALLBACK),
        badge: notifAssetUrl(payload.badge, NOTIF_BADGE_FALLBACK),
        tag: payload.tag,
        renotify: payload.renotify !== false,
        requireInteraction: Boolean(payload.requireInteraction),
        timestamp: payload.createdAt,
        data: { id: payload.id, route: payload.route, routeData: payload.routeData, ...payload.routeData }
      };
      /* v111t：声音开关接进 SW —— 关掉声音时静默覆盖，不再响铃震动 */
      if (settings.notificationSoundEnabled === false) { options.silent = true; options.renotify = false; }
      notificationPromise = self.registration.showNotification(payload.title, options);
    }
    await Promise.allSettled([inboxPromise, clientDelivery, notificationPromise]);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const data = event.notification.data || {};
  const route = data.route || 'home';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = windows.find(client => client.visibilityState === 'visible') || windows[0];
    if (target) {
      await target.focus();
      target.postMessage({ type: 'NOTIFICATION_CLICK', route, data: { ...(data.routeData || {}), ...data } });
      return;
    }
    const url = new URL('./', self.registration.scope);
    url.hash = `route=${encodeURIComponent(route)}`;
    await self.clients.openWindow(url.href);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const config = await getState('pushConfig', {});
    let subscription = null;
    try {
      if (config?.applicationServerKey) {
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(config.applicationServerKey)
        });
        if (config.subscribeEndpoint) {
          await fetch(config.subscribeEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscription: subscription.toJSON(), scope: self.registration.scope, reason: 'pushsubscriptionchange' })
          });
        }
      }
    } catch (_) { subscription = null; }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED', resubscribeRequired: !subscription }));
  })());
});
