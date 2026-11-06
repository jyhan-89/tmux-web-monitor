'use strict';

const base = location.pathname.replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const narrow = matchMedia('(max-width: 768px)');
const toLogin = () => location.replace(`${base}/login`);

const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const STATE_LABEL = { working: '작업 중', waiting: '확인 필요', idle: '대기', running: '실행 중', shell: '셸', sleeping: '쉬는 중' };

let sessions = [];
let groups = [];
let companies = [];
let companyMaker = false;
let sectionMaker = false;
let sortMode = LS.get('sort', 'name-asc');
const collapsedGroups = new Set(LS.get('collapsedGroups', []));
const conns = new Map();
let activeName = null;
const SESSION_MIME = 'application/x-tmux-session';
let tree = null;
let desks = [{ name: '', tree: null, active: null }];
let deskIdx = 0;
let layoutKey = '';
let fontSize = +LS.get('fontSize', narrow.matches ? 12 : 14);
let imeOn = true;
let ctrlArmed = false;
let config = { snippets: [] };

const active = () => conns.get(activeName) || null;

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${path}`, opts);
  if (res.status === 401) { toLogin(); throw new Error('로그인이 필요합니다'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    const err = new Error(typeof d === 'string' ? d : (d ? JSON.stringify(d) : res.statusText));
    err.status = res.status;
    throw err;
  }
  return data;
}

function ago(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${Math.max(s, 0)}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

const shortPath = (p) => p.split('/').filter(Boolean).slice(-2).join('/') || '/';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    (document.querySelector('dialog[open]') || document.body).appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function keepFocus(el) {
  el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
}

async function refresh() {
  try {
    let co;
    [sessions, groups, co] = await Promise.all([api('GET', '/sessions'), api('GET', '/groups'), api('GET', '/companies')]);
    companies = co.companies;
    companyMaker = co.maker;
    sectionMaker = !!co.sectionMaker;
    $('newcompany').hidden = !companyMaker;
  } catch (e) {
    toast('목록 오류: ' + e.message);
    return;
  }
  renderList();
  renderTabs();
  renderWinbar();
  syncChats();
}

function sortSessions(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
  const cmp = {
    'name-asc': byName,
    'name-desc': (a, b) => byName(b, a),
    activity: (a, b) => b.activity - a.activity || byName(a, b),
    created: (a, b) => a.created - b.created || byName(a, b),
  }[sortMode] || byName;
  return [...list].sort(cmp);
}

function sortGroupNames(names) {
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  return sortMode === 'name-desc' ? sorted.reverse() : sorted;
}

function renderList() {
  if (drag) return;
  const ul = $('sessions');
  ul.innerHTML = '';
  const all = sortSessions(sessions);
  const known = new Set(companies.map((c) => c.name));
  const sorted = all.filter((s) => !known.has(s.company));
  renderCompanies(ul, all.filter((s) => known.has(s.company)));
  if (!groups.length) {
    for (const s of sorted) ul.appendChild(sessionItem(s, false));
    return;
  }
  assignGroupColors();
  const walk = (parent, depth) => {
    for (const g of sortGroupNames(groups.filter((x) => parentGroup(x) === parent))) {
      const all = sorted.filter((s) => s.group === g || s.group?.startsWith(`${g}/`));
      ul.appendChild(groupHeader(g, all, depth));
      if (collapsedGroups.has(g)) continue;
      for (const s of sorted.filter((x) => x.group === g)) ul.appendChild(sessionItem(s, true, depth + 1));
      walk(g, depth + 1);
    }
  };
  walk(null, 0);
  const loose = sorted.filter((s) => !s.group || !groups.includes(s.group));
  if (loose.length) {
    ul.appendChild(groupHeader(null, loose, 0));
    if (!collapsedGroups.has('')) for (const s of loose) ul.appendChild(sessionItem(s, true, 1));
  }
}

const COMPANY_COLORS = ['#f0b35a', '#5fd3d3', '#e88cc4', '#a3c46a', '#c792ea'];
const DEPT_ORDER = ['운영', '기능', '개발', '층', '검증'];

function renderCompanies(ul, members) {
  const names = new Set(companies.map((c) => c.name));
  const kids = (parent) => companies.filter((c) => (names.has(c.parent) ? c.parent : '') === parent);
  const color = (c) => COMPANY_COLORS[companies.indexOf(c) % COMPANY_COLORS.length];
  const below = (c) => [c.name, ...kids(c.name).flatMap(below)];
  const walk = (c, depth) => {
    const mine = members.filter((s) => s.company === c.name);
    const all = members.filter((s) => below(c).includes(s.company));
    ul.appendChild(companyHeader(c, all, color(c), depth));
    if (collapsedGroups.has(`co:${c.name}`)) return;
    const put = (s, d) => {
      const li = sessionItem(s, true, d);
      li.classList.add('ing');
      li.style.setProperty('--gc', color(c));
      ul.appendChild(li);
    };
    for (const s of mine.filter((x) => !x.dept)) put(s, depth + 1);
    const depts = [...new Set(mine.map((s) => s.dept).filter(Boolean))].sort((a, b) => {
      const ia = DEPT_ORDER.indexOf(a), ib = DEPT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ko');
    });
    for (const d of depts) {
      const ds = mine.filter((s) => s.dept === d);
      ul.appendChild(deptHeader(c.name, d, ds, color(c), depth + 1));
      if (!collapsedGroups.has(`co:${c.name}/${d}`)) for (const s of ds) put(s, depth + 2);
    }
    for (const k of kids(c.name)) walk(k, depth + 1);
  };
  for (const c of kids('')) walk(c, 0);
}

const kidsOf = (name) => companies.filter((c) => c.parent === name);

function stateDots(el, members) {
  for (const s of members) {
    if (s.state === 'working' || s.state === 'waiting') {
      const d = document.createElement('span');
      d.className = `dot st-${s.state}`;
      d.title = `${s.name}: ${STATE_LABEL[s.state]}`;
      el.appendChild(d);
    }
  }
}

function foldToggle(key) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
  LS.set('collapsedGroups', [...collapsedGroups]);
  renderList();
}

function companyHeader(c, members, color, depth = 0) {
  const key = `co:${c.name}`;
  const li = document.createElement('li');
  li.className = 'group company';
  if (depth) li.style.marginLeft = `${depth * 12}px`;
  li.style.setProperty('--gc', color);
  li.title = `저장소 ${c.repo}\n작업공간 ${c.ws}`;
  li.innerHTML = '<span class="gname"></span><span class="gdots"></span><span class="gcount"></span>';
  li.querySelector('.gname').textContent = `${collapsedGroups.has(key) ? '▸' : '▾'} ${kidsOf(c.name).length ? '🏛' : '🏢'} ${c.name}`;
  li.querySelector('.gcount').textContent = members.length;
  stateDots(li.querySelector('.gdots'), members);
  li.onclick = () => foldToggle(key);
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtx(e.clientX, e.clientY, [
      { label: collapsedGroups.has(key) ? '펼치기' : '접기', run: () => li.click() },
      ...(sectionMaker ? [{ label: '섹션 추가', run: () => openNewSection(c.name) }] : []),
      { label: '저장소 경로 복사', run: () => navigator.clipboard?.writeText(c.repo) },
      '-',
      { label: '회사 등록 해제 (세션은 유지)', danger: true, run: () => releaseCompany(c.name) },
    ]);
  });
  return li;
}

function deptHeader(company, dept, members, color, depth = 1) {
  const key = `co:${company}/${dept}`;
  const li = document.createElement('li');
  li.className = 'group sub dept';
  li.style.marginLeft = `${depth * 12}px`;
  li.style.setProperty('--gc', color);
  li.innerHTML = '<span class="gname"></span><span class="gdots"></span><span class="gcount"></span>';
  li.querySelector('.gname').textContent = `${collapsedGroups.has(key) ? '▸' : '▾'} ${dept}`;
  li.querySelector('.gcount').textContent = members.length;
  stateDots(li.querySelector('.gdots'), members);
  li.onclick = () => foldToggle(key);
  return li;
}

async function releaseCompany(name) {
  if (!confirm(`회사 '${name}' 등록을 해제할까요? 세션과 폴더는 그대로 두고 목록에서만 회사 묶음을 없앱니다.`)) return;
  try { await api('DELETE', `/companies/${enc(name)}`); } catch (e) { return toast(e.message); }
  refresh();
}

async function openNewCompany() {
  $('coerr').textContent = '';
  $('coout').hidden = true;
  $('coname').value = '';
  $('corepo').value = '';
  $('cook').disabled = false;
  try {
    const r = await api('GET', '/dirs');
    $('corepolist').innerHTML = '';
    for (const d of r.dirs) {
      const o = document.createElement('option');
      o.value = d;
      $('corepolist').appendChild(o);
    }
  } catch {}
  $('codlg').showModal();
  $('coname').focus();
}

$('newcompany').onclick = openNewCompany;

let sectionCompany = null;
function openNewSection(name) {
  sectionCompany = name;
  $('sctitle').textContent = `${name} 섹션 추가`;
  $('scerr').textContent = '';
  $('scout').hidden = true;
  $('scname').value = '';
  $('scpaths').value = '';
  $('scdept').value = '개발';
  $('scok').disabled = false;
  $('scdlg').showModal();
  $('scname').focus();
}

$('scform').onsubmit = async (e) => {
  e.preventDefault();
  const section = $('scname').value.trim();
  if (!section) return ($('scerr').textContent = '섹션 이름을 입력하세요');
  $('scok').disabled = true;
  $('scerr').textContent = '';
  $('scout').hidden = false;
  $('scout').textContent = '만드는 중… (작업 트리·요청함·카드를 준비하고 세션을 띄웁니다)';
  try {
    const r = await api('POST', `/companies/${enc(sectionCompany)}/sections`, { section, dept: $('scdept').value, paths: $('scpaths').value.trim() || null });
    $('scout').textContent = r.output || '완료';
    refresh();
  } catch (err) {
    $('scout').hidden = true;
    $('scerr').textContent = err.message;
  }
  $('scok').disabled = false;
};

$('coform').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('coname').value.trim(), repo = $('corepo').value.trim();
  if (!name || !repo) return ($('coerr').textContent = '회사 이름과 저장소 폴더를 입력하세요');
  $('cook').disabled = true;
  $('coerr').textContent = '';
  $('coout').hidden = false;
  $('coout').textContent = '만드는 중… (섹션 작업 폴더와 세션을 준비합니다)';
  try {
    const r = await api('POST', '/companies', { name, repo });
    $('coout').textContent = r.output || '완료';
    collapsedGroups.delete(`co:${name}`);
    refresh();
  } catch (err) {
    $('coout').hidden = true;
    $('coerr').textContent = err.message;
  }
  $('cook').disabled = false;
};

function parentGroup(g) {
  const i = g.lastIndexOf('/');
  return i < 0 ? null : g.slice(0, i);
}

const leafName = (g) => g.slice(g.lastIndexOf('/') + 1);

const GROUP_COLORS = ['#4f9cf9', '#4cc38a', '#f0b35a', '#c792ea', '#f07178', '#5fd3d3', '#e88cc4', '#a3c46a'];

const groupColorIdx = new Map();

function assignGroupColors() {
  groupColorIdx.clear();
  const n = GROUP_COLORS.length;
  const walk = (parent, pIdx) => {
    let ci = pIdx < 0 ? 0 : (pIdx + 1) % n;
    for (const g of sortGroupNames(groups.filter((x) => parentGroup(x) === parent))) {
      if (ci === pIdx) ci = (ci + 1) % n;
      groupColorIdx.set(g, ci);
      walk(g, ci);
      ci = (ci + 1) % n;
    }
  };
  walk(null, -1);
}

const groupColor = (g) => GROUP_COLORS[groupColorIdx.get(g) ?? 0];

function groupHeader(g, members, depth = 0) {
  const key = g ?? '';
  const li = document.createElement('li');
  li.className = 'group';
  li.dataset.group = key;
  li.style.marginLeft = `${depth * 12}px`;
  li.classList.toggle('sub', depth > 0);
  if (g) {
    li.title = g;
    li.style.setProperty('--gc', groupColor(g));
  }
  const folded = collapsedGroups.has(key);
  li.innerHTML = `<span class="gname"></span><span class="gdots"></span><span class="gcount"></span>
    ${g === null ? '' : '<button class="act grename" title="그룹 이름 바꾸기">✎</button><button class="act gdel" title="그룹 삭제">✕</button>'}`;
  li.querySelector('.gname').textContent = `${folded ? '▸' : '▾'} ${g === null ? '그룹 없음' : leafName(g)}`;
  li.querySelector('.gcount').textContent = members.length;
  const dots = li.querySelector('.gdots');
  for (const s of members) {
    if (s.state === 'working' || s.state === 'waiting') {
      const d = document.createElement('span');
      d.className = `dot st-${s.state}`;
      d.title = `${s.name}: ${STATE_LABEL[s.state]}`;
      dots.appendChild(d);
    }
  }
  li.onclick = () => {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
    LS.set('collapsedGroups', [...collapsedGroups]);
    renderList();
  };
  if (g !== null) {
    li.querySelector('.grename').onclick = (e) => { e.stopPropagation(); renameGroup(g); };
    li.querySelector('.gdel').onclick = (e) => { e.stopPropagation(); deleteGroup(g, members); };
  }
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      { label: g === null ? '새 세션' : '이 그룹에 새 세션', run: () => openNewSession({ group: g }) },
      { label: folded ? '펼치기' : '접기', run: () => li.click() },
    ];
    if (g !== null) {
      items.push(
        '-',
        { label: '하위 그룹 만들기', run: () => newSubGroup(g) },
        { label: '다른 그룹 안으로 옮기기', run: () => openGroupMove(g) },
        { label: '그룹 이름 바꾸기', run: () => renameGroup(g) },
        { label: '그룹 삭제', danger: true, run: () => deleteGroup(g, members) },
      );
    }
    openCtx(e.clientX, e.clientY, items);
  });
  return li;
}

function sessionItem(s, inGroup, depth = 0) {
  const li = document.createElement('li');
  if (depth) li.style.marginLeft = `${depth * 12}px`;
  li.classList.toggle('open', conns.has(s.name));
  li.classList.toggle('active', s.name === activeName);
  li.classList.toggle('ingroup', inGroup);
  if (groups.length) {
    li.dataset.group = s.group && groups.includes(s.group) ? s.group : '';
    if (li.dataset.group) {
      li.classList.add('ing');
      li.style.setProperty('--gc', groupColor(s.group));
    }
    enableDrag(li, s.name);
  } else if (matchMedia('(pointer: fine)').matches) {
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(SESSION_MIME, s.name);
      e.dataTransfer.setData('text/plain', s.name);
      e.dataTransfer.effectAllowed = 'move';
    });
  }
  li.innerHTML = `
    <div class="row"><span class="dot"></span><span class="name"></span><span class="badge"></span>
      <button class="act move" title="그룹으로 이동">📁</button><button class="act rename" title="이름 바꾸기">✎</button><button class="act kill" title="세션 종료">✕</button></div>
    <div class="preview"></div><div class="meta"></div>`;
  const dot = li.querySelector('.dot');
  dot.classList.toggle('on', s.attached > 0);
  dot.title = `접속한 클라이언트 ${s.attached}`;
  li.querySelector('.name').textContent = s.name;
  li.querySelector('.name').classList.toggle('claude', !!s.claude);
  li.querySelector('.name').classList.toggle('sleeping', !!s.sleeping);
  if (s.sleeping) li.querySelector('.name').title = '쉬는 중 — 입력하면 깨어납니다';
  const badge = li.querySelector('.badge');
  if (s.state) {
    badge.className = `badge st-${s.state}`;
    badge.textContent = STATE_LABEL[s.state];
  } else {
    badge.remove();
  }
  const pv = li.querySelector('.preview');
  pv.classList.toggle('said', !!s.claude);
  for (const line of s.preview || []) {
    const d = document.createElement('div');
    d.textContent = line;
    pv.appendChild(d);
  }
  if (!pv.childElementCount) pv.remove();
  const meta = li.querySelector('.meta');
  meta.textContent = `${shortPath(s.path)} · 창 ${s.window_count} · ${ago(s.activity)}`;
  meta.title = s.path;

  li.onclick = () => openSession(s.name);
  li.querySelector('.rename').onclick = (e) => { e.stopPropagation(); renameSession(s.name); };
  li.querySelector('.kill').onclick = (e) => { e.stopPropagation(); killSession(s.name); };
  li.querySelector('.move').onclick = (e) => { e.stopPropagation(); openMove(s); };
  li.addEventListener('contextmenu', (e) => {
    if (drag) return;
    e.preventDefault();
    e.stopPropagation();
    openCtx(e.clientX, e.clientY, sessionMenu(s));
  });
  return li;
}

function openFilesAt(path) {
  if (!confirmLeave()) return;
  $('files').hidden = false;
  setDrawer(false);
  fb.session = activeName;
  listDir(path || null);
}

function sessionMenu(s) {
  const items = [{ label: '열기', run: () => openSession(s.name) }];
  if (!narrow.matches) {
    items.push({
      label: '오른쪽에 분할해서 열기',
      run: () => {
        setDrawer(false);
        const g = groupOf(activeName);
        if (!g || s.name === activeName) return openSession(s.name);
        placeSession(s.name, g.gid, 'right');
      },
    });
  }
  items.push(
    '-',
    { label: '이 폴더에서 새 세션', run: () => openNewSession({ dir: s.path, group: s.group || null }) },
    { label: '파일 탐색에서 열기', disabled: !s.path, run: () => openFilesAt(s.path) },
    { label: '경로 복사', disabled: !s.path, run: () => copyText(s.path).then((ok) => toast(ok ? '경로를 복사했습니다' : '복사 실패')) },
    '-',
    { label: '이름 바꾸기', run: () => renameSession(s.name) },
    { label: '그룹으로 이동', run: () => openMove(s) },
  );
  if (conns.has(s.name)) items.push({ label: '탭 닫기 (세션 유지)', run: () => closeSession(s.name) });
  if (s.section) {
    items.push('-', { label: s.sleeping ? '쉬는 중 (입력하면 깨어남)' : 'Claude 닫기 (쉬게 하기)', disabled: s.sleeping, run: () => killSession(s.name) },
      { label: '지난 대화 보기', run: () => openConversations(s.name) },
      { label: '섹션 삭제…', danger: true, run: () => deleteSection(s.name) });
    return items;
  }
  items.push('-', { label: '세션 종료', danger: true, run: () => killSession(s.name) });
  return items;
}

function listMenu() {
  return [
    { label: '새 세션', run: () => openNewSession() },
    { label: '새 그룹', run: () => $('newgroup').click() },
    ...(companyMaker ? [{ label: '새 AI 회사', run: openNewCompany }] : []),
    { label: '세션 저장 / 복원', run: openPersist },
    '-',
    ...chatDefaultMenu(),
    '-',
    { label: '새로고침', run: refresh },
  ];
}

$('sessions').addEventListener('contextmenu', (e) => {
  if (e.target.closest('li')) return;
  e.preventDefault();
  openCtx(e.clientX, e.clientY, listMenu());
});

$('sort').value = sortMode;
$('sort').onchange = () => {
  sortMode = $('sort').value;
  LS.set('sort', sortMode);
  renderList();
};

async function createGroup(name) {
  await api('POST', '/groups', { name });
  collapsedGroups.delete(name);
}

$('newgroup').onclick = async () => {
  const name = prompt('새 그룹 이름 (하위 그룹은 상위/하위)');
  if (!name?.trim()) return;
  try { await createGroup(name.trim()); } catch (e) { return toast(e.message); }
  refresh();
};

async function moveGroupTo(g, target) {
  if (target === g || target?.startsWith(`${g}/`)) return toast('그룹을 자기 하위 그룹 안으로 옮길 수 없습니다');
  const dest = target ? `${target}/${leafName(g)}` : leafName(g);
  if (dest === g) return true;
  try {
    await api('PATCH', `/groups/${enc(g)}`, { new_name: dest });
  } catch (e) {
    toast(e.message);
    return false;
  }
  for (const k of [...collapsedGroups]) {
    if (k === g || k.startsWith(`${g}/`)) {
      collapsedGroups.delete(k);
      collapsedGroups.add(dest + k.slice(g.length));
    }
  }
  LS.set('collapsedGroups', [...collapsedGroups]);
  refresh();
  return true;
}

async function renameGroup(g) {
  const name = prompt('그룹 이름 바꾸기', leafName(g));
  if (!name?.trim() || name.trim() === leafName(g)) return;
  if (name.includes('/')) return toast("이름에 '/'는 쓸 수 없습니다. 위치를 바꾸려면 '다른 그룹 안으로 옮기기'를 쓰세요", 4000);
  const parent = parentGroup(g);
  const dest = parent ? `${parent}/${name.trim()}` : name.trim();
  try {
    await api('PATCH', `/groups/${enc(g)}`, { new_name: dest });
  } catch (e) {
    return toast(e.message);
  }
  for (const k of [...collapsedGroups]) {
    if (k === g || k.startsWith(`${g}/`)) {
      collapsedGroups.delete(k);
      collapsedGroups.add(dest + k.slice(g.length));
    }
  }
  LS.set('collapsedGroups', [...collapsedGroups]);
  refresh();
}

async function newSubGroup(parent) {
  const name = prompt(`'${leafName(parent)}' 안에 만들 하위 그룹 이름`);
  if (!name?.trim()) return;
  if (name.includes('/')) return toast("이름에 '/'는 쓸 수 없습니다", 3000);
  try { await createGroup(`${parent}/${name.trim()}`); } catch (e) { return toast(e.message); }
  collapsedGroups.delete(parent);
  LS.set('collapsedGroups', [...collapsedGroups]);
  refresh();
}

let deletingGroup = null;

async function deleteGroup(g, members) {
  if (!members.length) {
    const subs = groups.filter((x) => x.startsWith(`${g}/`)).length;
    if (!confirm(`'${leafName(g)}' 그룹${subs ? `과 하위 그룹 ${subs}개` : ''}를 삭제할까요?`)) return;
    return removeGroup(g, false);
  }
  deletingGroup = { g, members };
  const subs = groups.filter((x) => x.startsWith(`${g}/`)).length;
  $('groupdeltitle').textContent = `'${leafName(g)}' 그룹 삭제`;
  $('groupdelmsg').textContent =
    `${subs ? `하위 그룹 ${subs}개도 함께 삭제됩니다. ` : ''}이 그룹${subs ? '과 하위 그룹' : ''}에 세션 ${members.length}개가 있습니다 (${members.map((s) => s.name).join(', ')}). 세션을 어떻게 할까요?`;
  $('groupdeldlg').showModal();
}

async function removeGroup(g, kill) {
  try {
    const r = await api('DELETE', `/groups/${enc(g)}?kill=${kill}`);
    for (const name of r.killed || []) closeSession(name, true);
    if (r.failed?.length) toast(`종료 실패: ${r.failed.join(', ')}`, 4000);
    else if (kill) toast(`세션 ${r.killed.length}개를 종료했습니다`);
  } catch (e) {
    toast(e.message);
  }
  for (const k of [...collapsedGroups]) if (k === g || k.startsWith(`${g}/`)) collapsedGroups.delete(k);
  LS.set('collapsedGroups', [...collapsedGroups]);
  refresh();
}

$('groupdelkeep').onclick = () => {
  $('groupdeldlg').close();
  if (deletingGroup) removeGroup(deletingGroup.g, false);
};
$('groupdelkill').onclick = () => {
  const { g, members } = deletingGroup || {};
  if (!g) return;
  if (!confirm(`세션 ${members.length}개를 정말 종료할까요? 실행 중인 작업이 모두 종료됩니다.`)) return;
  $('groupdeldlg').close();
  removeGroup(g, true);
};

let movingSession = null;

function groupTreeOrder() {
  const out = [];
  const walk = (parent) => {
    for (const g of sortGroupNames(groups.filter((x) => parentGroup(x) === parent))) {
      out.push(g);
      walk(g);
    }
  };
  walk(null);
  return out;
}

function moveButton(label, depth, current, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.paddingLeft = `${12 + depth * 16}px`;
  if (current) b.className = 'cur';
  b.onclick = onClick;
  return b;
}

function openGroupMove(g) {
  movingSession = null;
  movingGroup = g;
  $('movetitle').textContent = `'${leafName(g)}' 그룹 옮기기`;
  const box = $('movelist');
  box.innerHTML = '';
  box.appendChild(moveButton('최상위', 0, parentGroup(g) === null, () => moveGroupHere(null)));
  for (const t of groupTreeOrder()) {
    if (t === g || t.startsWith(`${g}/`)) continue;
    box.appendChild(moveButton(`📁 ${leafName(t)}`, t.split('/').length, parentGroup(g) === t, () => moveGroupHere(t)));
  }
  $('movenew').value = '';
  $('movenew').placeholder = '새 그룹 이름 (만들고 그 안으로 옮김)';
  $('movedlg').showModal();
}

async function moveGroupHere(target) {
  if (await moveGroupTo(movingGroup, target)) $('movedlg').close();
}

let movingGroup = null;

function openMove(s) {
  movingSession = s.name;
  movingGroup = null;
  $('movenew').placeholder = '새 그룹 이름 (하위 그룹은 상위/하위)';
  $('movetitle').textContent = `'${s.name}' 그룹 이동`;
  const box = $('movelist');
  box.innerHTML = '';
  for (const g of groupTreeOrder()) {
    box.appendChild(moveButton(`📁 ${leafName(g)}`, g.split('/').length - 1, s.group === g, () => moveTo(g)));
  }
  box.appendChild(moveButton('그룹 없음', 0, !s.group || !groups.includes(s.group), () => moveTo(null)));
  $('movenew').value = '';
  $('movedlg').showModal();
}

async function moveSession(name, g) {
  try {
    await api('PUT', `/sessions/${enc(name)}/group`, { group: g });
  } catch (e) {
    toast(e.message);
    return false;
  }
  if (g !== null) {
    collapsedGroups.delete(g);
    LS.set('collapsedGroups', [...collapsedGroups]);
  }
  refresh();
  return true;
}

async function moveTo(g) {
  if (await moveSession(movingSession, g)) $('movedlg').close();
}

let drag = null;

function dropGroupAt(el) {
  const li = el?.closest?.('#sessions li');
  return li?.dataset.group;
}

function highlightDrop(key) {
  for (const h of document.querySelectorAll('#sessions li.group.droptarget')) h.classList.remove('droptarget');
  if (key === undefined) return;
  const header = [...document.querySelectorAll('#sessions li.group')].find((h) => h.dataset.group === key);
  header?.classList.add('droptarget');
}

function endDrag(drop) {
  const d = drag;
  drag = null;
  highlightDrop(undefined);
  $('dragghost')?.remove();
  d?.li.classList.remove('dragging');
  const current = sessions.find((s) => s.name === d?.name)?.group || '';
  if (drop && d && d.target !== undefined && d.target !== current) {
    moveSession(d.name, d.target === '' ? null : d.target).then((ok) => {
      if (ok) toast(`${d.name} → ${d.target || '그룹 없음'}`);
    });
  } else {
    renderList();
  }
}

function enableDrag(li, name) {
  li.classList.add('dnd');
  li.draggable = matchMedia('(pointer: fine)').matches;
  li.addEventListener('dragstart', (e) => {
    drag = { name, li, target: undefined };
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.setData(SESSION_MIME, name);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => { if (drag) endDrag(false); });

  let timer = null;
  let x0 = 0;
  let y0 = 0;
  li.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX;
    y0 = t.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => startTouchDrag(name, li, x0, y0), 450);
  }, { passive: true });
  li.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - x0, t.clientY - y0) > 10) clearTimeout(timer);
  }, { passive: true });
  li.addEventListener('touchend', () => clearTimeout(timer));
  li.addEventListener('touchcancel', () => clearTimeout(timer));
}

function startTouchDrag(name, li, x, y) {
  drag = { name, li, target: undefined };
  drawerX = null;
  li.classList.add('dragging');
  navigator.vibrate?.(30);
  const ghost = document.createElement('div');
  ghost.id = 'dragghost';
  ghost.textContent = `📁 ${name}`;
  document.body.appendChild(ghost);
  const list = $('sessions');

  const move = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    ghost.style.left = `${t.clientX}px`;
    ghost.style.top = `${t.clientY}px`;
    drag.target = dropGroupAt(document.elementFromPoint(t.clientX, t.clientY));
    highlightDrop(drag.target);
    const r = list.getBoundingClientRect();
    if (t.clientY < r.top + 40) list.scrollTop -= 12;
    else if (t.clientY > r.bottom - 40) list.scrollTop += 12;
  };
  const end = (e) => {
    e.preventDefault();
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', end);
    endDrag(e.type === 'touchend');
  };
  move({ preventDefault() {}, touches: [{ clientX: x, clientY: y }] });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', end, { passive: false });
}

$('sessions').addEventListener('dragover', (e) => {
  if (!drag) return;
  const key = dropGroupAt(e.target);
  if (key === undefined) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  drag.target = key;
  highlightDrop(key);
});
$('sessions').addEventListener('drop', (e) => {
  if (!drag) return;
  e.preventDefault();
  drag.target = dropGroupAt(e.target);
  endDrag(true);
});

$('moveform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('movenew').value.trim().replace(/^\/+|\/+$/g, '');
  if (!name) return;
  try { await createGroup(name); } catch (err) { return toast(err.message); }
  if (movingGroup) {
    await refresh();
    return moveGroupHere(name);
  }
  moveTo(name);
});

async function renameSession(name) {
  const newName = prompt('새 세션 이름', name);
  if (!newName || newName === name) return;
  try {
    await api('PATCH', `/sessions/${enc(name)}`, { new_name: newName });
  } catch (e) {
    return toast(e.message, 4000);
  }
  const conn = conns.get(name);
  if (conn) {
    conns.delete(name);
    conn.name = newName;
    conn.el.dataset.name = newName;
    conns.set(newName, conn);
    desks[deskIdx].tree = tree;
    for (const d of desks) {
      for (const g of leaves(d.tree)) {
        const i = g.tabs.indexOf(name);
        if (i >= 0) g.tabs[i] = newName;
        if (g.active === name) g.active = newName;
      }
      if (d.active === name) d.active = newName;
    }
    if (activeName === name) activeName = newName;
    saveTabs();
  }
  refresh();
}

const sessionOf = (name) => sessions.find((x) => x.name === name);

async function killSession(name) {
  if (sessionOf(name)?.section) {
    if (!confirm(`'${name}' 섹션의 Claude를 닫고 쉬게 할까요? 세션과 대화는 남고, 요청이 오거나 입력하면 이전 대화로 깨어납니다.`)) return;
    try { await api('DELETE', `/sessions/${enc(name)}`); toast('쉬는 중으로 바꿨습니다'); } catch (e) { toast(e.message); }
    return refresh();
  }
  if (!confirm(`'${name}' 세션을 종료할까요? 실행 중인 작업이 모두 종료됩니다.`)) return;
  closeSession(name, true);
  try { await api('DELETE', `/sessions/${enc(name)}`); } catch (e) { toast(e.message); }
  refresh();
}

async function deleteSection(name) {
  if (prompt(`섹션 '${name}' 을 섹션 DB에서 지우고 tmux 세션도 끕니다. 작업 폴더·브랜치·요청함은 남습니다.\n지우려면 섹션 이름을 입력하세요.`) !== name) return;
  closeSession(name, true);
  try { toast((await api('DELETE', `/sessions/${enc(name)}/section`)).message, 4000); } catch (e) { toast(e.message, 5000); }
  refresh();
}

async function wakeSection(name, text) {
  toast(`${name} 깨우는 중…`, 8000);
  try {
    await api('POST', `/sessions/${enc(name)}/wake`, { text });
    toast(`${name} 깨움 — 이전 대화로 이어서 처리합니다`, 4000);
  } catch (e) {
    return toast(`깨우기 실패: ${e.message}`, 5000);
  }
  const s = sessionOf(name);
  if (s) s.sleeping = false;
  const c = conns.get(name);
  if (c) { c.chat.conv = ''; c.chat.stick = true; setTimeout(() => pollChat(c), 3000); }
  refresh();
}

async function openConversations(name) {
  let list;
  try { list = await api('GET', `/sessions/${enc(name)}/conversations`); } catch (e) { return toast(e.message); }
  if (!list.length) return toast('저장된 대화가 없습니다');
  const fmt = (t) => new Date(t * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const items = list.map((v, i) => ({
    label: `${i === 0 ? '지금 대화 · ' : ''}${fmt(v.mtime)} · ${(v.size / 1048576).toFixed(1)}MB · ${v.first || v.sid.slice(0, 8)}`.slice(0, 90),
    run: () => showConversation(name, i === 0 ? '' : v.sid),
  }));
  const r = $('sessions').getBoundingClientRect();
  openCtx(r.left + 40, r.top + 80, items);
}

function showConversation(name, sid) {
  activate(name);
  const c = conns.get(name);
  if (!c) return;
  c.chat.conv = sid;
  c.chat.end = null;
  setChatView(name, true);
  pollChat(c);
  if (sid) toast('지난 대화 보기 — 입력하면 지금 대화로 돌아가 깨웁니다', 4000);
}

function saveTabs() {
  desks[deskIdx].tree = tree;
  desks[deskIdx].active = activeName;
  LS.set('openTabs', [...conns.keys()]);
  LS.set('desks', desks.map((d) => ({ name: d.name, tree: d.tree, active: d.active })));
  LS.set('deskIdx', deskIdx);
  scheduleAutoSave();
}

function openSession(name) {
  setDrawer(false);
  if (!conns.has(name)) conns.set(name, createConn(name));
  activate(name);
  saveTabs();
}

function createConn(name) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.name = name;
  const msg = document.createElement('div');
  msg.className = 'pane-msg';
  msg.hidden = true;
  const host = document.createElement('div');
  host.className = 'phost';
  const chatEl = document.createElement('div');
  chatEl.className = 'chat';
  chatEl.hidden = true;
  el.append(msg, host, chatEl);
  $('paneholder').appendChild(el);

  const term = new Terminal({
    cursorBlink: true, fontSize, scrollback: 5000,
    fontFamily: '"JetBrains Mono", "D2Coding", Menlo, Consolas, monospace',
    theme: { background: '#1e1f22' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  const conn = {
    name, el, msg, host, term, fit,
    ws: null, opened: false, closed: false, gone: false, scrolled: false,
    retry: 0, timer: null, lastRx: 0,
    chat: { el: chatEl, sid: null, start: 0, end: null, tools: new Map(), orphans: new Map(), timer: null, busy: false },
  };
  initChat(conn);
  conn.raw = (obj) => {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
  };
  conn.send = (obj) => {
    if (obj.type === 'input' && conn.scrolled) {
      conn.scrolled = false;
      conn.raw({ type: 'scroll-exit' });
    }
    conn.raw(obj);
  };

  term.onData((data) => conn.send({ type: 'input', data: applyCtrl(data) }));
  term.onResize(({ cols, rows }) => conn.raw({ type: 'resize', cols, rows }));
  term.attachCustomKeyEventHandler((e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) return false;
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) copyText(sel).then((ok) => toast(ok ? '복사했습니다' : '복사 실패'));
      return false;
    }
    return true;
  });
  el.addEventListener('mousedown', () => { if (activeName !== conn.name) activate(conn.name, false); });
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?' || activeName !== conn.name) return true;
    let text;
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    } catch {
      return true;
    }
    copyText(text).then((ok) => toast(ok ? `복사했습니다 (${text.length}자)` : '복사 실패: 브라우저가 클립보드 접근을 막았습니다', 1500));
    return true;
  });
  host.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    setTimeout(() => {
      const sel = term.getSelection();
      if (!sel || !sel.trim()) return;
      copyText(sel).then((ok) => {
        toast(ok ? `복사했습니다 (${sel.length}자)` : '복사 실패', 1200);
        if (ok) term.focus();
      });
    }, 0);
  });
  new ResizeObserver(() => fitConn(conn)).observe(el);
  makeBar(conn);

  connectWs(conn);
  return conn;
}

function ensureOpen(conn) {
  if (!conn.opened) {
    conn.term.open(conn.host);
    conn.opened = true;
  }
}

function fitConn(conn) {
  if (!conn.opened || !conn.el.clientWidth || !conn.el.clientHeight) return;
  try { conn.fit.fit(); } catch {}
}

function showMsg(conn, text) {
  conn.msg.textContent = text;
  conn.msg.hidden = !text;
}

function connectWs(conn) {
  clearTimeout(conn.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${base}/ws/${enc(conn.name)}`);
  ws.binaryType = 'arraybuffer';
  conn.ws = ws;

  ws.onopen = () => {
    conn.retry = 0;
    conn.gone = false;
    conn.lastRx = Date.now();
    conn.term.reset();
    showMsg(conn, '');
    fitConn(conn);
    conn.raw({ type: 'resize', cols: conn.term.cols, rows: conn.term.rows });
    renderTabs();
  };
  ws.onmessage = (ev) => {
    conn.lastRx = Date.now();
    if (ev.data.byteLength) conn.term.write(new Uint8Array(ev.data));
  };
  ws.onclose = (ev) => {
    if (conn.ws !== ws || conn.closed) return;
    conn.ws = null;
    renderTabs();
    if (ev.code === 4401) return toLogin();
    if (ev.code === 4404) {
      conn.gone = true;
      showMsg(conn, '세션이 없습니다 (종료되었거나 이름이 바뀜)');
      return;
    }
    scheduleReconnect(conn);
  };
}

function scheduleReconnect(conn) {
  const delay = Math.min(1000 * 2 ** conn.retry, 10000);
  conn.retry++;
  showMsg(conn, `연결 끊김 · ${Math.round(delay / 1000)}초 후 다시 연결`);
  clearTimeout(conn.timer);
  conn.timer = setTimeout(() => connectWs(conn), delay);
}

function reconnectNow(conn) {
  const old = conn.ws;
  conn.ws = null;
  old?.close();
  conn.retry = 0;
  connectWs(conn);
}

function checkConnections() {
  for (const conn of conns.values()) {
    if (conn.closed || conn.gone) continue;
    if (!conn.ws) {
      reconnectNow(conn);
    } else if (conn.ws.readyState === WebSocket.OPEN) {
      const sentAt = Date.now();
      const ws = conn.ws;
      conn.raw({ type: 'ping' });
      setTimeout(() => { if (conn.ws === ws && conn.lastRx < sentAt) reconnectNow(conn); }, 3000);
    }
  }
  refresh();
}

function disposeConn(name) {
  const conn = conns.get(name);
  if (!conn) return;
  conn.closed = true;
  clearTimeout(conn.timer);
  conn.ws?.close();
  conn.term.dispose();
  conn.el.remove();
  conns.delete(name);
}

function removeFromTree(t, name) {
  for (const g of leaves(t)) {
    const i = g.tabs.indexOf(name);
    if (i < 0) continue;
    g.tabs.splice(i, 1);
    if (g.active === name) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || null;
  }
  return prune(t);
}

function closeTabs(names) {
  for (const n of [...names]) closeSession(n);
}

function inOtherDesks(name) {
  return desks.some((d, i) => i !== deskIdx && leaves(d.tree).some((g) => g.tabs.includes(name)));
}

function closeSession(name, everywhere = false) {
  if (!conns.has(name)) return;
  const g = groupOf(name);
  removeFromGroups(name);
  if (everywhere) {
    desks.forEach((d, i) => {
      if (i === deskIdx) return;
      d.tree = removeFromTree(d.tree, name);
      if (d.active === name) d.active = leaves(d.tree)[0]?.active || null;
    });
  }
  if (!inOtherDesks(name)) disposeConn(name);
  if (activeName === name) {
    activeName = (g && groupById(g.gid)?.active) || leaves()[0]?.active || null;
  }
  layout();
  saveTabs();
  renderList();
}

function switchDesk(i) {
  if (i === deskIdx || !desks[i]) return;
  desks[deskIdx].tree = tree;
  desks[deskIdx].active = activeName;
  deskIdx = i;
  tree = desks[i].tree;
  activeName = desks[i].active;
  layout();
  saveTabs();
  renderList();
  focusInput();
}

function addDesk() {
  desks.push({ name: '', tree: null, active: null });
  switchDesk(desks.length - 1);
}

function deskNames(d) {
  return leaves(d.tree).flatMap((g) => g.tabs);
}

function renameDesk(i) {
  const name = prompt('데스크탑 이름', desks[i].name || '');
  if (name === null) return;
  desks[i].name = name.trim().slice(0, 20);
  saveTabs();
  renderDesks();
}

function deleteDesk(i) {
  if (desks.length < 2) return toast('데스크탑이 하나뿐이라 삭제할 수 없습니다');
  desks[deskIdx].tree = tree;
  desks[deskIdx].active = activeName;
  const names = i === deskIdx ? leaves().flatMap((g) => g.tabs) : deskNames(desks[i]);
  if (names.length && !confirm(`데스크탑 ${i + 1}의 탭 ${names.length}개를 닫습니다 (세션은 유지). 삭제할까요?`)) return;
  if (i === deskIdx) {
    desks[deskIdx].tree = tree;
    deskIdx = i === 0 ? 1 : i - 1;
  }
  desks.splice(i, 1);
  if (deskIdx > i) deskIdx--;
  tree = desks[deskIdx].tree;
  activeName = desks[deskIdx].active;
  for (const n of names) if (!desks.some((d, j) => (j === deskIdx ? leaves() : leaves(d.tree)).some((g) => g.tabs.includes(n)))) disposeConn(n);
  layout();
  saveTabs();
  renderList();
}

function moveTabToDesk(name, i) {
  if (i === deskIdx || !desks[i] || !conns.has(name)) return;
  const d = desks[i];
  if (!deskNames(d).includes(name)) {
    const g = leaves(d.tree).find((x) => x.tabs.includes(d.active)) || leaves(d.tree)[0];
    if (g) {
      g.tabs.push(name);
      g.active = name;
    } else {
      d.tree = group([name]);
    }
    d.active = name;
  }
  const g = groupOf(name);
  removeFromGroups(name);
  if (activeName === name) activeName = (g && groupById(g.gid)?.active) || leaves()[0]?.active || null;
  layout();
  saveTabs();
  toast(`${name} → 데스크탑 ${i + 1}`);
}

function rawTabNames(t) {
  if (!t || typeof t !== 'object') return [];
  if (t.t === 'leaf') return Array.isArray(t.tabs) ? t.tabs : [t.name];
  return (t.kids || []).flatMap(rawTabNames);
}

function applyDesks(saved, idx, extra = []) {
  const want = new Set([...extra, ...saved.flatMap((d) => rawTabNames(d.tree))].filter((n) => typeof n === 'string'));
  const missing = [...want].filter((n) => !sessions.some((s) => s.name === n));
  for (const name of want) {
    if (!missing.includes(name) && !conns.has(name)) conns.set(name, createConn(name));
  }
  desks = saved.map((d) => ({ name: String(d.name || '').slice(0, 20), tree: sanitizeTree(d.tree), active: d.active }));
  if (!desks.length) desks = [{ name: '', tree: null, active: null }];
  deskIdx = Math.min(Math.max(0, +idx || 0), desks.length - 1);
  tree = desks[deskIdx].tree;
  activeName = conns.has(desks[deskIdx].active) ? desks[deskIdx].active : null;
  for (const name of [...conns.keys()]) {
    if (!extra.includes(name) && !desks.some((d) => leaves(d.tree).some((g) => g.tabs.includes(name)))) disposeConn(name);
  }
  layoutKey = '';
  layout();
  saveTabs();
  renderList();
  return missing;
}

let layoutLink = LS.get('layoutLink', null);
let linkTimer = null;
let linkSent = '';
let linkSavedAt = null;
let linkState = 'saved';

function layoutBody() {
  return { desks: desks.map((d) => ({ name: d.name, tree: d.tree, active: d.active })), deskIdx };
}

function setLink(name) {
  layoutLink = name;
  LS.set('layoutLink', name);
  clearTimeout(linkTimer);
  linkTimer = null;
  linkSent = name ? JSON.stringify(layoutBody()) : '';
  linkSavedAt = name ? Date.now() : null;
  linkState = 'saved';
  renderDesks();
  renderLinkStatus();
}

function renderLayoutChip() {
  const chip = $('layoutchip');
  const label = { saved: '저장됨', pending: '저장 대기 중', error: '저장 실패' }[linkState];
  chip.classList.toggle('none', !layoutLink);
  chip.querySelector('.lcname').textContent = layoutLink || '구성 없음';
  chip.querySelector('.lcdot').className = `lcdot ${layoutLink ? linkState : ''}`;
  chip.title = layoutLink
    ? `불러온 데스크탑 구성: ${layoutLink} · ${label}${linkSavedAt ? ` (마지막 저장 ${new Date(linkSavedAt).toLocaleTimeString('ko-KR')})` : ''} · 변경 사항 자동 저장`
    : '연결된 데스크탑 구성이 없습니다 (자동 저장 안 됨) · 눌러서 저장/불러오기';
  document.title = layoutLink ? `tmux 모니터 · ${layoutLink}` : 'tmux 모니터';
}

function scheduleAutoSave() {
  if (!layoutLink) return;
  clearTimeout(linkTimer);
  if (JSON.stringify(layoutBody()) === linkSent) {
    linkTimer = null;
    return;
  }
  linkTimer = setTimeout(autoSaveNow, 1500);
  if (linkState !== 'pending') {
    linkState = 'pending';
    renderLayoutChip();
  }
}

async function autoSaveNow() {
  linkTimer = null;
  if (!layoutLink) return;
  const body = layoutBody();
  const json = JSON.stringify(body);
  if (json === linkSent) return;
  try {
    await api('PUT', `/layouts/${enc(layoutLink)}`, body);
    linkSent = json;
    linkSavedAt = Date.now();
    linkState = 'saved';
  } catch (e) {
    linkState = 'error';
    toast(`'${layoutLink}' 자동 저장 실패: ${e.message}`, 5000);
  }
  renderDesks();
  renderLinkStatus();
}

function flushAutoSave() {
  if (!layoutLink || !linkTimer) return;
  clearTimeout(linkTimer);
  linkTimer = null;
  const json = JSON.stringify(layoutBody());
  if (json === linkSent) return;
  fetch(`${base}/api/layouts/${enc(layoutLink)}`, {
    method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: json,
  }).catch(() => {});
}

window.addEventListener('pagehide', flushAutoSave);

function renderLinkStatus() {
  const box = $('layoutlink');
  if (!box) return;
  box.hidden = !layoutLink;
  if (!layoutLink) return;
  box.querySelector('.lname').textContent = layoutLink;
  box.querySelector('.ltime').textContent = linkSavedAt ? ` · 마지막 저장 ${new Date(linkSavedAt).toLocaleTimeString('ko-KR')}` : '';
}

const fmtTime = (t) => new Date(t * 1000).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

async function loadLayouts() {
  let list;
  try {
    list = await api('GET', '/layouts');
  } catch (e) {
    return toast(e.message);
  }
  const ul = $('layoutlist');
  ul.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="pt"></span><span class="pn"></span><button data-a="load">불러오기</button><button data-a="del" title="삭제">✕</button>';
    li.querySelector('.pt').textContent = item.name;
    li.classList.toggle('linked', item.name === layoutLink);
    const labels = item.desks.map((n, i) => (n ? `${i + 1} ${n}` : `${i + 1}`));
    li.querySelector('.pn').textContent = `데스크탑 ${item.desks.length}개 (${labels.join(', ')}) · ${fmtTime(item.saved_at)}`;
    li.querySelector('[data-a="load"]').onclick = () => loadLayout(item.name);
    li.querySelector('[data-a="del"]').onclick = async () => {
      if (!confirm(`저장된 구성 '${item.name}'을(를) 삭제할까요?`)) return;
      try { await api('DELETE', `/layouts/${enc(item.name)}`); } catch (e) { return toast(e.message); }
      if (item.name === layoutLink) setLink(null);
      loadLayouts();
    };
    ul.appendChild(li);
  }
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'pn';
    li.textContent = '저장된 구성이 없습니다';
    ul.appendChild(li);
  }
  return list;
}

function openLayouts() {
  $('layoutname').value = '';
  renderLinkStatus();
  $('layoutdlg').showModal();
  loadLayouts();
}

async function saveLayout(name) {
  saveTabs();
  const list = await api('GET', '/layouts').catch(() => []);
  if (list.some((x) => x.name === name) && !confirm(`'${name}' 구성이 이미 있습니다. 덮어쓸까요?`)) return;
  const body = { desks: desks.map((d) => ({ name: d.name, tree: d.tree, active: d.active })), deskIdx };
  try {
    await api('PUT', `/layouts/${enc(name)}`, body);
  } catch (e) {
    return toast(e.message, 5000);
  }
  setLink(name);
  toast(`현재 데스크탑 구성을 '${name}'(으)로 저장했습니다 · 이후 변경은 자동 저장`, 4000);
  $('layoutname').value = '';
  loadLayouts();
}

async function loadLayout(name) {
  if (!confirm(`'${name}' 구성을 불러올까요? 지금 데스크탑 구성은 이 구성으로 바뀝니다.`)) return;
  let data;
  try {
    data = await api('GET', `/layouts/${enc(name)}`);
  } catch (e) {
    return toast(e.message);
  }
  await refresh();
  const missing = applyDesks(data.desks || [], data.deskIdx || 0);
  setLink(name);
  $('layoutdlg').close();
  const msg = missing.length ? `'${name}' 구성을 불러왔습니다 (없는 세션 제외: ${missing.join(', ')})` : `'${name}' 구성을 불러왔습니다`;
  toast(`${msg} · 이후 변경은 자동 저장`, 5000);
}

$('layoutchip').onclick = openLayouts;
$('layoutunlink').onclick = () => {
  setLink(null);
  toast('연결을 끊었습니다 · 더 이상 자동 저장하지 않습니다');
  loadLayouts();
};

$('layoutform').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('layoutname').value.trim();
  if (name) saveLayout(name);
});

function deskState(d, i) {
  const names = i === deskIdx ? leaves().flatMap((g) => g.tabs) : deskNames(d);
  const states = names.map((n) => sessions.find((s) => s.name === n)?.state);
  return states.includes('waiting') ? 'waiting' : states.includes('working') ? 'working' : '';
}

function renderDesks() {
  const box = $('desks');
  box.innerHTML = '';
  desks.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = `desk${i === deskIdx ? ' on' : ''}`;
    const st = deskState(d, i);
    b.innerHTML = '<span class="dnum"></span><span class="dlabel"></span><span class="ddot"></span>';
    b.querySelector('.dnum').textContent = i + 1;
    b.querySelector('.dlabel').textContent = d.name || '';
    if (st) b.querySelector('.ddot').className = `ddot st-${st}`;
    b.title = `데스크탑 ${i + 1}${d.name ? ` · ${d.name}` : ''}${i < 9 ? ` (Alt+${i + 1})` : ''} · 우클릭: 이름 바꾸기/삭제`;
    b.onclick = () => switchDesk(i);
    b.ondblclick = () => renameDesk(i);
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, [
        { label: '이 데스크탑으로 이동', run: () => switchDesk(i) },
        { label: '이름 바꾸기', run: () => renameDesk(i) },
        { label: '데스크탑 구성 저장/불러오기', run: openLayouts },
        { label: '이 데스크탑 탭 모두 닫기', disabled: i !== deskIdx || !leaves().some((g) => g.tabs.length), run: () => closeTabs(leaves().flatMap((g) => g.tabs)) },
        '-',
        { label: '데스크탑 삭제', danger: true, disabled: desks.length < 2, run: () => deleteDesk(i) },
      ]);
    });
    b.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(SESSION_MIME) || i === deskIdx) return;
      e.preventDefault();
      b.classList.add('drop');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      b.classList.remove('drop');
      if (!e.dataTransfer?.types.includes(SESSION_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      moveTabToDesk(e.dataTransfer.getData(SESSION_MIME), i);
    });
    box.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'desk add';
  add.textContent = '＋';
  add.title = '새 데스크탑';
  add.onclick = addDesk;
  box.appendChild(add);
  const more = document.createElement('button');
  more.className = 'desk add';
  more.textContent = '⋯';
  more.title = '데스크탑 구성 저장/불러오기';
  renderLayoutChip();
  more.onclick = openLayouts;
  box.appendChild(more);
}

function activate(name, focus = true) {
  if (!conns.has(name)) return;
  const changed = activeName !== name;
  if (!groupOf(name)) addToGroup(name, groupOf(activeName) || leaves()[0]);
  groupOf(name).active = name;
  activeName = name;
  layout();
  if (focus) focusInput();
  if (changed) {
    renderList();
    saveTabs();
  }
}

const drafts = new Map();
let draftOwner = null;
function syncDraft() {
  if (draftOwner === activeName) return;
  const box = $('ime');
  if (draftOwner) {
    if (box.value) drafts.set(draftOwner, box.value); else drafts.delete(draftOwner);
  }
  box.value = (activeName && drafts.get(activeName)) || '';
  draftOwner = activeName;
}

function focusInput() {
  const c = active();
  if (!c || narrow.matches) return;
  if (imeOn) boxOf(c).focus(); else c.term.focus();
}

let gidSeq = 0;
const group = (tabs, active = tabs[0]) => ({ t: 'leaf', gid: `g${++gidSeq}`, tabs: [...tabs], active });

function leaves(n = tree, out = []) {
  if (!n) return out;
  if (n.t === 'leaf') out.push(n);
  else for (const k of n.kids) leaves(k, out);
  return out;
}

function groupOf(name) {
  return leaves().find((g) => g.tabs.includes(name)) || null;
}

function groupById(gid) {
  return leaves().find((g) => g.gid === gid) || null;
}

function prune(n) {
  if (!n) return null;
  if (n.t === 'leaf') return n.tabs.length ? n : null;
  const kids = [];
  const sizes = [];
  n.kids.forEach((k, i) => {
    const r = prune(k);
    if (r) {
      kids.push(r);
      sizes.push(n.sizes[i]);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  if (kids.length === n.kids.length && kids.every((k, i) => k === n.kids[i])) return n;
  const sum = sizes.reduce((a, b) => a + b, 0);
  return { ...n, kids, sizes: sizes.map((s) => s / sum) };
}

function removeFromGroups(name) {
  const g = groupOf(name);
  if (!g) return;
  const i = g.tabs.indexOf(name);
  g.tabs.splice(i, 1);
  if (g.active === name) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || null;
  tree = prune(tree);
}

function addToGroup(name, g, before = null, makeActive = true) {
  if (!g) {
    if (tree) return addToGroup(name, leaves()[0], before, makeActive);
    tree = group([name]);
    return;
  }
  let i = before ? g.tabs.indexOf(before) : -1;
  if (i < 0) {
    const a = g.tabs.indexOf(g.active);
    i = a < 0 ? g.tabs.length : a + 1;
  }
  g.tabs.splice(i, 0, name);
  if (makeActive || !g.active) g.active = name;
}

function splitAt(n, gid, g, side) {
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const first = side === 'left' || side === 'top';
  if (n.t === 'leaf') {
    if (n.gid !== gid) return n;
    return { t: 'split', dir, sizes: [0.5, 0.5], kids: first ? [g, n] : [n, g] };
  }
  const i = n.kids.findIndex((k) => k.t === 'leaf' && k.gid === gid);
  if (i >= 0 && n.dir === dir) {
    const kids = [...n.kids];
    const sizes = [...n.sizes];
    const half = sizes[i] / 2;
    const at = first ? i : i + 1;
    sizes[i] = half;
    kids.splice(at, 0, g);
    sizes.splice(at, 0, half);
    return { ...n, kids, sizes };
  }
  return { ...n, kids: n.kids.map((k) => splitAt(k, gid, g, side)) };
}

function sanitizeTree(n) {
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object') return null;
    if (x.t === 'leaf') {
      const names = (Array.isArray(x.tabs) ? x.tabs : [x.name])
        .filter((nm) => typeof nm === 'string' && conns.has(nm) && !seen.has(nm));
      names.forEach((nm) => seen.add(nm));
      if (!names.length) return null;
      return group(names, names.includes(x.active) ? x.active : names[0]);
    }
    if (x.t !== 'split' || !Array.isArray(x.kids)) return null;
    const kids = [];
    const sizes = [];
    x.kids.forEach((k, i) => {
      const r = walk(k);
      if (r) {
        kids.push(r);
        sizes.push(Number(x.sizes?.[i]) > 0 ? Number(x.sizes[i]) : 1);
      }
    });
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    const sum = sizes.reduce((a, b) => a + b, 0);
    return { t: 'split', dir: x.dir === 'col' ? 'col' : 'row', kids, sizes: sizes.map((s) => s / sum) };
  };
  return walk(n);
}

function placeSession(name, gid, zone, before = null) {
  if (!conns.has(name)) conns.set(name, createConn(name));
  const target = gid ? groupById(gid) : null;
  const from = groupOf(name);
  if (!target) {
    if (!from) addToGroup(name, groupOf(activeName) || leaves()[0]);
  } else if (zone === 'center') {
    if (from === target) {
      if (before && before !== name) {
        target.tabs.splice(target.tabs.indexOf(name), 1);
        const bi = target.tabs.indexOf(before);
        target.tabs.splice(bi < 0 ? target.tabs.length : bi, 0, name);
      }
      target.active = name;
    } else {
      if (from) removeFromGroups(name);
      addToGroup(name, groupById(gid), before);
    }
  } else if (from === target && target.tabs.length === 1) {
    target.active = name;
  } else {
    if (from) removeFromGroups(name);
    if (groupById(gid)) tree = splitAt(tree, gid, group([name]), zone);
    else addToGroup(name, leaves()[0]);
  }
  activeName = name;
  layout();
  saveTabs();
  renderList();
  focusInput();
}

function buildNode(n) {
  if (n.t === 'leaf') return buildGroup(n);
  const box = document.createElement('div');
  box.className = `lsplit d-${n.dir}`;
  n.kids.forEach((k, i) => {
    if (i) box.appendChild(buildGutter(n, i));
    const child = buildNode(k);
    child.style.flex = `${n.sizes[i]} 1 0`;
    box.appendChild(child);
  });
  return box;
}

function buildGroup(g) {
  const w = document.createElement('div');
  w.className = 'leaf';
  w.dataset.gid = g.gid;
  const strip = document.createElement('div');
  strip.className = 'gtabs';
  for (const name of g.tabs) {
    const t = document.createElement('div');
    t.className = `gtab${name === g.active ? ' active' : ''}`;
    t.dataset.name = name;
    t.draggable = true;
    t.innerHTML = '<span class="dot"></span><span class="tname"></span><button class="tclose" title="탭 닫기 (세션은 유지)">×</button>';
    t.querySelector('.tname').textContent = name;
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(SESSION_MIME, name);
      e.dataTransfer.setData('text/plain', name);
      e.dataTransfer.effectAllowed = 'move';
    });
    t.onclick = () => activate(name);
    t.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeSession(name);
    });
    t.querySelector('.tclose').onclick = (e) => {
      e.stopPropagation();
      closeSession(name);
    };
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const all = leaves().flatMap((x) => x.tabs);
      openCtx(e.clientX, e.clientY, [
        { label: '탭 닫기', run: () => closeSession(name) },
        { label: '이 탭 빼고 모두 닫기', disabled: all.length < 2, run: () => closeTabs(all.filter((n) => n !== name)) },
        { label: '이 칸의 다른 탭 닫기', disabled: g.tabs.length < 2, run: () => closeTabs(g.tabs.filter((n) => n !== name)) },
        '-',
        { label: `이 데스크탑 탭 모두 닫기 (${all.length})`, danger: true, run: () => closeTabs(all) },
      ]);
    });
    strip.appendChild(t);
  }
  w.appendChild(strip);
  w.appendChild(conns.get(g.active).el);
  return w;
}

function buildSingle(name) {
  const w = document.createElement('div');
  w.className = 'leaf';
  w.appendChild(conns.get(name).el);
  return w;
}

function buildGutter(node, i) {
  const g = document.createElement('div');
  g.className = `lgutter d-${node.dir}`;
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add('dragging');
    const row = node.dir === 'row';
    const box = g.parentElement.getBoundingClientRect();
    const total = row ? box.width : box.height;
    const start = row ? e.clientX : e.clientY;
    const a = node.sizes[i - 1];
    const b = node.sizes[i];
    const prev = g.previousElementSibling;
    const next = g.nextElementSibling;
    const min = 0.06;
    const move = (ev) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / total;
      const na = Math.max(min, Math.min(a + b - min, a + d));
      node.sizes[i - 1] = na;
      node.sizes[i] = a + b - na;
      prev.style.flex = `${node.sizes[i - 1]} 1 0`;
      next.style.flex = `${node.sizes[i]} 1 0`;
    };
    const up = () => {
      g.classList.remove('dragging');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      saveTabs();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  return g;
}

function visibleNames() {
  if (narrow.matches) return activeName && conns.has(activeName) ? [activeName] : [];
  return leaves().map((g) => g.active).filter(Boolean);
}

function layout() {
  for (const g of leaves()) {
    g.tabs = g.tabs.filter((n) => conns.has(n));
    if (!g.tabs.includes(g.active)) g.active = g.tabs[0] || null;
  }
  tree = prune(tree);
  if (activeName && !conns.has(activeName)) activeName = null;
  for (const name of conns.keys()) {
    if (!groupOf(name) && !inOtherDesks(name)) addToGroup(name, groupOf(activeName) || leaves()[0], null, false);
  }
  if (!activeName) activeName = leaves()[0]?.active || null;
  syncDraft();
  const key = narrow.matches ? `n:${activeName}` : JSON.stringify(tree, (k, v) => (k === 'sizes' ? undefined : v));
  const term = $('term');
  if (key !== layoutKey || !term.querySelector('.lroot')) {
    layoutKey = key;
    const hold = $('paneholder');
    for (const c of conns.values()) hold.appendChild(c.el);
    term.querySelector('.lroot')?.remove();
    const names = visibleNames();
    if (names.length) {
      const wrap = document.createElement('div');
      wrap.className = `lroot${names.length > 1 ? ' multi' : ''}`;
      wrap.appendChild(narrow.matches ? buildSingle(activeName) : buildNode(tree));
      term.appendChild(wrap);
    }
    requestAnimationFrame(() => {
      for (const name of visibleNames()) {
        const c = conns.get(name);
        if (!c?.opened) continue;
        fitConn(c);
        c.term.refresh(0, c.term.rows - 1);
      }
    });
  }
  $('empty').hidden = leaves().length > 0;
  $('empty').textContent = conns.size
    ? '이 데스크탑은 비어 있습니다 · 세션 목록에서 세션을 열거나 탭을 끌어다 놓으세요'
    : '세션 목록에서 세션을 선택하면 접속합니다';
  const focusGid = groupOf(activeName)?.gid;
  for (const w of term.querySelectorAll('.leaf')) w.classList.toggle('focus', !!focusGid && w.dataset.gid === focusGid);
  for (const name of visibleNames()) {
    const c = conns.get(name);
    ensureOpen(c);
    fitConn(c);
  }
  renderTabs();
  renderWinbar();
  syncChats();
}

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  for (const t of document.querySelectorAll('.gtab')) {
    const s = sessions.find((x) => x.name === t.dataset.name);
    const c = conns.get(t.dataset.name);
    t.querySelector('.dot').className = `dot${s?.state ? ` st-${s.state}` : ''}`;
    t.classList.toggle('offline', !(c?.ws && c.ws.readyState === WebSocket.OPEN));
    t.title = s?.state ? `${t.dataset.name} · ${STATE_LABEL[s.state]}` : t.dataset.name;
  }
  renderDesks();
  if (!narrow.matches) return;
  for (const c of leaves().flatMap((g) => g.tabs).map((n) => conns.get(n)).filter(Boolean)) {
    const s = sessions.find((x) => x.name === c.name);
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.classList.toggle('active', c.name === activeName);
    tab.classList.toggle('offline', !(c.ws && c.ws.readyState === WebSocket.OPEN));
    tab.innerHTML = '<span class="dot"></span><span class="tname"></span><button class="tclose" title="탭 닫기 (세션은 유지)">×</button>';
    if (s?.state) tab.querySelector('.dot').classList.add(`st-${s.state}`);
    tab.querySelector('.tname').textContent = c.name;
    tab.title = s?.state ? `${c.name} · ${STATE_LABEL[s.state]}` : c.name;
    tab.onclick = () => activate(c.name);
    tab.querySelector('.tclose').onclick = (e) => { e.stopPropagation(); closeSession(c.name); };
    box.appendChild(tab);
  }
  box.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderWinbar() {
  const bar = $('winbar');
  const c = active();
  const s = c && sessions.find((x) => x.name === c.name);
  const win = s?.windows.find((w) => w.active);
  const multi = s && (s.windows.length > 1 || (win && win.panes.length > 1));
  if (!s || (narrow.matches && !multi)) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = '';
  const add = (text, cls, onclick, title) => {
    const el = document.createElement(onclick ? 'button' : 'span');
    el.textContent = text;
    if (cls) el.className = cls;
    if (title) el.title = title;
    if (onclick) el.onclick = onclick;
    bar.appendChild(el);
  };
  const chip = (label, current, onSelect, onClose, menu) => {
    const b = document.createElement('button');
    b.className = `wchip${current ? ' cur' : ''}`;
    b.innerHTML = '<span class="wlabel"></span><span class="wx" title="닫기">×</span>';
    b.querySelector('.wlabel').textContent = label;
    b.onclick = onSelect;
    b.querySelector('.wx').onclick = (e) => {
      e.stopPropagation();
      onClose();
    };
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, menu());
    });
    bar.appendChild(b);
  };
  add('창', 'lbl');
  for (const w of s.windows) {
    chip(`${w.index}:${w.name}`, w.active, () => selectTarget(s.name, w.index), () => killWindow(s, w), () => [
      { label: '이 창으로 이동', run: () => selectTarget(s.name, w.index) },
      { label: '창 이름 바꾸기', run: () => renameWindow(s.name, w) },
      '-',
      { label: '창 닫기', danger: true, run: () => killWindow(s, w) },
    ]);
  }
  add('＋', '', () => newWindow(s.name), '새 창 만들기');
  if (win && win.panes.length > 1) {
    add('|', 'sep');
    add('패널', 'lbl');
    for (const p of win.panes) {
      chip(`${p.index}:${p.command}`, p.active, () => selectTarget(s.name, win.index, p.index), () => killPane(s.name, win, p), () => [
        { label: '이 패널로 이동', run: () => selectTarget(s.name, win.index, p.index) },
        '-',
        { label: '패널 닫기', danger: true, run: () => killPane(s.name, win, p) },
      ]);
    }
  }
}

async function killWindow(s, w) {
  const last = s.windows.length === 1;
  const msg = last
    ? `'${s.name}'의 마지막 창이라 닫으면 세션 전체가 종료됩니다. 닫을까요?`
    : `창 ${w.index}:${w.name}을(를) 닫을까요? 그 안에서 실행 중인 프로그램이 종료됩니다.`;
  if (!confirm(msg)) return;
  try {
    await api('DELETE', `/sessions/${enc(s.name)}/windows/${w.index}`);
  } catch (e) {
    return toast(e.message, 5000);
  }
  if (last) closeSession(s.name, true);
  refresh();
}

async function renameWindow(name, w) {
  const newName = prompt('창 이름', w.name);
  if (!newName?.trim() || newName.trim() === w.name) return;
  try {
    await api('PATCH', `/sessions/${enc(name)}/windows/${w.index}`, { new_name: newName.trim() });
  } catch (e) {
    return toast(e.message, 5000);
  }
  refresh();
}

async function killPane(name, win, p) {
  if (!confirm(`패널 ${p.index}:${p.command}을(를) 닫을까요? 그 안에서 실행 중인 프로그램이 종료됩니다.`)) return;
  try {
    await api('DELETE', `/sessions/${enc(name)}/windows/${win.index}/panes/${p.index}`);
  } catch (e) {
    return toast(e.message, 5000);
  }
  refresh();
}

async function selectTarget(name, window, pane) {
  try {
    await api('POST', `/sessions/${enc(name)}/select`, { window, pane: pane ?? null });
  } catch (e) {
    toast(e.message);
  }
  refresh();
}

async function newWindow(name) {
  try { await api('POST', `/sessions/${enc(name)}/windows`); } catch (e) { toast(e.message); }
  refresh();
}

const ime = $('ime');

const perPane = () => !narrow.matches && imeOn;
const boxOf = (c) => (perPane() && c?.box) || ime;

function updateBars() {
  const on = perPane();
  for (const c of conns.values()) c.el.classList.toggle('hasbar', on);
  $('imebar').hidden = on || (!imeOn && !chatActive());
}

function setIme(on, focus = true) {
  imeOn = !!on;
  updateBars();
  $('imetoggle').classList.toggle('on', imeOn);
  LS.set('imeOn', imeOn);
  if (!focus) return;
  if (imeOn) boxOf(active()).focus(); else active()?.term.focus();
}

function growBox(c) {
  const b = c.box;
  b.style.height = 'auto';
  b.style.height = b.scrollHeight + 2 + 'px';
  c.el.style.setProperty('--pbar-h', `${c.bar.offsetHeight}px`);
}

function sendBox(c, execute) {
  const text = c.box.value;
  c.box.value = '';
  growBox(c);
  sendText(text, execute, c);
}

function makeBar(conn) {
  const bar = document.createElement('div');
  bar.className = 'pbar';
  bar.innerHTML = '<button class="pattach" title="파일 올리기 (이 칸 세션의 작업 폴더)">📎</button><textarea rows="1"></textarea><button class="psend" title="전송+실행">전송</button>';
  conn.el.appendChild(bar);
  conn.bar = bar;
  const box = bar.querySelector('textarea');
  conn.box = box;
  box.placeholder = `${conn.name} 에 입력 — Enter: 전송+실행 · Shift+Enter: 줄바꿈 · Ctrl+Enter: 전송만 · Esc: 터미널로`;
  bar.addEventListener('mousedown', (e) => { e.stopPropagation(); if (activeName !== conn.name) activate(conn.name, false); });
  box.addEventListener('focus', () => { if (activeName !== conn.name) activate(conn.name, false); });
  box.addEventListener('input', () => growBox(conn));
  box.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBox(conn, !(e.ctrlKey || e.metaKey));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (chatOn(conn)) box.blur(); else conn.term.focus();
    } else if (!box.value && (e.key === 'Backspace' || e.key.startsWith('Arrow') || e.key === 'Tab')) {
      e.preventDefault();
      const keys = { Backspace: 'bs', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'right', ArrowLeft: 'left' };
      conn.send({ type: 'input', data: keySeq(keys[e.key]) });
    }
  });
  box.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      uploadFiles(files, conn);
    }
  });
  bar.querySelector('.psend').onclick = () => sendBox(conn, true);
  bar.querySelector('.pattach').onclick = () => { activate(conn.name, false); $('file').click(); };
  conn.el.classList.toggle('hasbar', perPane());
  requestAnimationFrame(() => growBox(conn));
}

narrow.addEventListener('change', updateBars);

function autoGrow() {
  ime.style.height = 'auto';
  ime.style.height = ime.scrollHeight + 2 + 'px';
}

function sendText(text, execute, c = active()) {
  if (!c) return toast('먼저 세션을 선택하세요');
  if (c.chat.draft && chatOn(c) && !sessionOf(c.name)?.sleeping && !c.chat.conv) {
    const d = c.chat.draft;
    c.chat.draft = '';
    return api('POST', `/sessions/${enc(c.name)}/clear-input`).then(() => {
      toast(`Claude 입력창에 남아 있던 글을 지우고 보냈습니다: ${d.slice(0, 40)}`, 4000);
      sendText(text, execute, c);
    }, (e) => toast(e.message, 5000));
  }
  if (sessionOf(c.name)?.sleeping || c.chat.conv) {
    if (!execute || !text.trim()) return toast('쉬는 섹션입니다 — 보낼 글을 입력하면 그 글로 깨웁니다');
    return wakeSection(c.name, text);
  }
  if (text) c.term.paste(text);
  if (execute) setTimeout(() => c.send({ type: 'input', data: '\r' }), text ? 50 : 0);
  if (chatOn(c)) {
    c.chat.stick = true;
    setTimeout(() => pollChat(c), 700);
  }
}

function sendIme(execute) {
  if (!active()) return toast('먼저 세션을 선택하세요');
  if (draftOwner !== activeName) {
    syncDraft();
    return toast('입력하던 세션과 지금 세션이 달라 보내지 않았습니다');
  }
  sendText(ime.value, execute);
  ime.value = '';
  autoGrow();
}

ime.addEventListener('input', () => {
  if (draftOwner === null) draftOwner = activeName;
  const c = active();
  if (ctrlArmed && c && ime.value.length === 1) {
    c.send({ type: 'input', data: applyCtrl(ime.value) });
    ime.value = '';
  }
  autoGrow();
});

ime.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const c = active();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendIme(!(e.ctrlKey || e.metaKey));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (chatActive()) ime.blur(); else c?.term.focus();
  } else if (!ime.value && c && (e.key === 'Backspace' || e.key.startsWith('Arrow') || e.key === 'Tab')) {
    e.preventDefault();
    const keys = { Backspace: 'bs', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'right', ArrowLeft: 'left' };
    c.send({ type: 'input', data: keySeq(keys[e.key]) });
  }
});

ime.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});

$('imesend').onclick = () => sendIme(true);
$('imetoggle').onclick = () => setIme(!imeOn);

const chatPref = LS.get('chatViews', {});
const isClaude = (name) => !!sessions.find((s) => s.name === name)?.claude;
let chatDefault = LS.get('chatDefault', null);
const wantChat = (name) => chatPref[name] ?? chatDefault ?? (narrow.matches || matchMedia('(pointer: coarse)').matches);
const chatOn = (c) => !!c && isClaude(c.name) && wantChat(c.name);
const chatActive = () => chatOn(active());
const dur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : `${Math.round(ms / 1000)}초`);

function initChat(conn) {
  const ch = conn.chat;
  ch.el.innerHTML = `<div class="cwarn" hidden>입력이 Claude 창이 아닌 다른 창으로 갑니다 <button>Claude 창으로</button></div><div class="clist"><button class="cmore" hidden>이전 대화 더 보기</button><div class="citems"></div></div>
    <div class="cstate" hidden><div class="cask" hidden></div><span class="ctext"></span><button class="cstop">중단 (Esc)</button><button class="cterm">터미널 보기</button><button class="cconv" hidden>지난 대화</button></div>`;
  ch.list = ch.el.querySelector('.clist');
  ch.items = ch.el.querySelector('.citems');
  ch.more = ch.el.querySelector('.cmore');
  ch.state = ch.el.querySelector('.cstate');
  ch.ask = ch.el.querySelector('.cask');
  ch.warn = ch.el.querySelector('.cwarn');
  ch.warn.querySelector('button').onclick = async () => {
    try {
      await api('POST', `/sessions/${encodeURIComponent(conn.name)}/focus-claude`);
      ch.warn.hidden = true;
    } catch (e) {
      toast(e.message);
    }
  };
  ch.more.onclick = () => loadOlder(conn);
  ch.list.addEventListener('scroll', () => {
    ch.atBottom = ch.list.scrollHeight - ch.list.scrollTop - ch.list.clientHeight < 80;
    if (ch.list.scrollTop < 60 && !ch.more.hidden) loadOlder(conn);
  });
  new ResizeObserver(() => { if (ch.atBottom !== false) ch.list.scrollTop = ch.list.scrollHeight; }).observe(ch.list);
  ch.el.querySelector('.cstop').onclick = () => conn.send({ type: 'input', data: keySeq('esc') });
  ch.el.querySelector('.cterm').onclick = () => setChatView(conn.name, false);
  ch.el.querySelector('.cconv').onclick = () => openConversations(conn.name);
  keepFocus(ch.el);
}

function setMd(d, text) {
  if (!(window.marked && window.DOMPurify)) {
    d.textContent = text;
    return;
  }
  d.innerHTML = DOMPurify.sanitize(marked.parse(text));
  if (window.hljs) for (const c of d.querySelectorAll('pre code')) hljs.highlightElement(c);
  addCopyButtons(d);
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('cpw')) continue;
    const w = document.createElement('div');
    w.className = 'cpw';
    pre.replaceWith(w);
    w.appendChild(pre);
    const b = document.createElement('button');
    b.className = 'cpb';
    b.textContent = '복사';
    b.onclick = (e) => {
      e.stopPropagation();
      copyText(pre.innerText.replace(/\n$/, '')).then((ok) => {
        b.textContent = ok ? '복사됨' : '실패';
        setTimeout(() => (b.textContent = '복사'), 1200);
      });
    };
    w.appendChild(b);
  }
}

const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

function setDetail(pre, it) {
  pre.textContent = '';
  const diff = ['Edit', 'MultiEdit', 'Write'].includes(it.name);
  for (const line of (it.detail || it.input).split('\n')) {
    const span = document.createElement('span');
    if (diff && line.startsWith('- ')) span.className = 'del';
    else if (diff && line.startsWith('+ ')) span.className = 'add';
    span.textContent = line + '\n';
    pre.appendChild(span);
  }
}

function attachResult(t, r) {
  t.classList.add(r.error ? 'err' : 'ok');
  t.querySelector('.tout').textContent = (r.text || '(출력 없음)') + (r.cut ? '\n…(잘림)' : '');
}

function chatNode(ch, it) {
  const d = document.createElement('div');
  if (it.k === 'user') {
    d.className = 'cu';
    d.textContent = it.text;
    d.title = hhmm(it.ts);
    if (it.text.split('\n').length > 12 || it.text.length > 1200) {
      d.classList.add('long');
      d.onclick = () => d.classList.toggle('long');
    }
  } else if (it.k === 'text') {
    d.className = 'ca md';
    setMd(d, it.text);
  } else if (it.k === 'tool') {
    d.className = 'ct';
    d.innerHTML = '<details><summary><span class="tn"></span><span class="ti"></span></summary><pre class="tin"></pre><pre class="tout"></pre></details>';
    d.querySelector('.tn').textContent = it.name;
    d.querySelector('.ti').textContent = it.input.split('\n')[0];
    setDetail(d.querySelector('.tin'), it);
    ch.tools.set(it.id, d);
    const r = ch.orphans.get(it.id);
    if (r) {
      attachResult(d, r);
      ch.orphans.delete(it.id);
    }
  } else if (it.k === 'result') {
    const t = ch.tools.get(it.id);
    if (t) attachResult(t, it); else ch.orphans.set(it.id, it);
    return null;
  } else if (it.k === 'note') {
    d.className = 'cn';
    d.textContent = `🔔 ${it.text}`;
    d.title = it.text;
  } else if (it.k === 'summary') {
    d.className = 'cs';
    d.textContent = it.text;
  } else if (it.k === 'turn') {
    d.className = 'cd';
    d.textContent = `— 완료 · ${dur(it.ms)} · ${hhmm(it.ts)} —`;
  } else {
    return null;
  }
  if (it.o != null) d.dataset.o = it.o;
  return d;
}

function trimChat(ch) {
  const nodes = ch.items.children;
  if (nodes.length <= 700) return;
  const cut = nodes.length - 500;
  let i = cut;
  while (i < nodes.length && nodes[i].dataset.o == null) i++;
  if (i >= nodes.length) return;
  for (const n of [...nodes].slice(0, i)) {
    for (const [id, t] of ch.tools) if (t === n) ch.tools.delete(id);
    n.remove();
  }
  ch.start = +ch.items.firstElementChild.dataset.o;
}

function clearChat(ch) {
  ch.items.innerHTML = '';
  ch.tools.clear();
  ch.orphans.clear();
  ch.end = null;
}

function showChatState(conn, state, ask) {
  const ch = conn.chat;
  ch.state.hidden = state !== 'working' && state !== 'waiting' && state !== 'sleeping';
  ch.state.classList.toggle('sleeping', state === 'sleeping');
  ch.state.querySelector('.ctext').textContent = state === 'sleeping' ? (ch.conv ? '📜 지난 대화 (읽기만)' : '💤 쉬는 중 — 입력하면 이 대화로 깨어납니다')
    : state === 'waiting' ? (ask ? '' : '확인을 기다립니다 — 터미널에서 고릅니다') : '작업 중…';
  ch.state.querySelector('.cstop').hidden = state !== 'working';
  ch.state.querySelector('.cterm').hidden = state !== 'waiting';
  ch.state.querySelector('.cconv').hidden = state !== 'sleeping';
  const key = ask ? JSON.stringify(ask) : '';
  if (key === ch.askKey) return;
  ch.askKey = key;
  ch.ask.innerHTML = '';
  ch.ask.hidden = !ask;
  ch.state.classList.toggle('asking', !!ask);
  if (!ask) return;
  const body = document.createElement('div');
  body.className = 'cabody';
  body.textContent = ask.body;
  ch.ask.appendChild(body);
  for (const o of ask.options) {
    const b = document.createElement('button');
    b.className = `copt${o.n === ask.cur ? ' cur' : ''}`;
    b.innerHTML = '<span class="on"></span><span class="ol"></span><span class="od"></span>';
    b.querySelector('.on').textContent = `${o.n}.`;
    b.querySelector('.ol').textContent = o.label;
    b.querySelector('.od').textContent = o.desc;
    b.onclick = async () => {
      for (const x of ch.ask.querySelectorAll('button')) x.disabled = true;
      try {
        await api('POST', `/sessions/${encodeURIComponent(conn.name)}/choose`, { n: o.n, label: o.label });
      } catch (e) {
        toast(e.message);
        ch.askKey = null;
      }
      setTimeout(() => pollChat(conn), 400);
    };
    ch.ask.appendChild(b);
  }
}

const chatUrl = (conn, q) => `/sessions/${encodeURIComponent(conn.name)}/chat?sid=${conn.chat.sid || ''}${conn.chat.conv ? `&conv=${conn.chat.conv}` : ''}${q}`;

async function pollChat(conn) {
  const ch = conn.chat;
  if (ch.busy) return;
  ch.busy = true;
  try {
    await loadViewerLibs().catch(() => {});
    const r = await api('GET', chatUrl(conn, ch.end == null ? '' : `&after=${ch.end}`));
    if (!r.claude) return;
    const first = ch.end == null || r.sid !== ch.sid || r.reset;
    if (first) {
      clearChat(ch);
      ch.sid = r.sid;
      ch.start = r.start;
    }
    const l = ch.list;
    const stick = first || ch.stick || l.scrollHeight - l.scrollTop - l.clientHeight < 80;
    ch.stick = false;
    ch.end = r.end;
    for (const it of r.items) {
      const n = chatNode(ch, it);
      if (n) ch.items.appendChild(n);
    }
    ch.warn.hidden = r.active !== false;
    if (stick) trimChat(ch);
    ch.more.hidden = ch.start <= 0;
    showChatState(conn, r.state, r.prompt);
    pullDraft(conn, r.draft || '');
    if (stick) l.scrollTop = l.scrollHeight;
  } catch {
  } finally {
    ch.busy = false;
  }
}

async function pullDraft(conn, text) {
  conn.chat.draft = text;
  const box = boxOf(conn);
  const global = box === ime;
  if (!text || conn.chat.pulling || !chatOn(conn) || (global && activeName !== conn.name)) return;
  if (box.value.trim() || (global && draftOwner && draftOwner !== conn.name)) return;
  conn.chat.pulling = true;
  try {
    await api('POST', `/sessions/${enc(conn.name)}/clear-input`);
    if (box.value.trim() || (global && activeName !== conn.name)) return;
    setIme(true, false);
    box.value = text;
    if (global) { draftOwner = conn.name; autoGrow(); } else growBox(conn);
    conn.chat.draft = '';
    toast('Claude 입력창에 남아 있던 글을 가져왔습니다 — 고쳐서 보내세요', 4000);
  } catch {
  } finally {
    conn.chat.pulling = false;
  }
}

async function loadOlder(conn) {
  const ch = conn.chat;
  if (ch.start <= 0 || ch.busy) return;
  ch.busy = true;
  try {
    const r = await api('GET', chatUrl(conn, `&before=${ch.start}`));
    if (!r.claude || r.sid !== ch.sid) return;
    const h = ch.list.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const it of r.items) {
      const n = chatNode(ch, it);
      if (n) frag.appendChild(n);
    }
    ch.items.prepend(frag);
    ch.start = r.start;
    ch.more.hidden = ch.start <= 0;
    ch.list.scrollTop += ch.list.scrollHeight - h;
  } catch (e) {
    toast('대화 불러오기 실패: ' + e.message);
  } finally {
    ch.busy = false;
  }
}

function syncChats() {
  const vis = new Set(visibleNames());
  for (const c of conns.values()) {
    const on = vis.has(c.name) && chatOn(c);
    c.chat.el.hidden = !on;
    if (on && !c.chat.timer) {
      pollChat(c);
      c.chat.timer = setInterval(() => { if (document.visibilityState === 'visible') pollChat(c); }, 1500);
    } else if (!on && c.chat.timer) {
      clearInterval(c.chat.timer);
      c.chat.timer = null;
    }
  }
  const a = active();
  const btn = $('chatview');
  btn.hidden = !a || !isClaude(a.name);
  btn.classList.toggle('on', chatOn(a));
  btn.textContent = chatOn(a) ? '⌨' : '💬';
  btn.title = chatOn(a) ? '터미널 보기' : '대화 보기 (Claude Code)';
  updateBars();
}

function setChatView(name, on) {
  chatPref[name] = on;
  LS.set('chatViews', chatPref);
  syncChats();
  if (!on && !narrow.matches) conns.get(name)?.term.focus();
}

function setBarHidden(on) {
  document.body.classList.toggle('barhide', on);
  LS.set('barHidden', on);
}
setBarHidden(LS.get('barHidden', false));
$('barhide').onclick = () => setBarHidden(true);
$('barshow').onclick = () => setBarHidden(false);
$('peekmenu').onclick = () => $('menu').click();

$('chatview').onclick = () => { const a = active(); if (a) setChatView(a.name, !chatOn(a)); };

function setChatDefault(v) {
  chatDefault = v;
  LS.set('chatDefault', v);
  for (const k of Object.keys(chatPref)) delete chatPref[k];
  LS.set('chatViews', chatPref);
  syncChats();
  toast(v === true ? 'Claude 세션을 모두 대화 보기로 엽니다' : v === false ? 'Claude 세션을 모두 터미널로 엽니다' : '폰은 대화 보기, PC는 터미널로 엽니다');
}

function chatDefaultMenu() {
  const mark = (v) => (chatDefault === v ? '✓ ' : '');
  return [
    { label: `${mark(true)}Claude 세션 모두 대화 보기`, run: () => setChatDefault(true) },
    { label: `${mark(false)}Claude 세션 모두 터미널`, run: () => setChatDefault(false) },
    { label: `${mark(null)}기기에 맞게 (폰 대화 · PC 터미널)`, run: () => setChatDefault(null) },
  ];
}

$('chatview').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openCtx(e.clientX, e.clientY, chatDefaultMenu());
});

function setCtrl(on) {
  ctrlArmed = on;
  $('ctrlkey').classList.toggle('armed', on);
}

function applyCtrl(data) {
  if (!ctrlArmed || data.length !== 1) return data;
  setCtrl(false);
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return data === ' ' ? '\x00' : data;
}

function keySeq(key) {
  const csi = active()?.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
  return {
    esc: '\x1b', tab: '\t', stab: '\x1b[Z', bs: '\x7f', 'c-c': '\x03', 'c-d': '\x04',
    up: csi + 'A', down: csi + 'B', right: csi + 'C', left: csi + 'D',
    home: csi + 'H', end: csi + 'F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
  }[key];
}

for (const b of document.querySelectorAll('#keys button[data-key]')) {
  b.onclick = () => active()?.send({ type: 'input', data: keySeq(b.dataset.key) });
}
$('ctrlkey').onclick = () => setCtrl(!ctrlArmed);
$('pastekey').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) sendText(text, false);
  } catch {
    toast('이 주소에서는 붙여넣기 버튼을 쓸 수 없습니다. 입력창을 길게 눌러 붙여넣으세요', 4000);
    setIme(true);
  }
};
keepFocus($('keys'));
let typingTimer = 0;
function syncTyping() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const el = document.activeElement;
    document.body.classList.toggle('typing', !!el && (el.classList.contains('xterm-helper-textarea') || el.id === 'ime'));
  }, 120);
}
document.addEventListener('focusin', syncTyping);
document.addEventListener('focusout', syncTyping);
keepFocus($('imebar'));

async function loadConfig() {
  try { config = await api('GET', '/config'); } catch {}
  renderSnippets();
}

function renderSnippets() {
  const box = $('snippets');
  box.innerHTML = '';
  for (const cmd of config.snippets) {
    const b = document.createElement('button');
    b.textContent = cmd;
    b.title = `${cmd} 입력 후 실행`;
    b.onclick = () => sendText(cmd, true);
    box.appendChild(b);
  }
  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.textContent = '✎ 편집';
  edit.onclick = () => {
    $('sniptext').value = config.snippets.join('\n');
    $('snipdlg').returnValue = '';
    $('snipdlg').showModal();
  };
  box.appendChild(edit);
}
keepFocus($('snippets'));

function setSnippets(on) {
  $('snippets').hidden = !on;
  $('snippettoggle').classList.toggle('on', on);
  LS.set('snippetsOn', on);
}
$('snippettoggle').onclick = () => setSnippets($('snippets').hidden);

$('snipdlg').addEventListener('close', async () => {
  if ($('snipdlg').returnValue !== 'ok') return;
  try {
    config = await api('PUT', '/config', { snippets: $('sniptext').value.split('\n') });
    renderSnippets();
  } catch (e) {
    toast(e.message);
  }
});

async function uploadFiles(files, c = active()) {
  if (!c) return toast('먼저 세션을 선택하세요');
  const paths = [];
  for (const f of files) {
    toast(`업로드 중: ${f.name}`, 120000);
    const fd = new FormData();
    fd.append('file', f, f.name);
    try {
      paths.push((await api('POST', `/sessions/${enc(c.name)}/upload`, fd)).path);
    } catch (e) {
      return toast(`업로드 실패: ${e.message}`, 5000);
    }
  }
  toast(`업로드 완료 → ${paths.join(', ')}`, 4000);
  setIme(true, false);
  const box = boxOf(c);
  if (box === ime && draftOwner === null) draftOwner = c.name;
  if (box.value && !/\s$/.test(box.value)) box.value += ' ';
  box.value += paths.join(' ') + ' ';
  if (box === ime) autoGrow(); else growBox(c);
}

$('attach').onclick = () => $('file').click();
$('file').onchange = () => {
  uploadFiles([...$('file').files]);
  $('file').value = '';
};

const termEl = $('term');
let dropTimer = null;
function dropConn(target) {
  const name = target?.closest?.('.pane')?.dataset.name;
  return (name && conns.get(name)) || active();
}
function markDrop(c) {
  for (const p of document.querySelectorAll('.pane.filedrop')) if (p !== c?.el) p.classList.remove('filedrop');
  c?.el.classList.add('filedrop');
  if (c) c.el.dataset.drop = `여기에 놓으면 ${c.name} 세션 폴더에 올립니다`;
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => markDrop(null), 200);
}
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  const c = dropConn(e.target);
  e.dataTransfer.dropEffect = c ? 'copy' : 'none';
  markDrop(c);
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  markDrop(null);
  const files = [...e.dataTransfer.files];
  const c = dropConn(e.target);
  if (!files.length || !c) return toast(files.length ? '먼저 세션을 선택하세요' : '폴더는 올릴 수 없습니다');
  if (activeName !== c.name) activate(c.name, false);
  uploadFiles(files);
});

$('copymode').onclick = async () => {
  const c = active();
  if (!c) return toast('먼저 세션을 선택하세요');
  try {
    $('copytext').textContent = (await api('GET', `/sessions/${enc(c.name)}/capture?lines=3000`)).text;
  } catch (e) {
    return toast(e.message);
  }
  $('copydlg').showModal();
  $('copytext').scrollTop = $('copytext').scrollHeight;
};
$('copyall').onclick = async () => {
  const ok = await copyText($('copytext').textContent);
  toast(ok ? '전체 내용을 복사했습니다' : '복사 실패 · 직접 선택해서 복사하세요');
};
$('copyclose').onclick = () => $('copydlg').close();

for (const b of document.querySelectorAll('dialog [data-close]')) {
  b.onclick = () => b.closest('dialog').close('cancel');
}

let newOpts = {};

$('new').onclick = () => openNewSession();

async function openNewSession(opts = {}) {
  newOpts = opts;
  $('newform').reset();
  $('newerr').textContent = '';
  const last = LS.get('newcmd', 'claude');
  const sel = $('newcmdsel');
  if ([...sel.options].some((o) => o.value === last && o.value !== 'custom')) {
    sel.value = last;
  } else {
    sel.value = 'custom';
    $('newcmd').value = last;
  }
  $('newcmd').hidden = sel.value !== 'custom';
  $('newdir').value = opts.dir || dirInfo.home;
  $('newname').placeholder = autoName($('newdir').value) || '폴더 이름으로 자동';
  $('dirtree').hidden = true;
  $('dirtree').innerHTML = '';
  $('newdlg').showModal();
  try {
    const r = await api('GET', '/dirs');
    const untouched = $('newdir').value === dirInfo.home;
    dirInfo = r;
    if (untouched) {
      $('newdir').value = r.home;
      $('newname').placeholder = autoName(r.home);
    }
    $('dirlist').innerHTML = '';
    for (const d of r.dirs) {
      const o = document.createElement('option');
      o.value = d;
      $('dirlist').appendChild(o);
    }
  } catch {}
}

let dirInfo = { home: '', root: '', dirs: [] };

function pickDir(path) {
  $('newdir').value = path;
  $('newname').placeholder = autoName(path) || '폴더 이름으로 자동';
  for (const r of $('dirtree').querySelectorAll('.drow')) r.classList.toggle('sel', r.dataset.path === path);
}

function dirNode(path, label) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'drow';
  row.dataset.path = path;
  row.innerHTML = '<span class="dtw">▸</span><span class="dname"></span>';
  row.querySelector('.dname').textContent = label;
  row.title = path;
  const depth = path === dirInfo.root ? 0 : path.slice(dirInfo.root.length).split('/').length - 1;
  row.style.paddingLeft = `${6 + depth * 16}px`;
  li.appendChild(row);
  const tw = row.querySelector('.dtw');
  const toggle = async () => {
    const sub = li.querySelector(':scope > ul');
    if (sub) {
      sub.remove();
      tw.textContent = '▸';
      return null;
    }
    tw.textContent = '▾';
    const ul = document.createElement('ul');
    li.appendChild(ul);
    let r;
    try {
      r = await api('GET', `/files/list?path=${enc(path)}`);
    } catch (e) {
      ul.innerHTML = `<li class="dmsg" style="padding-left:${22 + depth * 16}px"></li>`;
      ul.firstChild.textContent = e.message;
      return ul;
    }
    const dirs = r.entries.filter((e) => e.dir && !e.name.startsWith('.'));
    if (!dirs.length) {
      ul.innerHTML = `<li class="dmsg" style="padding-left:${22 + depth * 16}px">하위 폴더 없음</li>`;
      tw.textContent = '·';
    }
    for (const e of dirs) ul.appendChild(dirNode(`${r.path}/${e.name}`, e.name));
    return ul;
  };
  li.expand = async () => {
    if (!li.querySelector(':scope > ul')) await toggle();
  };
  tw.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  row.onclick = () => pickDir(path);
  row.ondblclick = () => toggle();
  return li;
}

async function openDirTree() {
  const tree = $('dirtree');
  if (!tree.hidden) {
    tree.hidden = true;
    return;
  }
  if (!dirInfo.root) {
    try { dirInfo = await api('GET', '/dirs'); } catch (e) { return toast(e.message); }
  }
  tree.hidden = false;
  tree.innerHTML = '';
  const rootLi = dirNode(dirInfo.root, `~ (${dirInfo.root})`);
  tree.appendChild(rootLi);
  await rootLi.expand();
  const want = $('newdir').value.replace(/\/+$/, '');
  if (want.startsWith(`${dirInfo.root}/`)) {
    let acc = dirInfo.root;
    for (const part of want.slice(dirInfo.root.length + 1).split('/')) {
      acc += `/${part}`;
      const row = [...tree.querySelectorAll('.drow')].find((r) => r.dataset.path === acc);
      if (!row) break;
      if (acc !== want) await row.parentElement.expand();
    }
  }
  pickDir(want || dirInfo.root);
  tree.querySelector('.drow.sel')?.scrollIntoView({ block: 'nearest' });
}

$('dirbrowse').onclick = openDirTree;

const autoName = (dir) => dir.replace(/\/+$/, '').split('/').pop().replace(/[.:]/g, '_');
$('newdir').addEventListener('input', () => { $('newname').placeholder = autoName($('newdir').value) || '폴더 이름으로 자동'; });
$('newcmdsel').onchange = () => {
  $('newcmd').hidden = $('newcmdsel').value !== 'custom';
  if (!$('newcmd').hidden) $('newcmd').focus();
};

$('newform').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const dir = $('newdir').value.trim();
  const name = $('newname').value.trim() || autoName(dir);
  if (!name) return ($('newerr').textContent = '세션 이름이나 작업 폴더를 입력하세요');
  const sel = $('newcmdsel').value;
  const command = sel === 'custom' ? $('newcmd').value.trim() : sel;
  try {
    await api('POST', '/sessions', { name, cwd: dir || null, command: command || null });
  } catch (err) {
    return ($('newerr').textContent = err.message);
  }
  LS.set('newcmd', command);
  $('newdlg').close();
  if (newOpts.group) await api('PUT', `/sessions/${enc(name)}/group`, { group: newOpts.group }).catch(() => {});
  await refresh();
  openSession(name);
});

const snapTime = (n) => n.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*$/, '$1-$2-$3 $4:$5:$6');

async function loadPersist() {
  let r;
  try {
    r = await api('GET', '/persist');
  } catch (e) {
    $('persiststatus').textContent = e.message;
    return;
  }
  const on = r.installed;
  $('persistsave').disabled = !on;
  $('persistrestore').disabled = !on || !r.snapshots.length;
  $('persiststatus').textContent = !on
    ? 'tmux-persist가 설치되어 있지 않습니다. 설치 스크립트를 --with-persist 옵션으로 실행하세요.'
    : `자동 저장: ${r.auto ? '켜짐 (5분마다)' : '꺼짐'} · 스냅샷 ${r.snapshots.length}개 · 복원할 때 이미 있는 세션은 건너뜁니다`;
  const ul = $('persistlist');
  ul.innerHTML = '';
  for (const sn of r.snapshots) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="pt"></span><span class="pn"></span><button>복원</button>';
    li.querySelector('.pt').textContent = snapTime(sn.name);
    li.querySelector('.pn').textContent = `${sn.sessions.length}개: ${sn.sessions.join(', ')}`;
    li.querySelector('.pn').title = sn.sessions.join('\n');
    if (sn.latest) {
      const b = document.createElement('span');
      b.className = 'pl';
      b.textContent = '최신';
      li.insertBefore(b, li.querySelector('button'));
    }
    li.querySelector('button').disabled = !on;
    li.querySelector('button').onclick = () => restoreSnapshot(sn.name);
    ul.appendChild(li);
  }
  if (!r.snapshots.length) {
    const li = document.createElement('li');
    li.className = 'pn';
    li.textContent = '저장된 스냅샷이 없습니다';
    ul.appendChild(li);
  }
}

function openPersist() {
  $('persiststatus').textContent = '불러오는 중…';
  $('persistlist').innerHTML = '';
  $('persistdlg').showModal();
  loadPersist();
}

async function restoreSnapshot(name) {
  const label = name ? snapTime(name) : '최신 스냅샷';
  if (!confirm(`${label}에서 세션을 복원할까요? 이미 있는 세션은 건너뜁니다.`)) return;
  try {
    const r = await api('POST', '/persist/restore', { snapshot: name || null });
    const m = /restored (\d+) sessions? from (\S+)(?: \(skipped existing: (.+)\))?/.exec(r.output || '');
    toast(m ? `세션 ${m[1]}개를 복원했습니다${m[3] ? ` (이미 있어서 건너뜀: ${m[3]})` : ''}` : r.output || '복원했습니다', 6000);
  } catch (e) {
    return toast(`복원 실패: ${e.message}`, 6000);
  }
  refresh();
  loadPersist();
}

$('persistbtn').onclick = openPersist;
$('persistsave').onclick = async () => {
  $('persistsave').disabled = true;
  try {
    await api('POST', '/persist/save');
    toast('현재 세션을 저장했습니다');
  } catch (e) {
    toast(`저장 실패: ${e.message}`, 6000);
  }
  loadPersist();
};
$('persistrestore').onclick = () => restoreSnapshot(null);

let swReg = null;

async function initServiceWorker() {
  if ('serviceWorker' in navigator && isSecureContext) {
    try {
      swReg = await navigator.serviceWorker.register(`${base}/sw.js`, { scope: `${base}/` });
    } catch (e) {
      console.warn('service worker 등록 실패', e);
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.open) openSession(e.data.open);
    });
  }
  updateNotifyButton();
}

async function currentSubscription() {
  if (!swReg || !('PushManager' in window)) return null;
  return swReg.pushManager.getSubscription().catch(() => null);
}

async function updateNotifyButton() {
  const sub = await currentSubscription();
  $('notify').textContent = sub ? '🔔' : '🔕';
  $('notify').classList.toggle('on', !!sub);
}

function b64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

$('notify').onclick = async () => {
  if (!isSecureContext) return toast('알림은 HTTPS 주소에서만 켤 수 있습니다', 5000);
  if (!swReg || !('PushManager' in window)) {
    return toast('이 브라우저는 알림을 지원하지 않습니다 (iPhone은 홈 화면에 추가한 앱에서만 가능)', 5000);
  }
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
      toast('알림을 껐습니다');
    } else {
      if ((await Notification.requestPermission()) !== 'granted') return toast('알림 권한이 거부되었습니다');
      const { key } = await api('GET', '/push/key');
      const s = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      const j = s.toJSON();
      await api('POST', '/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
      await api('POST', '/push/test');
      toast('알림을 켰습니다. 테스트 알림을 보냈습니다', 4000);
    }
  } catch (e) {
    toast('알림 설정 실패: ' + e.message, 5000);
  }
  updateNotifyButton();
};

const VIEWER_CSS = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/styles/github-dark.min.css';
const VIEWER_JS = [
  'https://cdn.jsdelivr.net/npm/marked@18.0.14/lib/marked.umd.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/highlight.min.js',
];
let viewerLibs = null;

function loadViewerLibs() {
  if (!viewerLibs) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = VIEWER_CSS;
    document.head.appendChild(link);
    viewerLibs = Promise.all(VIEWER_JS.map((src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`불러오기 실패: ${src}`));
      document.head.appendChild(s);
    })));
    viewerLibs.catch(() => { viewerLibs = null; });
  }
  return viewerLibs;
}

const fb = {
  path: null, root: '', session: null, file: null, text: '', truncated: false, rawMd: false,
  meta: null, editing: false, dirty: false,
};
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const MD_EXT = /\.(md|markdown|mdx)$/i;
const LANG_BY_EXT = {
  c: 'c', h: 'c', dts: 'c', dtsi: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  py: 'python', js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  sh: 'bash', bash: 'bash', zsh: 'bash', bb: 'bash', bbappend: 'bash', bbclass: 'bash',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  xml: 'xml', arxml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', css: 'css', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', cmake: 'cmake', mk: 'makefile', diff: 'diff', patch: 'diff',
  sql: 'sql', rb: 'ruby', lua: 'lua', proto: 'protobuf',
};
const rawUrl = (p, download) => `${base}/api/files/raw?path=${enc(p)}${download ? '&download=1' : ''}`;

function langOf(name) {
  if (/^(GNU)?[Mm]akefile$/.test(name)) return 'makefile';
  if (name === 'CMakeLists.txt') return 'cmake';
  if (name === 'Dockerfile') return 'dockerfile';
  return LANG_BY_EXT[name.includes('.') ? name.split('.').pop().toLowerCase() : ''];
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fileMsg(text, append = false) {
  const d = document.createElement('div');
  d.className = 'fmsg';
  d.textContent = text;
  if (!append) $('fbody').innerHTML = '';
  $('fbody').appendChild(d);
}

function confirmLeave() {
  if (fb.editing && fb.dirty && !confirm('저장하지 않은 변경 사항이 있습니다. 버리고 나갈까요?')) return false;
  fb.editing = false;
  fb.dirty = false;
  return true;
}

function closeFiles() {
  if (confirmLeave()) $('files').hidden = true;
}

function toggleFiles() {
  const panel = $('files');
  if (!panel.hidden) return closeFiles();
  panel.hidden = false;
  setDrawer(false);
  if (!fb.path || fb.session !== activeName) {
    fb.session = activeName;
    listDir(sessions.find((s) => s.name === activeName)?.path || null);
  }
}

async function listDir(path) {
  if (!confirmLeave()) return;
  let r;
  try {
    r = await api('GET', `/files/list${path ? `?path=${enc(path)}` : ''}`);
  } catch (e) {
    if (fb.path && !fb.file) return toast(e.message, 4000);
    if (path) {
      toast(e.message, 4000);
      return listDir(null);
    }
    return fileMsg(e.message);
  }
  const samePath = fb.path === r.path;
  fb.path = r.path;
  fb.root = r.root;
  fb.file = null;
  fb.fileEdit = r.file_edit;
  $('fmenu').hidden = false;
  $('fback').hidden = true;
  $('ftools').hidden = true;
  renderCrumb(r.path, false);
  const ul = document.createElement('ul');
  ul.className = 'flist';
  if (!samePath) clearSel();
  const keep = new Set(sel.paths);
  sel.rows = [];
  sel.paths.clear();
  if (r.parent) ul.appendChild(fileRow({ name: '..', dir: true }, r.parent));
  const items = r.entries.filter((e) => $('fshowhidden').checked || !e.name.startsWith('.'));
  for (const e of items) ul.appendChild(fileRow(e, `${r.path}/${e.name}`));
  $('fbody').innerHTML = '';
  $('fbody').appendChild(ul);
  for (const row of sel.rows) if (keep.has(row.full)) sel.paths.add(row.full);
  updateSel();
  if (!items.length) fileMsg('빈 폴더입니다', true);
  if (r.truncated) fileMsg('항목이 많아 5000개까지만 표시했습니다', true);
  $('fbody').scrollTop = 0;
}

const sel = { paths: new Set(), sticky: false, last: null, rows: [] };

function selecting() {
  return sel.sticky || sel.paths.size > 0;
}

function updateSel() {
  const n = sel.paths.size;
  $('files').classList.toggle('selecting', selecting());
  for (const row of sel.rows) {
    const on = sel.paths.has(row.full);
    row.li.classList.toggle('selected', on);
    row.box.checked = on;
  }
  $('fselbar').hidden = !selecting() || !!fb.file;
  $('fselcount').textContent = `${n}개 선택`;
  const off = !fb.fileEdit;
  for (const act of ['copy', 'cut', 'delete']) {
    const b = $('fselbar').querySelector(`[data-act="${act}"]`);
    b.disabled = !n || off;
    b.title = off ? '서버 설정에서 파일 수정을 켜야 합니다' : '';
  }
  $('fselbar').querySelector('[data-act="insert"]').disabled = !n;
}

function clearSel() {
  sel.paths.clear();
  sel.sticky = false;
  sel.last = null;
  updateSel();
}

function toggleSel(idx) {
  const { full } = sel.rows[idx];
  if (sel.paths.has(full)) sel.paths.delete(full); else sel.paths.add(full);
  sel.last = idx;
  updateSel();
}

function rangeSel(idx) {
  const from = sel.last ?? idx;
  const [a, b] = from < idx ? [from, idx] : [idx, from];
  for (let i = a; i <= b; i++) sel.paths.add(sel.rows[i].full);
  updateSel();
}

function selectAll() {
  for (const row of sel.rows) sel.paths.add(row.full);
  updateSel();
}

function fileRow(e, full) {
  const li = document.createElement('li');
  li.innerHTML = '<input type="checkbox" class="fsel" tabindex="-1"><span class="fic"></span><span class="fn"></span><span class="fm"></span><button class="fmore" title="메뉴">⋯</button>';
  const icon = e.name === '..' ? '⬆' : e.dir ? '📁' : IMG_EXT.test(e.name) ? '🖼' : MD_EXT.test(e.name) ? '📝' : '📄';
  li.querySelector('.fic').textContent = icon;
  li.querySelector('.fn').textContent = e.name + (e.link ? ' ↪' : '');
  if (!e.dir && e.mtime) li.querySelector('.fm').textContent = `${fmtSize(e.size)} · ${ago(e.mtime)}`;
  const box = li.querySelector('.fsel');
  const more = li.querySelector('.fmore');
  if (e.name === '..') {
    box.remove();
    more.remove();
    li.onclick = () => listDir(full);
    return li;
  }
  const idx = sel.rows.length;
  sel.rows.push({ e, full, li, box });

  li.onclick = (ev) => {
    if (li.dataset.longpress) {
      delete li.dataset.longpress;
      return;
    }
    if (ev.shiftKey && sel.last !== null) return rangeSel(idx);
    if (ev.ctrlKey || ev.metaKey || selecting()) return toggleSel(idx);
    if (e.dir) listDir(full); else openFile(full);
  };
  box.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.shiftKey && sel.last !== null) rangeSel(idx); else toggleSel(idx);
  };
  const menuFor = () => {
    if (sel.paths.size > 1 && sel.paths.has(full)) return bulkMenu([...sel.paths]);
    if (!sel.paths.has(full) && !sel.sticky) clearSel();
    return entryMenu(e, full, idx);
  };
  more.onclick = (ev) => {
    ev.stopPropagation();
    const r = more.getBoundingClientRect();
    openCtx(r.right, r.bottom, menuFor());
  };
  li.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openCtx(ev.clientX, ev.clientY, menuFor());
  });
  let timer = null;
  let x0 = 0;
  let y0 = 0;
  li.addEventListener('touchstart', (ev) => {
    x0 = ev.touches[0].clientX;
    y0 = ev.touches[0].clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      li.dataset.longpress = '1';
      navigator.vibrate?.(20);
      openCtx(x0, y0, menuFor());
    }, 500);
  }, { passive: true });
  li.addEventListener('touchmove', (ev) => {
    const t = ev.touches[0];
    if (Math.hypot(t.clientX - x0, t.clientY - y0) > 10) clearTimeout(timer);
  }, { passive: true });
  li.addEventListener('touchend', (ev) => {
    clearTimeout(timer);
    if (li.dataset.longpress) {
      ev.preventDefault();
      delete li.dataset.longpress;
    }
  }, { passive: false });
  li.addEventListener('touchcancel', () => clearTimeout(timer));
  return li;
}

const ctx = { clip: null };

function closeCtx() {
  $('ctxmenu').hidden = true;
}

function openCtx(x, y, items) {
  const m = $('ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctxsep';
      m.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.className = `ctxi${it.danger ? ' danger' : ''}`;
    b.textContent = it.label;
    if (it.disabled) {
      b.disabled = true;
      if (typeof it.disabled === 'string') b.title = it.disabled;
    }
    b.onclick = () => {
      closeCtx();
      it.run();
    };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

const editOff = () => (fb.fileEdit ? false : '서버 설정에서 파일 수정을 켜야 합니다');
const baseName = (p) => p.split('/').pop();

function clipLabel() {
  const { paths } = ctx.clip;
  return paths.length > 1 ? `${baseName(paths[0])} 외 ${paths.length - 1}개` : baseName(paths[0]);
}

function entryMenu(e, full, idx) {
  const off = editOff();
  const items = [
    { label: '열기', run: () => (e.dir ? listDir(full) : openFile(full)) },
    {
      label: '선택',
      run: () => {
        sel.sticky = true;
        if (!sel.paths.has(full)) toggleSel(idx); else updateSel();
      },
    },
    { label: '입력창에 경로 넣기', run: () => insertPath(full) },
    { label: '경로 복사', run: () => copyText(full).then((ok) => toast(ok ? '경로를 복사했습니다' : '복사 실패')) },
  ];
  if (!e.dir) items.push({ label: '내려받기', run: () => downloadFile(full) });
  items.push('-',
    { label: '복사', disabled: off, run: () => setClip('copy', full) },
    { label: '잘라내기', disabled: off, run: () => setClip('move', full) });
  if (e.dir && ctx.clip) items.push({ label: `여기에 붙여넣기 (${clipLabel()})`, disabled: off, run: () => pasteInto(full) });
  if (!e.dir) items.push({ label: '복제', disabled: off, run: () => transfer([full], fb.path, 'copy') });
  items.push(
    { label: '이름 바꾸기', disabled: off, run: () => renameEntry(full) },
    '-',
    { label: '삭제 (휴지통으로)', danger: true, disabled: off, run: () => deleteEntry(full) },
  );
  return items;
}

function bulkMenu(paths) {
  const off = editOff();
  return [
    { label: `${paths.length}개 선택됨`, disabled: true, run() {} },
    { label: '입력창에 경로 넣기', run: () => insertPaths(paths) },
    { label: '경로 복사', run: () => copyText(paths.join('\n')).then((ok) => toast(ok ? `경로 ${paths.length}개를 복사했습니다` : '복사 실패')) },
    '-',
    { label: '복사', disabled: off, run: () => setClip('copy', paths) },
    { label: '잘라내기', disabled: off, run: () => setClip('move', paths) },
    '-',
    { label: `삭제 (${paths.length}개, 휴지통으로)`, danger: true, disabled: off, run: () => deleteMany(paths) },
    '-',
    { label: '선택 해제', run: clearSel },
  ];
}

function folderMenu() {
  const off = editOff();
  return [
    {
      label: selecting() ? '선택 끝내기' : '여러 개 선택',
      run: () => {
        if (selecting()) return clearSel();
        sel.sticky = true;
        updateSel();
      },
    },
    { label: '전체 선택', run: () => { sel.sticky = true; selectAll(); } },
    '-',
    { label: '새 파일', disabled: off, run: () => newEntry('file') },
    { label: '새 폴더', disabled: off, run: () => newEntry('dir') },
    {
      label: ctx.clip ? `붙여넣기 (${clipLabel()})` : '붙여넣기',
      disabled: off || (!ctx.clip && '복사하거나 잘라낸 항목이 없습니다'),
      run: () => pasteInto(fb.path),
    },
    '-',
    { label: '입력창에 이 폴더 경로 넣기', run: () => insertPath(fb.path) },
    { label: '새로고침', run: () => listDir(fb.path) },
  ];
}

function setClip(mode, pathOrPaths) {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  ctx.clip = { mode, paths };
  clearSel();
  toast(`${mode === 'copy' ? '복사' : '잘라내기'}: ${clipLabel()} · 붙여넣을 폴더의 메뉴에서 '붙여넣기'`, 4000);
}

async function pasteInto(dir) {
  if (!ctx.clip) return;
  const { mode, paths } = ctx.clip;
  if (await transfer(paths, dir, mode) && mode === 'move') ctx.clip = null;
}

function reportFailures(r, verb) {
  if (r.failed?.length) {
    toast(`${verb} 실패: ${r.failed.map((f) => `${baseName(f.path)} (${f.error})`).join(', ')}`, 6000);
    return false;
  }
  return true;
}

async function transfer(paths, dest, mode) {
  let r;
  try {
    r = await api('POST', '/files/transfer', { paths, dest, mode });
  } catch (e) {
    toast(e.message, 5000);
    return false;
  }
  const ok = reportFailures(r, mode === 'copy' ? '복사' : '이동');
  if (ok && r.done.length) toast(`${mode === 'copy' ? '복사' : '이동'} 완료: ${r.done.map(baseName).join(', ')}`);
  listDir(fb.path);
  return ok;
}

async function renameEntry(full) {
  const name = prompt('새 이름', baseName(full));
  if (!name || name === baseName(full)) return;
  try {
    await api('POST', '/files/rename', { path: full, new_name: name });
  } catch (e) {
    return toast(e.message, 5000);
  }
  if (ctx.clip?.paths.includes(full)) ctx.clip = null;
  listDir(fb.path);
}

function deleteEntry(full) {
  return deleteMany([full]);
}

async function deleteMany(paths) {
  const what = paths.length > 1 ? `${paths.length}개 항목(${paths.slice(0, 3).map(baseName).join(', ')}${paths.length > 3 ? ' …' : ''})` : `'${baseName(paths[0])}'`;
  if (!confirm(`${what}을(를) 휴지통으로 옮길까요?`)) return;
  let r;
  try {
    r = await api('POST', '/files/delete', { paths });
  } catch (e) {
    return toast(e.message, 5000);
  }
  if (reportFailures(r, '삭제')) toast(`휴지통으로 옮겼습니다: ${r.done.length}개`);
  if (ctx.clip?.paths.some((p) => r.done.includes(p))) ctx.clip = null;
  clearSel();
  listDir(fb.path);
}

async function newEntry(kind) {
  const name = prompt(kind === 'dir' ? '새 폴더 이름' : '새 파일 이름');
  if (!name?.trim()) return;
  let r;
  try {
    r = await api('POST', '/files/new', { folder: fb.path, name: name.trim(), kind });
  } catch (e) {
    return toast(e.message, 5000);
  }
  if (kind === 'dir') return listDir(fb.path);
  await openFile(r.path);
  startEdit();
}

function downloadFile(path) {
  const a = document.createElement('a');
  a.href = rawUrl(path, true);
  a.download = baseName(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) closeCtx(); }, true);
document.addEventListener('touchstart', (e) => { if (!e.target.closest('#ctxmenu')) closeCtx(); }, { capture: true, passive: true });
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
    const i = +e.code.slice(5) - 1;
    if (desks[i]) {
      e.preventDefault();
      switchDesk(i);
    }
    return;
  }
  if (e.key === 'Escape' && !$('ctxmenu').hidden) return closeCtx();
  if ($('files').hidden || fb.file || !fb.path) return;
  if (e.target.closest('input, textarea, select, [contenteditable], .xterm, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const picked = [...sel.paths];
  if (e.key === 'Escape' && selecting()) {
    clearSel();
  } else if (mod && key === 'a') {
    selectAll();
  } else if ((e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) && picked.length) {
    if (fb.fileEdit) deleteMany(picked);
  } else if (mod && (key === 'c' || key === 'x') && picked.length) {
    if (fb.fileEdit) setClip(key === 'c' ? 'copy' : 'move', picked);
  } else if (mod && key === 'v' && ctx.clip) {
    if (fb.fileEdit) pasteInto(fb.path);
  } else {
    return;
  }
  e.preventDefault();
});

for (const b of document.querySelectorAll('#fselbar [data-act]')) {
  b.onclick = () => {
    const picked = [...sel.paths];
    const act = b.dataset.act;
    if (act === 'copy' || act === 'cut') setClip(act === 'copy' ? 'copy' : 'move', picked);
    else if (act === 'delete') deleteMany(picked);
    else if (act === 'insert') insertPaths(picked);
    else if (act === 'all') selectAll();
    else if (act === 'clear') clearSel();
  };
}
window.addEventListener('resize', closeCtx);
$('fbody').addEventListener('scroll', closeCtx);
$('fbody').addEventListener('contextmenu', (e) => {
  if (fb.editing) return;
  if (fb.file) {
    e.preventDefault();
    const sel = window.getSelection().toString();
    openCtx(e.clientX, e.clientY, [
      { label: sel ? `선택 영역 복사 (${sel.length}자)` : '선택 영역 복사', disabled: !sel, run: () => copyToast(sel) },
      { label: '파일 전체 복사', disabled: !fb.text, run: () => copyToast(fb.text) },
      { label: '경로 복사', run: () => copyToast(fb.file, '경로를 복사했습니다') },
      '-',
      { label: '입력창에 경로 넣기', run: () => insertPath(fb.file) },
    ]);
    return;
  }
  if (!fb.path) return;
  e.preventDefault();
  openCtx(e.clientX, e.clientY, folderMenu());
});

function copyToast(text, msg) {
  return copyText(text).then((ok) => toast(ok ? msg || `복사했습니다 (${text.length}자)` : '복사 실패', 1200));
}

$('fbody').addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !fb.file || fb.editing) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString();
    if (!text.trim() || !$('fbody').contains(sel.anchorNode)) return;
    copyToast(text);
  }, 0);
});
$('fmenu').onclick = () => {
  const r = $('fmenu').getBoundingClientRect();
  openCtx(r.right, r.bottom, folderMenu());
};

function renderCrumb(path, isFile) {
  const box = $('fcrumb');
  box.innerHTML = '';
  const add = (label, target) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (target) b.onclick = () => listDir(target); else b.disabled = true;
    box.appendChild(b);
  };
  const rel = path === fb.root ? '' : path.slice(fb.root.length + 1);
  const parts = rel ? rel.split('/') : [];
  add('~', parts.length || isFile ? fb.root : null);
  let acc = fb.root;
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    box.appendChild(sep);
    acc += `/${p}`;
    add(p, i === parts.length - 1 ? null : acc);
  });
  box.scrollLeft = box.scrollWidth;
}

async function openFile(path) {
  if (!confirmLeave()) return;
  const name = path.split('/').pop();
  fb.file = path;
  fb.rawMd = false;
  fb.meta = null;
  setEditUI(false);
  updateSel();
  renderCrumb(path, true);
  $('fback').hidden = false;
  $('fmenu').hidden = true;
  $('ftools').hidden = false;
  $('fname').textContent = name;
  $('fdownload').href = rawUrl(path, true);
  $('fmdtoggle').hidden = !MD_EXT.test(name);
  if (IMG_EXT.test(name)) {
    const d = document.createElement('div');
    d.className = 'fimg';
    const img = new Image();
    img.src = rawUrl(path);
    img.alt = name;
    d.appendChild(img);
    $('fbody').innerHTML = '';
    $('fbody').appendChild(d);
    return;
  }
  fileMsg('불러오는 중…');
  let r;
  try {
    [r] = await Promise.all([api('GET', `/files/read?path=${enc(path)}`), loadViewerLibs().catch(() => null)]);
  } catch (e) {
    return fileMsg(e.message);
  }
  if (fb.file !== path) return;
  if (r.binary) return fileMsg(`바이너리 파일입니다 (${fmtSize(r.size)}). 내려받기로 확인하세요.`);
  fb.text = r.text;
  fb.truncated = r.truncated;
  fb.meta = r;
  renderFile();
}

function setEditUI(on) {
  const name = fb.file ? fb.file.split('/').pop() : '';
  $('fedit').hidden = on || !fb.meta?.editable;
  $('fsave').hidden = !on;
  $('fcancel').hidden = !on;
  $('fmdtoggle').hidden = on || !MD_EXT.test(name);
  $('finsert').hidden = on;
  $('fbody').classList.toggle('editing', on);
  $('fname').textContent = (on && fb.dirty ? '● ' : '') + name;
}

function indentUnit(text, file) {
  if (/(^|\/)(GNU)?[Mm]akefile$|\.mk$/.test(file) || /^\t/m.test(text)) return '\t';
  const m = text.match(/^( {2,8})\S/m);
  return m ? m[1] : '    ';
}

function startEdit() {
  if (!fb.meta?.editable) return;
  fb.editing = true;
  fb.dirty = false;
  const body = $('fbody');
  body.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.id = 'feditor';
  ta.value = fb.text;
  ta.spellcheck = false;
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.wrap = 'off';
  const indent = indentUnit(fb.text, fb.file);
  ta.addEventListener('input', () => {
    if (!fb.dirty) {
      fb.dirty = true;
      setEditUI(true);
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveFile(true);
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      ta.setRangeText(indent, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  body.appendChild(ta);
  setEditUI(true);
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

async function saveFile(stay = false, force = false) {
  const ta = $('feditor');
  if (!ta || !fb.editing) return;
  $('fsave').disabled = true;
  let r;
  try {
    r = await api('PUT', '/files/write', {
      path: fb.file,
      text: ta.value,
      mtime: force ? null : fb.meta.mtime,
      encoding: fb.meta.encoding,
      newline: fb.meta.newline,
    });
  } catch (e) {
    if (e.status === 409 && confirm('다른 곳(터미널 등)에서 파일이 바뀌었습니다. 지금 편집한 내용으로 덮어쓸까요?')) {
      $('fsave').disabled = false;
      return saveFile(stay, true);
    }
    toast(`저장 실패: ${e.message}`, 5000);
    return;
  } finally {
    $('fsave').disabled = false;
  }
  fb.text = ta.value;
  fb.meta.mtime = r.mtime;
  fb.dirty = false;
  toast('저장했습니다');
  if (stay) {
    setEditUI(true);
  } else {
    fb.editing = false;
    renderFile();
  }
}

function cancelEdit() {
  if (!confirmLeave()) return;
  renderFile();
}

function renderFile() {
  const body = $('fbody');
  const name = fb.file.split('/').pop();
  fb.editing = false;
  setEditUI(false);
  body.innerHTML = '';
  if (MD_EXT.test(name) && !fb.rawMd && window.marked && window.DOMPurify) {
    const div = document.createElement('div');
    div.className = 'md';
    div.innerHTML = DOMPurify.sanitize(marked.parse(fb.text));
    fixMdLinks(div, fb.file);
    if (window.hljs) div.querySelectorAll('pre code').forEach((el) => { try { hljs.highlightElement(el); } catch {} });
    addCopyButtons(div);
    body.appendChild(div);
  } else {
    body.appendChild(codeView(fb.text, MD_EXT.test(name) ? 'markdown' : langOf(name)));
  }
  if (fb.truncated) fileMsg('파일이 커서 앞부분 2MB만 표시했습니다', true);
  $('fmdtoggle').textContent = fb.rawMd ? '문서 보기' : '원문';
  body.scrollTop = 0;
}

function codeView(text, lang) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const src = lines.join('\n');
  const wrap = document.createElement('div');
  wrap.className = 'code';
  const ln = document.createElement('pre');
  ln.className = 'ln';
  ln.textContent = lines.map((_, i) => i + 1).join('\n');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = src;
  if (window.hljs && src.length < 500000) {
    try {
      const known = lang && hljs.getLanguage(lang);
      const r = known
        ? hljs.highlight(src, { language: lang, ignoreIllegals: true })
        : src.length < 100000 ? hljs.highlightAuto(src) : null;
      if (r) {
        code.innerHTML = r.value;
        code.className = 'hljs';
      }
    } catch {}
  }
  pre.appendChild(code);
  wrap.append(ln, pre);
  return wrap;
}

function fixMdLinks(div, file) {
  const dir = file.slice(0, file.lastIndexOf('/'));
  const isRelative = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(u);
  const resolve = (u) => {
    let p = u.split('#')[0].split('?')[0];
    try { p = decodeURI(p); } catch {}
    const out = [];
    for (const part of `${dir}/${p}`.split('/')) {
      if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    }
    return '/' + out.join('/');
  };
  for (const img of div.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (isRelative(src)) img.src = rawUrl(resolve(src));
  }
  for (const a of div.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (isRelative(href)) {
      const target = resolve(href);
      a.href = '#';
      a.onclick = (e) => {
        e.preventDefault();
        if (/\.[^/]+$/.test(target)) openFile(target); else listDir(target);
      };
    } else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
}

function insertPath(p) {
  insertPaths([p]);
}

function insertPaths(paths) {
  const cur = sessions.find((s) => s.name === activeName);
  const rels = paths.map((p) => {
    const rel = cur?.path && p.startsWith(`${cur.path}/`) ? p.slice(cur.path.length + 1) : p;
    return /\s/.test(rel) ? `"${rel}"` : rel;
  });
  setIme(true, false);
  if (ime.value && !/\s$/.test(ime.value)) ime.value += ' ';
  ime.value += `${rels.join(' ')} `;
  autoGrow();
  toast(rels.length > 1 ? `입력창에 경로 ${rels.length}개를 넣었습니다` : `입력창에 넣음: ${rels[0]}`);
  clearSel();
  if (narrow.matches) $('files').hidden = true;
}

$('filesbtn').onclick = toggleFiles;
$('fclose').onclick = closeFiles;
$('fedit').onclick = startEdit;
$('fsave').onclick = () => saveFile(false);
$('fcancel').onclick = cancelEdit;
window.addEventListener('beforeunload', (e) => {
  if (fb.editing && fb.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
$('fback').onclick = () => listDir(fb.path);
$('finsert').onclick = () => fb.file && insertPath(fb.file);
$('fmdtoggle').onclick = () => {
  fb.rawMd = !fb.rawMd;
  renderFile();
};
$('fshowhidden').checked = !!LS.get('fshowHidden', false);
$('fshowhidden').onchange = () => {
  LS.set('fshowHidden', $('fshowhidden').checked);
  if (!fb.file && fb.path) listDir(fb.path);
};

function setFontSize(size) {
  fontSize = Math.max(8, Math.min(28, Math.round(size)));
  LS.set('fontSize', fontSize);
  document.documentElement.style.setProperty('--chat-fs', `${fontSize + 2}px`);
  for (const c of conns.values()) {
    c.term.options.fontSize = fontSize;
    fitConn(c);
  }
}
document.documentElement.style.setProperty('--chat-fs', `${fontSize + 2}px`);
$('fontdown').onclick = () => setFontSize(fontSize - 1);
$('fontup').onclick = () => setFontSize(fontSize + 1);

let touch = null;
const inChat = (e) => !!e.target.closest?.('.chat:not([hidden])');
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const cellHeight = (c) => c.el.clientHeight / c.term.rows || 16;

termEl.addEventListener('touchstart', (e) => {
  const name = e.target.closest('.pane')?.dataset.name;
  if (name && name !== activeName) activate(name, false);
  const t = e.touches;
  if (t.length === 2) {
    touch = { mode: 'pinch', startDist: dist(t), startSize: fontSize };
  } else if (inChat(e)) {
    touch = null;
  } else if (t.length === 1) {
    touch = { mode: 'pending', x0: t[0].clientX, y0: t[0].clientY, y: t[0].clientY, acc: 0 };
  }
}, { passive: true, capture: true });

termEl.addEventListener('touchmove', (e) => {
  if (!touch) return;
  const t = e.touches;
  if (touch.mode !== 'pending') e.stopPropagation();
  if (touch.mode === 'pinch' && t.length === 2) {
    e.preventDefault();
    const size = (touch.startSize * dist(t)) / touch.startDist;
    if (Math.round(size) !== fontSize) setFontSize(size);
    return;
  }
  if (t.length !== 1) return;
  const dx = t[0].clientX - touch.x0;
  const dy = t[0].clientY - touch.y0;
  if (touch.mode === 'pending' && Math.hypot(dx, dy) > 10) {
    touch.mode = touch.x0 < 24 && Math.abs(dx) > Math.abs(dy) ? 'edge' : 'scroll';
  }
  const c = active();
  if (touch.mode === 'edge') {
    e.preventDefault();
    if (dx > 60) {
      setDrawer(true);
      touch = null;
    }
  } else if (touch.mode === 'scroll' && c) {
    e.preventDefault();
    touch.acc += t[0].clientY - touch.y;
    touch.y = t[0].clientY;
    const lines = Math.trunc(touch.acc / cellHeight(c));
    if (lines) {
      touch.acc -= lines * cellHeight(c);
      c.raw({ type: 'scroll', lines });
      if (lines > 0) c.scrolled = true;
    }
  }
}, { passive: false, capture: true });

let wheelAcc = 0;
termEl.addEventListener('wheel', (e) => {
  const name = e.target.closest('.pane')?.dataset.name;
  const c = conns.get(name);
  if (!c || inChat(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const px = e.deltaMode === 1 ? e.deltaY * cellHeight(c) : e.deltaMode === 2 ? e.deltaY * c.el.clientHeight : e.deltaY;
  wheelAcc -= px;
  const lines = Math.trunc(wheelAcc / cellHeight(c));
  if (lines) {
    wheelAcc -= lines * cellHeight(c);
    c.raw({ type: 'scroll', lines });
    if (lines > 0) c.scrolled = true;
  }
}, { passive: false, capture: true });

termEl.addEventListener('touchend', (e) => {
  if (touch && touch.mode !== 'pending') e.preventDefault();
  if (e.touches.length === 0) touch = null;
}, { capture: true });

const setDrawer = (open) => $('app').classList.toggle('drawer', open);

$('menu').onclick = () => {
  const app = $('app');
  if (narrow.matches) return setDrawer(!app.classList.contains('drawer'));
  LS.set('listCollapsed', app.classList.toggle('collapsed'));
  setTimeout(() => conns.forEach(fitConn), 0);
};
$('scrim').onclick = () => setDrawer(false);

let drawerX = null;
const aside = document.querySelector('aside');
aside.addEventListener('touchstart', (e) => { drawerX = e.touches[0].clientX; }, { passive: true });
aside.addEventListener('touchmove', (e) => {
  if (drawerX !== null && e.touches[0].clientX - drawerX < -60) {
    setDrawer(false);
    drawerX = null;
  }
}, { passive: true });

$('split').onclick = () => {
  const g = groupOf(activeName);
  if (!g || g.tabs.length < 2) {
    return toast('이 영역에 탭이 하나뿐입니다. 탭이나 세션을 터미널 가장자리로 끌어다 놓으면 분할됩니다', 4000);
  }
  placeSession(activeName, g.gid, 'right');
};

const dropzone = document.createElement('div');
dropzone.className = 'dropzone';
dropzone.hidden = true;
$('term').appendChild(dropzone);
let dropState = null;

function dropTarget(e) {
  const term = $('term');
  const tr = term.getBoundingClientRect();
  const leafEl = e.target.closest?.('.leaf');
  if (!leafEl || !term.contains(leafEl)) return { target: null, zone: 'center', rect: tr, tr };
  const r = leafEl.getBoundingClientRect();
  if (e.target.closest('.gtabs')) {
    const before = e.target.closest('.gtab')?.dataset.name || null;
    return { target: leafEl.dataset.gid, zone: 'center', before, rect: r, tr };
  }
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const m = Math.min(x, 1 - x, y, 1 - y);
  let zone = 'center';
  if (m < 0.25) zone = m === x ? 'left' : m === 1 - x ? 'right' : m === y ? 'top' : 'bottom';
  const rect = {
    left: zone === 'right' ? r.left + r.width / 2 : r.left,
    top: zone === 'bottom' ? r.top + r.height / 2 : r.top,
    width: zone === 'left' || zone === 'right' ? r.width / 2 : r.width,
    height: zone === 'top' || zone === 'bottom' ? r.height / 2 : r.height,
  };
  return { target: leafEl.dataset.gid, zone, rect, tr };
}

function hideDropzone() {
  dropzone.hidden = true;
  dropState = null;
}

$('term').addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(SESSION_MIME) || narrow.matches) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropState = dropTarget(e);
  const { rect, tr } = dropState;
  Object.assign(dropzone.style, {
    left: `${rect.left - tr.left}px`,
    top: `${rect.top - tr.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  dropzone.hidden = false;
});
$('term').addEventListener('dragleave', (e) => {
  if (!$('term').contains(e.relatedTarget)) hideDropzone();
});
$('term').addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes(SESSION_MIME)) return;
  e.preventDefault();
  const name = e.dataTransfer.getData(SESSION_MIME);
  const st = dropState || dropTarget(e);
  hideDropzone();
  if (name && sessions.some((s) => s.name === name)) placeSession(name, st.target, st.zone, st.before);
});
document.addEventListener('dragend', hideDropzone);
narrow.addEventListener('change', layout);

if (window.visualViewport) {
  const vv = window.visualViewport;
  const fitViewport = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', () => window.scrollTo(0, 0));
  fitViewport();
}

$('refresh').onclick = refresh;
$('logout').onclick = async () => {
  for (const name of [...conns.keys()]) closeSession(name, true);
  await fetch(`${base}/api/logout`, { method: 'POST' });
  toLogin();
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkConnections();
});
window.addEventListener('online', checkConnections);
window.addEventListener('pageshow', (e) => { if (e.persisted) checkConnections(); });

let appVersion = null;

async function checkVersion() {
  let v;
  try {
    v = (await api('GET', '/version')).version;
  } catch {
    return;
  }
  if (appVersion === null) appVersion = v;
  else if (v !== appVersion) $('updatebar').hidden = false;
}

$('updatereload').onclick = () => {
  if (fb.editing && fb.dirty && !confirm('저장하지 않은 파일 변경 사항이 있습니다. 새로고침할까요?')) return;
  location.reload();
};
$('updateclose').onclick = () => { $('updatebar').hidden = true; };

(async function init() {
  setIme(LS.get('imeOn', true), false);
  setSnippets(!!LS.get('snippetsOn', false));
  $('app').classList.toggle('collapsed', !!LS.get('listCollapsed', false));
  if (narrow.matches) ime.placeholder = '입력 후 Enter (줄바꿈: Shift+Enter)';

  await refresh();
  const exists = (n) => sessions.some((s) => s.name === n);
  const saved = LS.get('desks', null) || [{ name: '', tree: LS.get('layout', null), active: LS.get('activeTab', null) }];
  applyDesks(saved, LS.get('deskIdx', 0), LS.get('openTabs', []));
  if (layoutLink) {
    clearTimeout(linkTimer);
    linkTimer = null;
    linkSent = JSON.stringify(layoutBody());
    linkState = 'saved';
  }
  renderLayoutChip();
  const target = new URLSearchParams(location.search).get('s');
  if (target) {
    history.replaceState(null, '', `${base}/`);
    if (exists(target)) openSession(target);
  }
  if (narrow.matches && conns.size === 0) setDrawer(true);
  layout();

  loadConfig();
  initServiceWorker();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
  checkVersion();
  setInterval(checkVersion, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
})();
