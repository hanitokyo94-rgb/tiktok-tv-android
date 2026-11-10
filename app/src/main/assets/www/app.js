/* ============================================================
   TikTok TV — Remote-first player for Android TV / Google TV
   Data: TikTok profile/tag/explore pages via r.jina.ai reader
   MP4:  tikwm.com single-video API via r.jina.ai (no watermark)
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const JINA = 'https://r.jina.ai/';
const TT = 'https://www.tiktok.com';
const LS = {
  saved: 'ttv_saved_v1',
  recent: 'ttv_recent_v1',
  cache: 'ttv_cache_v1',
  last: 'ttv_last_v1'
};
const CACHE_TTL = 2 * 60 * 60 * 1000; // mp4 links expire — 2h
const INFO_TIMEOUT = 3500;
const SEEK_STEP = 10;

const TAG_SUGGESTS = [
  'ترند', 'اكسبلور', 'ضحك', 'طبخ', 'كورة', 'fyp', 'foryou',
  'funny', 'cats', 'food', 'music', 'gaming', 'sports', 'news', 'art'
];

/* ---------- State ---------- */
const S = {
  mode: 'boot',            // boot | player | search
  feed: [],                // items {id, user, url}
  idx: -1,
  feedLabel: '',
  feedType: 'explore',     // explore | user | tag
  feedUser: '',
  followers: '',
  displayName: '',
  avatarMap: {},
  dead: new Set(),
  cur: null,               // resolved current video data
  muted: false,
  started: false,
  switching: false,
  infoTimer: null,
  osdTimer: null,
  keyLock: 0,
  resolveSeq: 0
};

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const els = {
  splash: $('splash'), splashStatus: $('splashStatus'),
  playerLayer: $('playerLayer'),
  videoA: $('videoA'), videoB: $('videoB'),
  posterLayer: $('posterLayer'), posterImg: $('posterImg'),
  info: $('infoOverlay'), feedName: $('feedName'), counter: $('counter'),
  authorChip: $('authorChip'), authorAvatar: $('authorAvatar'),
  authorName: $('authorName'), authorStats: $('authorStats'),
  caption: $('caption'), vstats: $('vstats'),
  hints: $('hints'), seekFill: $('seekFill'), seekTime: $('seekTime'),
  osd: $('osd'), startGate: $('startGate'),
  errorScreen: $('errorScreen'), errMsg: $('errMsg'), retryBtn: $('retryBtn'),
  search: $('searchOverlay'), searchInput: $('searchInput'),
  savedChips: $('savedChips'), tagChips: $('tagChips'), recentChips: $('recentChips'),
  recentSection: $('recentSection'), toast: $('toast')
};

let activeVid = els.videoA, standbyVid = els.videoB;

/* ---------- Storage helpers ---------- */
function lsGet(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

const getSaved = () => lsGet(LS.saved, []);
const setSaved = a => lsSet(LS.saved, a);
const getRecent = () => lsGet(LS.recent, []);
function pushRecent(q) {
  let r = getRecent().filter(x => !(x.q === q.q && x.type === q.type));
  r.unshift(q); r = r.slice(0, 8); lsSet(LS.recent, r);
}

/* ---------- Video cache ---------- */
const memCache = new Map();
function cacheGet(id) {
  if (memCache.has(id)) return memCache.get(id);
  const store = lsGet(LS.cache, {});
  const e = store[id];
  if (e && Date.now() - e.t < CACHE_TTL) { memCache.set(id, e.d); return e.d; }
  return null;
}
function cacheSet(id, d) {
  memCache.set(id, d);
  const store = lsGet(LS.cache, {});
  store[id] = { t: Date.now(), d };
  const keys = Object.keys(store);
  if (keys.length > 250) { keys.sort((a, b) => store[a].t - store[b].t).slice(0, 50).forEach(k => delete store[k]); }
  lsSet(LS.cache, store);
}

/* ---------- Utils ---------- */
function fmtCount(n) {
  if (n == null || isNaN(n)) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return m + ':' + String(ss).padStart(2, '0');
}
async function fetchText(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'X-Return-Format': 'markdown' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function fetchRetry(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fetchText(url); }
    catch (e) { err = e; await new Promise(r => setTimeout(r, 2500)); }
  }
  throw err;
}
function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

/* ---------- Feed loaders ---------- */
function parseVideos(md) {
  const out = [], seen = new Set();
  const re = /https:\/\/www\.tiktok\.com\/@([\w.\-]+)\/video\/(\d{15,25})/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const id = m[2];
    if (!seen.has(id)) { seen.add(id); out.push({ id, user: m[1], url: `${TT}/@${m[1]}/video/${id}` }); }
  }
  return out;
}
function parseProfileMeta(md) {
  const meta = { displayName: '', followers: '', avatarMap: {} };
  const content = md.slice(md.indexOf('Markdown Content:'));
  const h1 = content.match(/^# (.+)$/m);
  if (h1) meta.displayName = h1[1].trim();
  const fol = content.match(/\*\*([\d.,]+[KM]?)\*\*\s*Followers/i);
  if (fol) meta.followers = fol[1] + ' متابع';
  const av = content.matchAll(/Avatar for ([\w.\-]+)\]\((https:\/\/[^\)]+)\)/g);
  for (const a of av) meta.avatarMap[a[1]] = a[2];
  return meta;
}

async function loadExplore() {
  const md = await fetchRetry(JINA + TT + '/explore');
  return parseVideos(md);
}
async function loadUser(user) {
  const md = await fetchRetry(JINA + TT + '/@' + encodeURIComponent(user));
  const meta = parseProfileMeta(md);
  const vids = parseVideos(md);
  if (!vids.length) throw new Error('NO_CHANNEL');
  return { vids, meta };
}
async function loadTag(tag) {
  const md = await fetchRetry(JINA + TT + '/tag/' + encodeURIComponent(tag));
  const vids = parseVideos(md);
  if (!vids.length) throw new Error('NO_TAG');
  return vids;
}

/* ---------- Video resolver (tikwm via jina) ---------- */
async function resolveVideo(item, bust = false) {
  if (!bust) {
    const c = cacheGet(item.id);
    if (c) return c;
  }
  const seq = ++S.resolveSeq;
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(item.url);
  const raw = await fetchRetry(JINA + api, 2);
  if (seq !== S.resolveSeq) return null; // stale
  const start = raw.indexOf('{"code"');
  if (start < 0) throw new Error('BAD_JSON');
  const json = JSON.parse(raw.slice(start));
  if (!json || json.code !== 0 || !json.data || !json.data.play) throw new Error('RESOLVE_FAIL');
  const d = json.data;
  const out = {
    id: d.id,
    play: d.play.startsWith('//') ? 'https:' + d.play : d.play,
    cover: d.cover || '',
    title: (d.title || '').trim(),
    duration: d.duration || 0,
    playCount: d.play_count, likes: d.digg_count, comments: d.comment_count,
    author: {
      user: (d.author && d.author.unique_id) || item.user,
      nick: (d.author && d.author.nickname) || item.user,
      avatar: (d.author && d.author.avatar) || ''
    }
  };
  cacheSet(item.id, out);
  return out;
}

/* ---------- Player engine ---------- */
function showPoster(cover, idle = false) {
  if (cover) els.posterImg.src = cover;
  els.posterLayer.classList.toggle('idle', idle);
  els.posterLayer.classList.remove('hidden');
}
function hidePoster() { els.posterLayer.classList.add('hidden'); }

function showStartGate() {
  els.startGate.classList.remove('hidden');
}
function hideStartGate() { els.startGate.classList.add('hidden'); }

function showFatal(msg) {
  els.errMsg.textContent = msg;
  els.errorScreen.classList.remove('hidden');
  hidePoster();
  try { activeVid.pause(); standbyVid.pause(); } catch (e) {}
}

async function playIndex(i, { autoplay = true } = {}) {
  if (S.switching) return;
  if (i < 0 || i >= S.feed.length) return;
  const item = S.feed[i];
  S.idx = i;
  S.switching = true;
  showInfo();
  updateCounter();
  showPoster(item.coverHint || '');

  let data = null;
  try {
    data = await resolveVideo(item);
  } catch (e1) {
    try { data = await resolveVideo(item, true); } catch (e2) { /* fallthrough */ }
  }
  if (!data) {
    S.dead.add(item.id);
    S.switching = false;
    const nextAlive = findAlive(i, 1);
    if (nextAlive >= 0) playIndex(nextAlive, { autoplay });
    else showFatal('تعذّر تحميل هذا الفيديو. تأكد من اتصال الإنترنت ثم أعد المحاولة.');
    return;
  }

  S.cur = data;
  renderInfo(data);

  const v = standbyVid;
  v.src = data.play;
  v.muted = S.muted;
  const wantStart = autoplay && S.started;
  try {
    if (wantStart) await v.play();
  } catch (e) {
    v.muted = true; S.muted = true;
    try { await v.play(); showOSD('🔇 اضغط OK لتشغيل الصوت'); } catch (e2) {}
  }

  const old = activeVid;
  activeVid = v; standbyVid = old;
  v.classList.add('active');
  old.classList.remove('active');
  setTimeout(() => { try { old.pause(); old.removeAttribute('src'); old.load(); } catch (e) {} }, 450);

  if (wantStart || S.started) { hidePoster(); hideStartGate(); }
  else showPoster(data.cover, true);
  S.switching = false;

  // warm next
  const ni = findAlive(i, 1);
  if (ni >= 0) resolveVideo(S.feed[ni]).catch(() => {});
}

function findAlive(from, dir) {
  let i = from + dir;
  while (i >= 0 && i < S.feed.length) {
    if (!S.dead.has(S.feed[i].id)) return i;
    i += dir;
  }
  return -1;
}

function next() { const i = findAlive(S.idx, 1); if (i >= 0) playIndex(i); else showOSD('نهاية القائمة — ابحث عن قناة جديدة'); }
function prev() { const i = findAlive(S.idx, -1); if (i >= 0) playIndex(i); else showOSD('هذا أول فيديو'); }

function togglePlay() {
  if (activeVid.paused) { activeVid.play().catch(() => {}); showOSD('▶ تشغيل'); }
  else { activeVid.pause(); showOSD('⏸ إيقاف مؤقت'); }
  showInfo();
}
function seek(delta) {
  const v = activeVid;
  if (!v.duration) return;
  v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration - 0.2);
  showOSD((delta > 0 ? '⏩ +' : '⏪ −') + SEEK_STEP + 'ث');
  showInfo();
}
function toggleMute() {
  S.muted = !S.muted;
  activeVid.muted = S.muted;
  showOSD(S.muted ? '🔇 كتم' : '🔊 صوت');
  showInfo();
}

/* ---------- Info overlay ---------- */
function renderInfo(d) {
  els.authorAvatar.src = d.author.avatar || (S.avatarMap[d.author.user] || '');
  els.authorName.textContent = '@' + d.author.user + (d.author.nick && d.author.nick !== d.author.user ? ' · ' + d.author.nick : '');
  els.authorStats.textContent = S.followers || '';
  els.authorChip.style.display = 'flex';
  els.caption.textContent = d.title || '—';
  els.vstats.innerHTML =
    `<span>▶ ${fmtCount(d.playCount)}</span>` +
    `<span>❤ ${fmtCount(d.likes)}</span>` +
    `<span>💬 ${fmtCount(d.comments)}</span>` +
    `<span>⏱ ${fmtTime(d.duration)}</span>`;
}
function updateCounter() {
  els.counter.textContent = (S.idx + 1) + ' / ' + S.feed.length;
  els.feedName.textContent = S.feedLabel;
}
function showInfo() {
  els.info.classList.remove('faded');
  clearTimeout(S.infoTimer);
  S.infoTimer = setTimeout(() => els.info.classList.add('faded'), INFO_TIMEOUT);
}
function showOSD(txt) {
  els.osd.textContent = txt;
  els.osd.classList.remove('hidden');
  clearTimeout(S.osdTimer);
  S.osdTimer = setTimeout(() => els.osd.classList.add('hidden'), 1300);
}

/* progress bar */
setInterval(() => {
  const v = activeVid;
  if (v && v.duration > 0) {
    els.seekFill.style.width = (v.currentTime / v.duration * 100) + '%';
    els.seekTime.textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration);
  }
}, 500);

/* video events */
[els.videoA, els.videoB].forEach(v => {
  v.addEventListener('ended', () => { if (v === activeVid) next(); });
  v.addEventListener('error', () => {
    if (v !== activeVid || !S.feed[S.idx]) return;
    const item = S.feed[S.idx];
    cacheSet(item.id, {}); // invalidate
    memCache.delete(item.id);
    resolveVideo(item, true).then(d => {
      if (d && d.play) { v.src = d.play; v.play().catch(() => {}); }
      else throw new Error('x');
    }).catch(() => next());
  });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { try { activeVid.pause(); } catch (e) {} }
  else if (S.started && activeVid.src) activeVid.play().catch(() => {});
});

/* ---------- Feed start ---------- */
async function startFeed(type, q) {
  S.mode = 'player';
  els.search.classList.add('hidden');
  els.errorScreen.classList.add('hidden');
  showPoster('');
  els.splashStatus.textContent = 'جاري تحميل الفيديوهات…';
  els.splash.classList.remove('hidden');

  try {
    if (type === 'user') {
      const { vids, meta } = await loadUser(q);
      S.feed = vids; S.feedType = 'user'; S.feedUser = q;
      S.feedLabel = '@' + q + (meta.displayName ? ' · ' + meta.displayName : '');
      S.followers = meta.followers; S.displayName = meta.displayName; S.avatarMap = meta.avatarMap;
      pushRecent({ type: 'user', q });
    } else if (type === 'tag') {
      const vids = await loadTag(q);
      S.feed = vids; S.feedType = 'tag';
      S.feedLabel = '#' + q; S.followers = ''; S.displayName = ''; S.avatarMap = {};
      pushRecent({ type: 'tag', q });
    } else {
      const vids = await loadExplore();
      S.feed = vids; S.feedType = 'explore';
      S.feedLabel = 'استكشاف'; S.followers = ''; S.displayName = ''; S.avatarMap = {};
    }
  } catch (e) {
    els.splash.classList.add('hidden');
    hidePoster();
    const why = e && e.message === 'NO_CHANNEL' ? 'ما لقينا قناة بهذا الاسم (أو ما فيها فيديوهات عامة).'
      : e && e.message === 'NO_TAG' ? 'ما لقينا فيديوهات لهذا الهاشتاق.'
      : 'تعذّر الاتصال بتيك توك. تأكد من الإنترنت وأعد المحاولة.';
    showFatal(why);
    return;
  }

  S.dead = new Set();
  els.splash.classList.add('hidden');
  els.playerLayer.classList.remove('hidden');

  if (!S.started) { showStartGate(); showPoster(S.feed[0] && S.feed[0].coverHint || ''); }
  await playIndex(0, { autoplay: S.started });

  if (type !== 'explore') lsSet(LS.last, { type, q });
}

/* ---------- Search overlay ---------- */
let delMode = false;
function renderChips() {
  // saved
  const saved = getSaved();
  els.savedChips.innerHTML = '';
  if (!saved.length) {
    els.savedChips.innerHTML = '<span style="color:var(--dim);font-size:18px">ما فيه قنوات محفوظة بعد — ابحث عن قناة واضغط ⭐ لحفظها</span>';
  }
  saved.forEach(c => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = '⭐ @' + c.u;
    b.onclick = () => { if (delMode) { setSaved(getSaved().filter(x => x.u !== c.u)); delMode = false; renderChips(); toast('تم الحذف'); } else startFeed('user', c.u); };
    els.savedChips.appendChild(b);
  });
  if (saved.length) {
    const d = document.createElement('button');
    d.className = 'chip del'; d.textContent = delMode ? '✕ إلغاء الحذف' : '🗑 حذف';
    d.onclick = () => { delMode = !delMode; renderChips(); };
    els.savedChips.appendChild(d);
  }
  // tags
  els.tagChips.innerHTML = '';
  TAG_SUGGESTS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = '#' + t;
    b.onclick = () => startFeed('tag', t);
    els.tagChips.appendChild(b);
  });
  // recents
  const rec = getRecent();
  els.recentSection.style.display = rec.length ? '' : 'none';
  els.recentChips.innerHTML = '';
  rec.forEach(r => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = (r.type === 'tag' ? '#' : '@') + r.q;
    b.onclick = () => startFeed(r.type, r.q);
    els.recentChips.appendChild(b);
  });
}

function openSearch() {
  S.mode = 'search';
  delMode = false;
  renderChips();
  els.search.classList.remove('hidden');
  try { activeVid.pause(); } catch (e) {}
  setTimeout(() => els.searchInput.focus(), 60);
}
function closeSearch() {
  S.mode = 'player';
  els.search.classList.add('hidden');
  els.searchInput.blur();
  if (S.started) activeVid.play().catch(() => {});
  showInfo();
}
function submitSearch() {
  let q = els.searchInput.value.trim();
  if (!q) { toast('اكتب اسم قناة أو هاشتاق'); return; }
  let type = 'user';
  if (q.startsWith('#')) { type = 'tag'; q = q.slice(1).trim(); }
  else if (q.startsWith('@')) { q = q.slice(1).trim(); }
  q = q.replace(/\s+/g, '');
  if (!q) { toast('اكتب اسم صحيح'); return; }
  els.searchInput.value = '';
  startFeed(type, q);
}

/* save current channel (Star key / long OK?) — use 'KeyS' + chip in overlay */
function saveCurrent() {
  if (S.feedType !== 'user') { toast('افتح قناة مستخدم أولاً ثم احفظها'); return; }
  const saved = getSaved();
  if (saved.some(c => c.u === S.feedUser)) { toast('القناة محفوظة من قبل'); return; }
  saved.unshift({ u: S.feedUser, name: S.displayName });
  setSaved(saved.slice(0, 20));
  toast('⭐ تم حفظ @' + S.feedUser);
}

/* ---------- Remote keys ---------- */
function isBackKey(e) {
  return e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' ||
         e.keyCode === 461 || e.keyCode === 10009;
}
document.addEventListener('keydown', e => {
  const k = e.key;

  if (S.mode === 'search') {
    if (isBackKey(e)) {
      e.preventDefault();
      if (els.searchInput.value) { els.searchInput.value = ''; }
      else closeSearch();
    } else if (k === 'Enter') {
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('chip')) { e.preventDefault(); ae.click(); }
      else { e.preventDefault(); submitSearch(); }
    } else if (k === 'ArrowDown' || k === 'ArrowUp') {
      // move focus between input and chips
      e.preventDefault();
      const focusables = [...els.search.querySelectorAll('button.chip')];
      if (!focusables.length) return;
      const i = focusables.indexOf(document.activeElement);
      if (k === 'ArrowDown') {
        const n = focusables[i + 1] || focusables[0];
        n.focus(); els.searchInput.blur();
      } else {
        if (i === 0) { els.searchInput.focus(); }
        else focusables[i - 1].focus();
      }
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('chip')) {
        e.preventDefault();
        const focusables = [...els.search.querySelectorAll('button.chip')];
        const i = focusables.indexOf(ae);
        const n = k === 'ArrowLeft' ? focusables[i + 1] : focusables[i - 1];
        if (n) n.focus();
      }
    }
    return;
  }

  /* player mode */
  if (S.mode !== 'player') return;
  const now = Date.now();
  if (['ArrowUp', 'ArrowDown'].includes(k) && now - S.keyLock < 450) { e.preventDefault(); return; }

  if (k === 'ArrowUp') { e.preventDefault(); S.keyLock = now; next(); showInfo(); }
  else if (k === 'ArrowDown') { e.preventDefault(); S.keyLock = now; prev(); showInfo(); }
  else if (k === 'ArrowRight') { e.preventDefault(); seek(+SEEK_STEP); }
  else if (k === 'ArrowLeft') { e.preventDefault(); seek(-SEEK_STEP); }
  else if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause') {
    e.preventDefault();
    if (!S.started) {
      S.started = true;
      hideStartGate();
      activeVid.muted = false; S.muted = false;
      if (activeVid.src) activeVid.play().catch(() => {});
      else playIndex(S.idx >= 0 ? S.idx : 0);
      showOSD('▶ استمتع!');
    } else togglePlay();
  }
  else if (k === 'MediaPlay') { e.preventDefault(); activeVid.play().catch(() => {}); }
  else if (k === 'MediaPause') { e.preventDefault(); activeVid.pause(); }
  else if (k === 'MediaFastForward' || k === 'MediaTrackNext') { e.preventDefault(); next(); }
  else if (k === 'MediaRewind' || k === 'MediaTrackPrevious') { e.preventDefault(); prev(); }
  else if (k === 'KeyM' || k === 'VolumeMute') { e.preventDefault(); toggleMute(); }
  else if (k === 'KeyS') { e.preventDefault(); saveCurrent(); }
  else if (isBackKey(e)) {
    e.preventDefault();
    openSearch();
  }
});

/* history: back button behavior */
history.replaceState({ ttv: 1 }, '');
window.addEventListener('popstate', () => {
  if (S.mode === 'search') { closeSearch(); }
  else { openSearch(); history.pushState({ ttv: 1 }, ''); }
});

/* retry button */
els.retryBtn.addEventListener('click', () => {
  els.errorScreen.classList.add('hidden');
  const last = lsGet(LS.last, null);
  startFeed(last ? last.type : 'explore', last ? last.q : undefined);
});

/* click fallback (mouse / touch testing) */
els.startGate.addEventListener('click', () => {
  S.started = true; hideStartGate();
  activeVid.muted = false; S.muted = false;
  if (activeVid.src) activeVid.play().catch(() => {});
});
els.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitSearch(); }
});

/* ---------- Boot ---------- */
(async function boot() {
  els.splash.classList.remove('hidden');
  els.playerLayer.classList.add('hidden');
  try {
    const vids = await loadExplore();
    if (!vids.length) throw new Error('empty');
    S.feed = vids; S.feedType = 'explore'; S.feedLabel = 'استكشاف';
    els.splash.classList.add('hidden');
    els.playerLayer.classList.remove('hidden');
    showStartGate();
    showPoster('');
    await playIndex(0, { autoplay: false });
  } catch (e) {
    els.splash.classList.add('hidden');
    els.playerLayer.classList.remove('hidden');
    showFatal('تعذّر تحميل الاكسبلور. تأكد من اتصال التلفزيون بالإنترنت — أو اضغط رجوع للبحث عن قناة.');
  }
})();
