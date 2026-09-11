/* =============================================================
   書架 — 蔵書目録  (offline-first PWA)
   すべてのデータは localStorage に保管し、共有はURLかJSONで行う。
   ============================================================= */
'use strict';

const KEY = 'shoka.library.v1';
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- 状態 ---------- */
let state = { works: [], settings: { tategaki: false, size: 17, shelfMode: 'series', shelfLook: 'spine' } };
let query = '';
let deferredInstall = null;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.works = Array.isArray(parsed.works) ? parsed.works.map(normalize) : [];
      state.settings = Object.assign(state.settings, parsed.settings || {});
      if (state.settings.shelfMode === 'timeline') state.settings.shelfMode = 'world';
    }
  } catch (e) { console.warn('蔵書の読み込みに失敗しました', e); }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ works: state.works, settings: state.settings, savedAt: Date.now() }));
  } catch (e) {
    toast('保管に失敗しました（容量超過かもしれません）');
    console.error(e);
  }
}

function normalize(w) {
  return {
    id: w.id || uid(),
    title: (w.title || '無題').trim(),
    series: (w.series || '').trim(),
    order: (w.order === 0 || w.order) ? Number(w.order) : null,
    world: (w.world || w.timeline || '').trim(),
    kind: (w.kind || '').trim(),
    pos: pickNum(w.pos, w.chrono),
    summary: (w.summary || '').trim(),
    author: (w.author || '').trim(),
    tags: Array.isArray(w.tags) ? w.tags.filter(Boolean) : String(w.tags || '').split(/[,、\s]+/).filter(Boolean),
    body: w.body || '',
    createdAt: w.createdAt || Date.now(),
    updatedAt: w.updatedAt || w.createdAt || Date.now()
  };
}

function pickNum(...vals) {
  for (const v of vals) if (v === 0 || (v != null && v !== '')) return Number(v);
  return null;
}

const KINDS = ['本編', '後日談', '番外編', '外伝'];

// 区分の並び順：本編 → 後日談 → 番外編 → 外伝 → 自分で付けた区分 → その他
function kindOrder(keys) {
  const known = KINDS.filter(k => keys.includes(k));
  const mine = keys.filter(k => !KINDS.includes(k) && k !== 'その他');
  const last = keys.includes('その他') ? ['その他'] : [];
  return [...known, ...mine, ...last];
}

const uid = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- 小道具 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
function countChars(s) { return (s || '').replace(/\s/g, '').length; }
function fmtCount(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万字' : n + '字'; }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
// 背表紙の色。題名から決まるので、同じ本はいつも同じ色になる。
// 落ち着いた（くすんだ）色に収まるよう、彩度と明度の幅を絞ってある。
function spineTone(seed) {
  const h = hue(seed) % 360;
  const pale = hue(seed + '紙') % 6 === 0;          // 六冊に一冊ほど、生成りの背表紙
  const hh = pale ? 32 + hue(seed + 'k') % 14 : h;  // 生成りは麻・象牙の色みに寄せる
  const sat = pale ? 15 + hue(seed + 's') % 11 : 15 + hue(seed + 's') % 19;
  const lit = pale ? 70 + hue(seed + 'l') % 9 : 23 + hue(seed + 'l') % 19;
  return {
    bg: `hsl(${hh} ${sat}% ${lit}%)`,
    fg: lit >= 55 ? 'rgba(40,30,20,.92)' : 'rgba(238,226,200,.94)',
    band: lit >= 55 ? 'rgba(120,90,45,.55)' : 'rgba(201,169,97,.62)'
  };
}

// 背表紙一冊分。話数が多いほど厚く、高さは題名から少しずつ変える。
function spineBook(item) {
  const t = spineTone(item.name);
  const thick = Math.round(Math.min(74, 27 + (item.count - 1) * 7 + Math.min(16, item.chars / 9000 * 16)));
  const high = (78 + (hue(item.name + '丈') % 6) * 4) / 100;   // 段の高さに対する割合
  const n = item.name.length;
  const size = n > 20 ? 10 : n > 16 ? 11 : n > 10 ? 12 : 13.5;
  return `
    <button class="spine-book" data-go="${item.href}" title="${esc(item.name)}"
      style="--w:${thick}px;--hf:${high};--bg:${t.bg};--fg:${t.fg};--band:${t.band}"
      aria-label="${esc(item.name)}${item.count > 1 ? '（全' + item.count + '話）' : ''}">
      <span class="spine">
        <span class="spine-ttl${n > 12 ? ' long' : ''}" style="font-size:${size}px">${esc(item.name)}</span>
        <span class="spine-num">${item.count > 1 ? item.count : '&middot;'}</span>
      </span>
    </button>`;
}

function bookcaseOf(spines) {
  return '<div class="bookcase">' + spines.join('') + '</div>';
}

function spineColor(str, i) {
  const h = (hue(str) + i * 37) % 360;
  const palette = [
    'hsl(' + ((h % 40) + 10) + ' 42% 30%)',
    'hsl(' + ((h % 30) + 90) + ' 26% 27%)',
    'hsl(' + ((h % 20) + 350) + ' 38% 32%)',
    'hsl(' + ((h % 25) + 35) + ' 45% 38%)'
  ];
  return palette[(hue(str) + i) % palette.length];
}

/* ---------- 本文の組版 ---------- */
function renderBody(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    buf = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      flush();
      const tag = m[1].length <= 2 ? 'h3' : 'h4';
      out.push(`<${tag}>${inline(m[2])}</${tag}>`);
      continue;
    }
    if (/^\s*([-*_＊＝]\s*){3,}$/.test(line) || /^[＊*]{3}$/.test(line.trim())) {
      flush(); out.push('<hr>'); continue;
    }
    buf.push(line.replace(/^\s+/, ''));
  }
  flush();
  return out.join('\n') || '<p class="hint">（本文はまだありません）</p>';
}

function inline(s) {
  let t = esc(s);
  // 強調
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 青空文庫式ルビ： ｜漢字《かんじ》 / 漢字《かんじ》
  t = t.replace(/[｜|]([^｜|《]{1,20})《([^》]{1,20})》/g, '<ruby>$1<rt>$2</rt></ruby>');
  t = t.replace(/([々一-鿿゠-ヿ぀-ゟ]{1,12})《([^》]{1,20})》/g, '<ruby>$1<rt>$2</rt></ruby>');
  return t;
}

/* ---------- 並び替え ---------- */
function sortInSeries(a, b) {
  const ao = a.order, bo = b.order;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if (ao != null && bo == null) return -1;
  if (ao == null && bo != null) return 1;
  return a.createdAt - b.createdAt;
}
function posSort(a, b) {
  const av = a.pos != null ? a.pos : a.order;
  const bv = b.pos != null ? b.pos : b.order;
  if (av != null && bv != null && av !== bv) return av - bv;
  if (av != null && bv == null) return -1;
  if (av == null && bv != null) return 1;
  return a.createdAt - b.createdAt;
}
function groups() { return groupList(state.works); }

function groupList(list) {
  const map = new Map();
  const singles = [];
  for (const w of list) {
    if (w.series) {
      if (!map.has(w.series)) map.set(w.series, []);
      map.get(w.series).push(w);
    } else singles.push(w);
  }
  for (const arr of map.values()) arr.sort(sortInSeries);
  const series = Array.from(map.entries())
    .map(([name, works]) => ({ name, works, updatedAt: Math.max(...works.map(w => w.updatedAt)) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  singles.sort((a, b) => b.updatedAt - a.updatedAt);
  return { series, singles };
}

// 一つの叢書を「区分ごとの束」に分ける（本編・後日談・番外編…）
function worldSections(name) {
  const buckets = new Map();
  for (const w of state.works) {
    if (w.world !== name) continue;
    const k = w.kind || '本編';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(w);
  }
  for (const arr of buckets.values()) arr.sort(posSort);
  return kindOrder(Array.from(buckets.keys())).map(k => ({ kind: k, works: buckets.get(k) }));
}

// 叢書の中を、本編から後日談へと通して読む並び
function worldSequence(name) {
  return worldSections(name).flatMap(sec => sec.works);
}

function worldGroups() {
  const names = [];
  const rest = [];
  for (const w of state.works) {
    if (w.world) { if (!names.includes(w.world)) names.push(w.world); }
    else rest.push(w);
  }
  const worlds = names
    .map(name => {
      const sections = worldSections(name);
      const works = sections.flatMap(sec => sec.works);
      return { name, sections, works, updatedAt: Math.max(...works.map(w => w.updatedAt)) };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  rest.sort((a, b) => b.updatedAt - a.updatedAt);
  return { worlds, rest };
}

function matches(w, q) {
  if (!q) return true;
  const hay = [w.title, w.series, w.world, w.kind, w.summary, w.author, w.tags.join(' '), w.body].join('\n').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
}

/* =============================================================
   画面
   ============================================================= */
const view = () => $('#view');

function route() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/w/'))      return renderReader(decodeURIComponent(h.slice(3)));
  if (h.startsWith('/series/')) return renderSeries(decodeURIComponent(h.slice(8)));
  if (h.startsWith('/g/'))      return renderWorld(decodeURIComponent(h.slice(3)));
  if (h.startsWith('/edit/'))   return renderEditor(decodeURIComponent(h.slice(6)));
  if (h === '/new')             return renderEditor(null);
  if (h === '/archive')         return renderArchive();
  return renderShelf();
}

function go(path) { location.hash = path; }

/* ---------- 書架 ---------- */
function renderShelf() {
  const v = view();
  updateStat();

  if (query) return renderSearch();

  if (!state.works.length) {
    v.innerHTML = `
      <div class="empty">
        <div class="mark">❦</div>
        <h2>棚はまだ空のままです</h2>
        <p>「＋ 収蔵する」から作品を納めてください。<br>
        Claude との会話で書いた小説は、そのまま貼り付けて取り込めます。<br>
        いちど収めた本は、この端末の中で電波がなくても読めます。</p>
        <div class="form-actions" style="justify-content:center;margin-top:22px">
          <button class="btn primary" onclick="location.hash='/new'">最初の一冊を納める</button>
          <button class="btn ghost" onclick="location.hash='/archive'">書庫（取り込み・書き出し）</button>
        </div>
      </div>`;
    return;
  }

  const mode = state.settings.shelfMode === 'world' ? 'world' : 'series';
  const look = state.settings.shelfLook === 'card' ? 'card' : 'spine';
  const shelve = (items, cards) => look === 'spine' ? bookcaseOf(items.map(spineBook)) : shelfOf(cards);

  let html = `
    <div class="shelf-modes">
      <span class="modes-label">棚の並べ方</span>
      <button class="chip" data-mode="series" aria-pressed="${mode === 'series'}">連作・単巻</button>
      <button class="chip" data-mode="world" aria-pressed="${mode === 'world'}">叢書（まとまり）</button>
      <span class="modes-label modes-gap">見た目</span>
      <button class="chip" data-look="spine" aria-pressed="${look === 'spine'}">背表紙</button>
      <button class="chip" data-look="card" aria-pressed="${look === 'card'}">目録札</button>
    </div>`;

  if (mode === 'world') {
    const { worlds, rest } = worldGroups();
    if (worlds.length) {
      html += sectionHead('叢 書 の 棚', worlds.length + ' collections');
      html += shelve(worlds.map(t => ({
        name: t.name, count: t.works.length, href: '/g/' + encodeURIComponent(t.name),
        chars: t.works.reduce((n, w) => n + countChars(w.body), 0)
      })), worlds.map(worldCard));
    } else {
      html += `<div class="section-head"><h2>叢 書 の 棚</h2><span class="count">まだ一つも</span></div>
        <p class="note">蔵書を開いて「手を入れる」から、<strong>叢書（まとまり）</strong>に同じ名前を入れると、
        連作をまたいで一つの叢書にまとまります。本編の物語と、そのあとの村の話や、増えていったお祭りの話——
        離れた場所で起きる後日談も、同じ名前を入れておけば一つの棚に揃います。<br>
        <strong>区分</strong>に「本編」「後日談」「番外編」などを入れておくと、叢書の中がその見出しで分かれます
        （空欄なら本編として扱います）。</p>`;
    }
    if (rest.length) {
      const loose = groupList(rest);
      html += sectionHead('叢書に入れていない蔵書', (loose.series.length + loose.singles.length) + ' volumes');
      html += shelve(
        [...loose.series.map(seriesItem), ...loose.singles.map(singleItem)],
        [...loose.series.map(seriesCard), ...loose.singles.map(w => workCard(w))]);
    }
  } else {
    const { series, singles } = groups();
    if (series.length) {
      html += sectionHead('連 作 の 棚', series.length + ' series');
      html += shelve(series.map(seriesItem), series.map(seriesCard));
    }
    if (singles.length) {
      html += sectionHead('単 巻 の 棚', singles.length + ' volumes');
      html += shelve(singles.map(singleItem), singles.map(w => workCard(w)));
    }
  }
  v.innerHTML = html;
  bindCards();
  bindModes();
}

function seriesItem(t) {
  return {
    name: t.name, count: t.works.length, href: '/series/' + encodeURIComponent(t.name),
    chars: t.works.reduce((n, w) => n + countChars(w.body), 0)
  };
}

function singleItem(w) {
  return { name: w.title, count: 1, href: '/w/' + encodeURIComponent(w.id), chars: countChars(w.body) };
}

function sectionHead(title, count) {
  return `<div class="section-head"><h2>${title}</h2><span class="count">${count}</span></div>`;
}
function shelfOf(cards) {
  return '<div class="shelf">' + cards.join('') + '</div><div class="shelf-board"></div>';
}
function bindModes() {
  $$('[data-mode]').forEach(b => b.addEventListener('click', () => {
    state.settings.shelfMode = b.dataset.mode;
    save();
    renderShelf();
  }));
  $$('[data-look]').forEach(b => b.addEventListener('click', () => {
    state.settings.shelfLook = b.dataset.look;
    save();
    renderShelf();
  }));
}

function seriesCard(s) {
  const spines = s.works.slice(0, 12).map((w, i) =>
    `<span class="spine" style="height:${26 + (hue(w.title) % 18)}px;background:${spineColor(s.name, i)}"></span>`).join('');
  const summary = s.works.find(w => w.summary)?.summary || '';
  return `
    <button class="card series" data-go="/series/${encodeURIComponent(s.name)}">
      <span class="card-kicker">series &middot; 全${s.works.length}話</span>
      <span class="card-title">${esc(s.name)}</span>
      <span class="spines" aria-hidden="true">${spines}</span>
      ${summary ? `<span class="card-summary">${esc(summary)}</span>` : ''}
      <span class="card-meta"><span>最終更新 ${fmtDate(s.updatedAt)}</span><span>${fmtCount(s.works.reduce((n, w) => n + countChars(w.body), 0))}</span></span>
    </button>`;
}

function worldCard(t) {
  const rows = t.sections.map(sec => `
    <span><span class="pos">${esc(sec.kind)}</span><span class="nm">${esc(sec.works[0].title)}${sec.works.length > 1 ? ' ほか' + (sec.works.length - 1) + '編' : ''}</span></span>`).join('');
  return `
    <button class="card omnibus" data-go="/g/${encodeURIComponent(t.name)}">
      <span class="card-kicker">collection &middot; 全${t.works.length}編</span>
      <span class="card-title">${esc(t.name)}</span>
      <span class="chrono-mini">${rows}</span>
      <span class="card-meta"><span>最終更新 ${fmtDate(t.updatedAt)}</span><span>${fmtCount(t.works.reduce((n, w) => n + countChars(w.body), 0))}</span></span>
    </button>`;
}

function workCard(w, kicker) {
  return `
    <button class="card" data-go="/w/${encodeURIComponent(w.id)}">
      <span class="card-kicker">${esc(kicker || (w.series ? w.series : '単巻'))}</span>
      <span class="card-title">${esc(w.title)}</span>
      ${w.summary ? `<span class="card-summary">${esc(w.summary)}</span>` : ''}
      <span class="card-meta">
        <span>${fmtDate(w.updatedAt)}</span>
        <span>${fmtCount(countChars(w.body))}</span>
        ${w.tags.slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      </span>
    </button>`;
}

function bindCards() {
  $$('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
}

function renderSearch() {
  const hits = state.works.filter(w => matches(w, query))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  view().innerHTML = `
    <div class="section-head"><h2>検 索 目 録</h2><span class="count">「${esc(query)}」に ${hits.length} 件</span></div>
    ${hits.length
      ? '<div class="shelf">' + hits.map(w => workCard(w)).join('') + '</div><div class="shelf-board"></div>'
      : '<div class="empty"><div class="mark">❦</div><h2>該当する蔵書はありません</h2></div>'}`;
  bindCards();
}

/* ---------- シリーズ（目次） ---------- */
function renderSeries(name) {
  const works = state.works.filter(w => w.series === name).sort(sortInSeries);
  if (!works.length) return go('/');
  const total = works.reduce((n, w) => n + countChars(w.body), 0);
  const lede = works.find(w => w.summary)?.summary || '';

  view().innerHTML = `
    <div class="breadcrumb"><button data-go="/">書架</button> ／ 連作</div>
    <div class="plate">
      <div class="stamp">蔵書<br>SERIES</div>
      <h1>${esc(name)}</h1>
      ${lede ? `<p class="lede">${esc(lede)}</p>` : ''}
      <p class="meta">全 ${works.length} 話 &middot; ${fmtCount(total)} &middot; 最終更新 ${fmtDate(Math.max(...works.map(w => w.updatedAt)))}</p>
    </div>
    <div class="section-head"><h2>目 次</h2><span class="count">contents</span></div>
    <ul class="toc">
      ${works.map((w, i) => `
        <li><button data-go="/w/${encodeURIComponent(w.id)}">
          <span class="num">${w.order != null ? '第' + w.order + '話' : String(i + 1).padStart(2, '0')}</span>
          <span class="ttl">${esc(w.title)}</span>
          <span class="sub">${fmtCount(countChars(w.body))}</span>
        </button></li>`).join('')}
    </ul>
    <div class="form-actions" style="margin-top:22px">
      <button class="btn" onclick="location.hash='/new'">この連作に続きを納める</button>
      <span class="spacer"></span>
      <button class="btn ghost" id="share-series">この連作を共有URLにする</button>
    </div>`;
  bindCards();
  $('#share-series').addEventListener('click', () => shareDialog(works, name));
}

/* ---------- 叢書（まとまり） ---------- */
function renderWorld(name) {
  const sections = worldSections(name);
  const works = sections.flatMap(sec => sec.works);
  if (!works.length) return go('/');
  const total = works.reduce((n, w) => n + countChars(w.body), 0);
  const lede = works.find(w => w.summary)?.summary || '';

  view().innerHTML = `
    <div class="breadcrumb"><button data-go="/">書架</button> ／ 叢書</div>
    <div class="plate">
      <div class="stamp">叢書<br>COLLECTION</div>
      <h1>${esc(name)}</h1>
      ${lede ? `<p class="lede">${esc(lede)}</p>` : ''}
      <p class="meta">全 ${works.length} 編 &middot; ${sections.map(sec => esc(sec.kind) + ' ' + sec.works.length).join(' ／ ')} &middot; ${fmtCount(total)}</p>
    </div>
    ${sections.map(sec => `
      <div class="section-head sub"><h2>${esc(sec.kind)}</h2><span class="count">${sec.works.length} 編</span></div>
      <ul class="toc">
        ${sec.works.map((w, i) => `
          <li><button data-go="/w/${encodeURIComponent(w.id)}">
            <span class="num">${w.order != null ? '第' + w.order + '話' : (w.pos != null ? esc(String(w.pos)) : String(i + 1).padStart(2, '0'))}</span>
            <span class="stack-t">
              <span class="ttl">${esc(w.title)}</span>
              <span class="sub-inline">${w.series ? esc(w.series) : '単巻'} &middot; ${fmtCount(countChars(w.body))}</span>
            </span>
          </button></li>`).join('')}
      </ul>`).join('')}
    <div class="form-actions" style="margin-top:24px">
      <button class="btn" onclick="location.hash='/new'">この叢書に一編を加える</button>
      <span class="spacer"></span>
      <button class="btn ghost" id="share-world">この叢書を共有URLにする</button>
    </div>`;
  bindCards();
  $('#share-world').addEventListener('click', () => shareDialog(works, name));
}

/* ---------- 閲覧 ---------- */
function renderReader(id) {
  const w = state.works.find(x => x.id === id);
  if (!w) return go('/');
  const useWorld = state.settings.shelfMode === 'world' && w.world;
  const sib = useWorld
    ? worldSequence(w.world)
    : (w.series ? state.works.filter(x => x.series === w.series).sort(sortInSeries) : [w]);
  const idx = sib.findIndex(x => x.id === w.id);
  const prev = sib[idx - 1], next = sib[idx + 1];
  const t = state.settings.tategaki;

  view().innerHTML = `
    <div class="breadcrumb">
      <button data-go="/">書架</button> ／
      ${useWorld
        ? `<button data-go="/g/${encodeURIComponent(w.world)}">${esc(w.world)}</button> ／ `
        : (w.series ? `<button data-go="/series/${encodeURIComponent(w.series)}">${esc(w.series)}</button> ／ ` : '')}
      閲覧
    </div>
    <div class="reader-bar">
      <button class="chip" id="tate" aria-pressed="${t}">縦書き</button>
      <button class="chip" id="smaller">小</button>
      <button class="chip" id="bigger">大</button>
      ${w.world ? `<button class="chip" data-go="/g/${encodeURIComponent(w.world)}">叢書：${esc(w.world)}${w.kind ? '（' + esc(w.kind) + '）' : ''}</button>` : ''}
      <span class="spacer"></span>
      <button class="chip" data-go="/edit/${encodeURIComponent(w.id)}">手を入れる</button>
      <button class="chip" id="share-one">共有URL</button>
    </div>
    <article class="paper">
      ${w.series ? `<div class="byline">${esc(w.series)}${w.order != null ? ' ・ 第' + w.order + '話' : ''}</div>` : ''}
      <h1 class="title">${esc(w.title)}</h1>
      <div class="byline">${w.author ? esc(w.author) + ' &middot; ' : ''}${fmtDate(w.updatedAt)} &middot; ${fmtCount(countChars(w.body))}</div>
      ${w.summary ? `<div class="divider"></div><p class="card-summary" style="-webkit-line-clamp:99;font-size:14px">${esc(w.summary)}</p>` : ''}
      <div class="divider"></div>
      <div class="body ${t ? 'tategaki' : ''}" id="bodyEl" style="--reading-size:${state.settings.size}px">${renderBody(w.body)}</div>
    </article>
    <div class="form-actions" style="margin-top:20px">
      ${prev ? `<button class="btn ghost" data-go="/w/${encodeURIComponent(prev.id)}">◀ ${esc(prev.title)}</button>` : ''}
      <span class="spacer"></span>
      ${next ? `<button class="btn ghost" data-go="/w/${encodeURIComponent(next.id)}">${esc(next.title)} ▶</button>` : ''}
    </div>`;
  bindCards();

  $('#tate').addEventListener('click', () => {
    state.settings.tategaki = !state.settings.tategaki; save(); renderReader(id);
  });
  $('#bigger').addEventListener('click', () => {
    state.settings.size = Math.min(28, state.settings.size + 1); save();
    $('#bodyEl').style.setProperty('--reading-size', state.settings.size + 'px');
  });
  $('#smaller').addEventListener('click', () => {
    state.settings.size = Math.max(12, state.settings.size - 1); save();
    $('#bodyEl').style.setProperty('--reading-size', state.settings.size + 'px');
  });
  $('#share-one').addEventListener('click', () => shareDialog([w], w.title));

  const b = $('#bodyEl');
  if (state.settings.tategaki) {
    b.scrollLeft = b.scrollWidth;
    // 縦書きでは、縦のホイール操作をそのまま行送りに変える
    b.addEventListener('wheel', ev => {
      if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
      ev.preventDefault();
      b.scrollLeft -= ev.deltaY;
    }, { passive: false });
  }
  window.scrollTo(0, 0);
}

/* ---------- 編集 ---------- */
function renderEditor(id) {
  const w = id ? state.works.find(x => x.id === id) : null;
  if (id && !w) return go('/');
  const seriesNames = Array.from(new Set(state.works.map(x => x.series).filter(Boolean)));
  const worldNames = Array.from(new Set(state.works.flatMap(x => [x.world, x.series]).filter(Boolean)));
  const kindNames = Array.from(new Set([...KINDS, ...state.works.map(x => x.kind).filter(Boolean)]));

  view().innerHTML = `
    <div class="breadcrumb"><button data-go="/">書架</button> ／ ${w ? '改訂' : '収蔵'}</div>
    <div class="plate">
      <div class="stamp">${w ? '改訂<br>REVISED' : '受入<br>ACCESSION'}</div>
      <h1>${w ? '蔵書に手を入れる' : '新しい蔵書を納める'}</h1>
      <p class="meta">題名と本文だけでも構いません。あらすじと連作名を入れておくと、棚がきれいに揃います。</p>
    </div>
    <form class="form" id="f">
      <div class="field">
        <label for="f-title">題　名</label>
        <input id="f-title" value="${esc(w?.title || '')}" placeholder="例：灯台守の最後の手紙" required>
      </div>
      <div class="row2">
        <div class="field">
          <label for="f-series">連作名（シリーズ）</label>
          <input id="f-series" list="series-list" value="${esc(w?.series || '')}" placeholder="単発ならば空欄のまま">
          <datalist id="series-list">${seriesNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="f-order">連作内の順番（第◯話）</label>
          <input id="f-order" type="number" inputmode="numeric" value="${w?.order ?? ''}" placeholder="1">
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label for="f-world">叢書（まとまり）</label>
          <input id="f-world" list="world-list" value="${esc(w?.world || '')}" placeholder="本編も後日談もまとめる名前">
          <datalist id="world-list">${worldNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          <span class="hint">本編と、そのあとの後日談や日常の話に同じ名前を入れると、一つの棚にまとまります。</span>
        </div>
        <div class="field">
          <label for="f-kind">区　分</label>
          <input id="f-kind" list="kind-list" value="${esc(w?.kind || '')}" placeholder="本編／後日談／番外編…">
          <datalist id="kind-list">${kindNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          <span class="hint">叢書の中の見出しになります。空欄なら「本編」として扱います。</span>
        </div>
      </div>
      <div class="field">
        <label for="f-pos">叢書の中での並び順（任意）</label>
        <input id="f-pos" type="number" step="0.1" inputmode="decimal" value="${w?.pos ?? ''}" placeholder="1">
        <span class="hint">同じ区分の中での順番。空欄なら連作内の順番、それも無ければ収めた順に並びます。</span>
      </div>
      <div class="field">
        <label for="f-summary">あ ら す じ</label>
        <textarea id="f-summary" rows="3" placeholder="棚に並んだときに見える紹介文">${esc(w?.summary || '')}</textarea>
      </div>
      <div class="row2">
        <div class="field">
          <label for="f-author">著者・筆名</label>
          <input id="f-author" value="${esc(w?.author || '')}" placeholder="任意">
        </div>
        <div class="field">
          <label for="f-tags">分類票（タグ）</label>
          <input id="f-tags" value="${esc((w?.tags || []).join('、'))}" placeholder="幻想、書簡体、短編">
        </div>
      </div>
      <div class="field">
        <label for="f-body">本　文</label>
        <textarea id="f-body" rows="18" placeholder="ここに本文を貼り付けます。&#10;&#10;空行で段落、# で見出し、漢字《かんじ》でルビが振れます。">${esc(w?.body || '')}</textarea>
        <span class="hint">空行＝段落／「#」「##」＝見出し／「---」＝区切り／「漢字《かんじ》」＝ルビ／「**強調**」＝強調</span>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn primary">${w ? '改訂して納める' : '書架に納める'}</button>
        <button type="button" class="btn ghost" data-go="${w ? '/w/' + encodeURIComponent(w.id) : '/'}">やめる</button>
        <span class="spacer"></span>
        ${w ? '<button type="button" class="btn danger" id="del">除　籍</button>' : ''}
      </div>
    </form>`;
  bindCards();

  $('#f').addEventListener('submit', e => {
    e.preventDefault();
    const orderRaw = $('#f-order').value.trim();
    const posRaw = $('#f-pos').value.trim();
    const data = {
      id: w?.id,
      title: $('#f-title').value.trim() || '無題',
      series: $('#f-series').value.trim(),
      order: orderRaw === '' ? null : Number(orderRaw),
      world: $('#f-world').value.trim(),
      kind: $('#f-kind').value.trim(),
      pos: posRaw === '' ? null : Number(posRaw),
      summary: $('#f-summary').value.trim(),
      author: $('#f-author').value.trim(),
      tags: $('#f-tags').value.split(/[,、\s]+/).filter(Boolean),
      body: $('#f-body').value,
      createdAt: w?.createdAt,
      updatedAt: Date.now()
    };
    const rec = normalize(data);
    if (w) state.works[state.works.findIndex(x => x.id === w.id)] = rec;
    else state.works.push(rec);
    save();
    toast(w ? '改訂しました' : '書架に納めました');
    go('/w/' + encodeURIComponent(rec.id));
  });

  if (w) $('#del').addEventListener('click', () => {
    confirmDialog('この蔵書を除籍しますか', `「${w.title}」を書架から取り除きます。取り消せません。`, () => {
      state.works = state.works.filter(x => x.id !== w.id);
      save(); toast('除籍しました'); go('/');
    });
  });
}

/* =============================================================
   書庫（取り込み・書き出し・共有）
   ============================================================= */
function renderArchive() {
  const { series, singles } = groups();
  view().innerHTML = `
    <div class="breadcrumb"><button data-go="/">書架</button> ／ 書庫</div>
    <div class="plate">
      <div class="stamp">書庫<br>ARCHIVE</div>
      <h1>書　庫</h1>
      <p class="meta">蔵書 ${state.works.length} 冊（連作 ${series.length} ／ 単巻 ${singles.length}） &middot; 総計 ${fmtCount(state.works.reduce((n, w) => n + countChars(w.body), 0))}</p>
    </div>
    <div class="stack">
      <div class="panel">
        <h3>取 り 込 み</h3>
        <p>Claude との会話で書いた小説を、そのまま貼り付けてください。本文でも、書き出したJSONでも、共有URLでも受け付けます。</p>
        <div class="btnrow">
          <button class="btn primary" id="imp-paste">貼り付けて取り込む</button>
          <button class="btn" id="imp-file">JSONファイルから取り込む</button>
        </div>
      </div>
      <div class="panel">
        <h3>書 き 出 し</h3>
        <p>書架ごとJSONに保存しておけば、別の端末や新しいブラウザでも同じ棚を組み直せます。</p>
        <div class="btnrow">
          <button class="btn" id="exp-json">JSONで保存する</button>
          <button class="btn" id="exp-url">書架まるごとの共有URLを作る</button>
        </div>
      </div>
      <div class="panel">
        <h3>Claude に 渡 す 覚 書</h3>
        <p>下の文をチャットに貼っておくと、Claude がこの書架に取り込める形で小説を書き出してくれます。</p>
        <div class="mono" id="promptText">${esc(CLAUDE_PROMPT)}</div>
        <div class="btnrow" style="margin-top:10px">
          <button class="btn ghost" id="copy-prompt">この覚書を写す</button>
        </div>
      </div>
      <div class="panel">
        <h3>始 末</h3>
        <p>この端末に保管された蔵書をすべて消します。書き出しを済ませてからどうぞ。</p>
        <div class="btnrow"><button class="btn danger" id="wipe">書架を空にする</button></div>
      </div>
    </div>`;
  bindCards();

  $('#imp-paste').addEventListener('click', () => importDialog());
  $('#imp-file').addEventListener('click', importFile);
  $('#exp-json').addEventListener('click', exportJSON);
  $('#exp-url').addEventListener('click', () => shareDialog(state.works, '書架まるごと'));
  $('#copy-prompt').addEventListener('click', () => copy(CLAUDE_PROMPT, '覚書を写しました'));
  $('#wipe').addEventListener('click', () => {
    confirmDialog('書架を空にしますか', 'この端末の蔵書がすべて失われます。取り消せません。', () => {
      state.works = []; save(); toast('書架を空にしました'); go('/');
    });
  });
}

const CLAUDE_PROMPT = `これまで書いた小説を、次のJSON形式だけで出力してください（説明文なし・コードブロック内）。
{"works":[{"title":"題名","series":"連作名(なければ空文字)","order":1,"world":"叢書名(任意。後日談も同じ名にする)","kind":"本編/後日談/番外編(任意)","pos":1,"summary":"あらすじ","tags":["タグ"],"body":"本文。段落は空行、見出しは # 、ルビは 漢字《かんじ》"}]}`;

/* ---------- 取り込み ---------- */
function importDialog(prefill) {
  const el = dialog(`
    <h3>貼り付けて取り込む</h3>
    <p>小説の本文、書き出したJSON、共有URLのいずれでも構いません。</p>
    <div class="field">
      <textarea id="imp-text" rows="10" placeholder="ここに貼り付けます">${esc(prefill || '')}</textarea>
    </div>
    <div class="field">
      <label style="display:flex;gap:8px;align-items:center;font-family:var(--sans);cursor:pointer">
        <input type="checkbox" id="imp-split" style="width:auto"> 本文中の「##」見出しごとに、別の話として分ける
      </label>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="imp-ok">取り込む</button>
      <button class="btn ghost" data-close>やめる</button>
    </div>`);
  $('#imp-ok', el).addEventListener('click', async () => {
    const text = $('#imp-text', el).value.trim();
    if (!text) return;
    const split = $('#imp-split', el).checked;
    try {
      const works = await parseImport(text, split);
      if (!works.length) return toast('取り込めるものが見つかりませんでした');
      mergeWorks(works);
      closeDialog();
      toast(works.length + ' 件を取り込みました');
      go('/');
      render();
    } catch (e) { console.error(e); toast('取り込みに失敗しました'); }
  });
}

async function parseImport(text, split) {
  // 1) 共有URL / 共有コード
  const m = text.match(/#import=([A-Za-z0-9_\-]+)/) || (/^[01][A-Za-z0-9_\-]{20,}$/.test(text.trim()) ? [null, text.trim()] : null);
  if (m) {
    const data = await decodePayload(m[1]);
    if (data?.works) return data.works.map(normalize);
  }
  // 2) JSON
  const jsonSrc = extractJSON(text);
  if (jsonSrc) {
    try {
      const data = JSON.parse(jsonSrc);
      const arr = Array.isArray(data) ? data : (data.works || (data.title ? [data] : null));
      if (arr) return arr.map(normalize);
    } catch (e) { /* 本文として扱う */ }
  }
  // 3) 素の本文
  return parseProse(text, split);
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = (fence ? fence[1] : text).trim();
  if (src.startsWith('{') || src.startsWith('[')) return src;
  const i = src.search(/[{[]/);
  if (i >= 0 && /"(works|title|body)"/.test(src)) return src.slice(i);
  return null;
}

function parseProse(text, split) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/```[a-z]*\n?/g, '').trim();
  const lines = clean.split('\n');
  let seriesTitle = '', start = 0;
  const h1 = lines.findIndex(l => /^#\s+\S/.test(l));
  if (h1 === 0) { seriesTitle = lines[0].replace(/^#\s+/, '').trim(); start = 1; }

  const rest = lines.slice(start).join('\n').trim();

  if (split) {
    const parts = rest.split(/\n(?=##\s+)/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts.map((p, i) => {
        const t = p.match(/^##\s+(.*)$/m);
        return normalize({
          title: t ? t[1].trim() : `第${i + 1}話`,
          series: seriesTitle,
          order: i + 1,
          body: p.replace(/^##\s+.*$/m, '').trim(),
          createdAt: Date.now() + i
        });
      });
    }
  }
  const title = seriesTitle || (rest.match(/^##\s+(.*)$/m)?.[1] || rest.split('\n')[0] || '無題').slice(0, 60).trim();
  return [normalize({ title, body: seriesTitle ? rest : rest, createdAt: Date.now() })];
}

function mergeWorks(works) {
  for (const w of works) {
    const i = state.works.findIndex(x => x.id === w.id);
    if (i >= 0) state.works[i] = w; else state.works.push(w);
  }
  save();
}

function importFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.txt,.md,application/json,text/plain';
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    const text = await f.text();
    const works = await parseImport(text, false);
    if (!works.length) return toast('取り込めるものが見つかりませんでした');
    mergeWorks(works);
    toast(works.length + ' 件を取り込みました');
    render();
  });
  input.click();
}

/* ---------- 書き出し ---------- */
function exportJSON() {
  const blob = new Blob([JSON.stringify({ works: state.works, exportedAt: new Date().toISOString() }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `書架_${fmtDate(Date.now()).replace(/\./g, '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('JSONを書き出しました');
}

/* ---------- 共有URL（gzip + base64url をハッシュに載せる） ---------- */
const b64u = {
  enc(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
};

async function encodePayload(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('gzip');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return '1' + b64u.enc(new Uint8Array(buf));
  }
  return '0' + b64u.enc(bytes);
}

async function decodePayload(payload) {
  const flag = payload[0];
  const bytes = b64u.dec(payload.slice(1));
  if (flag === '1') {
    const ds = new DecompressionStream('gzip');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(buf));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function shareDialog(works, label) {
  const payload = await encodePayload({ v: 1, works });
  const base = location.origin + location.pathname;
  const url = base + '#import=' + payload;
  const long = url.length > 12000;

  const el = dialog(`
    <h3>共有URL — ${esc(label)}</h3>
    <p>このURLの中に本文そのものが入っています。チャットや自分宛のメモに貼っておけば、開くだけで書架に戻せます。${long ? '<br><strong>※ 長すぎて一部の場所に貼れないことがあります。JSON書き出しの併用をおすすめします。</strong>' : ''}</p>
    <div class="mono" id="urlbox">${esc(url)}</div>
    <p style="margin-top:8px">${works.length} 件 &middot; ${url.length.toLocaleString()} 文字</p>
    <div class="form-actions">
      <button class="btn primary" id="cp">URLを写す</button>
      <button class="btn ghost" id="cp2">JSONを写す</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-close>閉じる</button>
    </div>`);
  $('#cp', el).addEventListener('click', () => copy(url, 'URLを写しました'));
  $('#cp2', el).addEventListener('click', () => copy(JSON.stringify({ works }, null, 1), 'JSONを写しました'));
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || '写しました');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast(msg || '写しました');
  }
}

/* =============================================================
   ダイアログ
   ============================================================= */
function dialog(html) {
  const layer = $('#dialog-layer');
  layer.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`;
  const overlay = $('.overlay', layer);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
  $$('[data-close]', layer).forEach(b => b.addEventListener('click', closeDialog));
  document.addEventListener('keydown', escClose);
  return layer;
}
function closeDialog() {
  $('#dialog-layer').innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeDialog(); }

function confirmDialog(title, msg, onOk) {
  const el = dialog(`
    <h3>${esc(title)}</h3>
    <p>${esc(msg)}</p>
    <div class="form-actions">
      <button class="btn danger" id="ok">はい</button>
      <button class="btn ghost" data-close>いいえ</button>
    </div>`);
  $('#ok', el).addEventListener('click', () => { closeDialog(); onOk(); });
}

/* =============================================================
   起動
   ============================================================= */
function updateStat() {
  const n = state.works.length;
  const c = state.works.reduce((s, w) => s + countChars(w.body), 0);
  $('#stat').textContent = n ? `蔵書 ${n} 冊 ・ ${fmtCount(c)}` : '蔵書 0 冊';
}

function render() {
  route();
  updateStat();
  const h = location.hash.replace(/^#/, '');
  $('#btn-home').hidden = (h === '' || h === '/');
  document.body.dataset.view = h.startsWith('/w/') ? 'reader' : 'shelf';
}

async function handleImportHash() {
  const m = location.hash.match(/^#import=([A-Za-z0-9_\-]+)$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search + '#/');
  try {
    const data = await decodePayload(m[1]);
    const works = (data.works || []).map(normalize);
    if (!works.length) return false;
    const known = works.filter(w => state.works.some(x => x.id === w.id)).length;
    confirmDialog(
      'このURLに蔵書が入っています',
      `${works.length} 件（${works.map(w => w.title).slice(0, 3).join('、')}${works.length > 3 ? ' ほか' : ''}）を書架に納めますか。${known ? `うち ${known} 件は同じ蔵書として上書きされます。` : ''}`,
      () => { mergeWorks(works); toast(works.length + ' 件を納めました'); render(); }
    );
    return true;
  } catch (e) {
    console.error(e);
    toast('URLの中身を読み取れませんでした');
    return false;
  }
}

function init() {
  load();
  $('#btn-new').addEventListener('click', () => go('/new'));
  $('#btn-archive').addEventListener('click', () => go('/archive'));
  $('#btn-home').addEventListener('click', () => {
    $('#search').value = '';
    query = '';
    go('/');
    render();
  });
  $('#search').addEventListener('input', e => {
    query = e.target.value.trim();
    if (location.hash && location.hash !== '#/' && location.hash !== '') { location.hash = '/'; }
    else renderShelf();
  });
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#import=')) { handleImportHash(); return; }
    render();
  });

  // 二本指・ダブルタップでの拡大は切る（文字の大小は閲覧画面の「小／大」で変える）
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
    document.addEventListener(t, e => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredInstall = e; $('#btn-install').hidden = false;
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null; $('#btn-install').hidden = true;
  });

  handleImportHash().then(handled => { if (!handled) render(); else updateStat(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW登録に失敗', e));
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
