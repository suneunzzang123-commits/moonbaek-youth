import { supabase } from './supabase-client.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nextSunday = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + offset);
  return iso(d);
};
const fmt = (d, opts = { month: 'long', day: 'numeric', weekday: 'short' }) =>
  new Intl.DateTimeFormat('ko-KR', opts).format(new Date(`${d}T12:00:00`));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const emptyDb = () => ({ youths: [], attendance: {}, posts: [], meditations: [], events: [], profiles: [] });

let user = null;
let db = emptyDb();
let page = 'dashboard';
let selectedDate = nextSunday();
let rosterFilter = 'active';
let searchTerm = '';
let monthCursor = new Date();
let toastTimer;
let recoveryMode = false;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function activeYouth() {
  return db.youths.filter((y) => y.active);
}

function record(youthId, date = selectedDate) {
  return db.attendance[date]?.[youthId] || '미확인';
}

function counts(date = selectedDate) {
  const result = { 출석: 0, 결석: 0, '사전 연락': 0, 미확인: 0 };
  activeYouth().forEach((youth) => { result[record(youth.id, date)] += 1; });
  return result;
}

function statusClass(status) {
  if (status === '출석') return 'present';
  if (status === '결석') return 'absent';
  if (status === '사전 연락') return 'contact';
  return 'unknown';
}

async function boot() {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      passwordRecovery();
      return;
    }
    if (event === 'SIGNED_OUT' || !session) {
      user = null;
      db = emptyDb();
      login();
    }
  });
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    login(error.message);
    return;
  }
  if (recoveryMode) return;
  if (data.session?.user) {
    await openSession(data.session.user);
  } else {
    login();
  }
}

async function openSession(authUser) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('user_id, email, display_name, role, is_active')
    .eq('user_id', authUser.id)
    .maybeSingle();

  if (error || !profile) {
    login(error?.message || '계정 정보를 확인하지 못했어요.');
    return;
  }

  user = {
    id: authUser.id,
    email: profile.email,
    name: profile.display_name || authUser.email || '교사',
    role: profile.role,
    isActive: profile.is_active,
  };

  if (!user.isActive) {
    pendingApproval();
    return;
  }

  try {
    await loadData();
    render();
  } catch (loadError) {
    login(loadError.message || '공유 데이터를 불러오지 못했어요.');
  }
}

async function loadData() {
  const [youthResult, attendanceResult, postResult, commentResult, eventResult] = await Promise.all([
    supabase.from('youths').select('*').order('name'),
    supabase.from('attendance').select('*').order('attendance_date', { ascending: false }),
    supabase.from('board_posts').select('*').order('created_at', { ascending: false }),
    supabase.from('comments').select('*').order('created_at'),
    supabase.from('calendar_events').select('*').order('event_date'),
  ]);
  for (const result of [youthResult, attendanceResult, postResult, commentResult, eventResult]) {
    if (result.error) throw result.error;
  }

  db = emptyDb();
  db.youths = youthResult.data.map((y) => ({
    id: y.id,
    name: y.name,
    group: y.group_name,
    enrollmentDate: y.enrollment_date,
    active: y.is_active,
    notes: y.notes,
  }));
  attendanceResult.data.forEach((item) => {
    db.attendance[item.attendance_date] ??= {};
    db.attendance[item.attendance_date][item.youth_id] = item.status;
  });

  const commentsByPost = new Map();
  commentResult.data.forEach((comment) => {
    const list = commentsByPost.get(comment.post_id) || [];
    list.push({ id: comment.id, author: comment.author_name, content: comment.content });
    commentsByPost.set(comment.post_id, list);
  });

  const posts = await Promise.all(postResult.data.map(async (post) => {
    let image = '';
    if (post.image_path) {
      const { data: signed } = await supabase.storage
        .from('meditations')
        .createSignedUrl(post.image_path, 3600);
      image = signed?.signedUrl || '';
    }
    return {
      id: post.id,
      author: post.author_name,
      date: post.post_date,
      category: post.category,
      content: post.content,
      image,
      comments: commentsByPost.get(post.id) || [],
    };
  }));
  db.posts = posts;
  db.meditations = posts.filter((post) => post.image);
  db.events = eventResult.data.map((event) => ({
    id: event.id,
    date: event.event_date,
    title: event.title,
    description: event.description,
    location: event.location,
  }));

  if (user.role === 'admin') {
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('user_id, email, display_name, role, is_active')
      .order('created_at');
    if (profileError) throw profileError;
    db.profiles = profiles;
  }
}

function login(errorMessage = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
    <div class="brand"><div class="brand-mark">✳</div><div><strong>문백교회 청소년부</strong><small>함께 자라고, 함께 기록해요</small></div></div>
    <h1>함께 기록해요</h1>
    <p>승인된 교사 계정으로 로그인해 주세요.</p>
    ${errorMessage ? `<div class="login-hint" role="alert">${esc(errorMessage)}</div>` : ''}
    <form id="loginForm">
      <div class="field"><label for="email">이메일</label><input id="email" type="email" autocomplete="username" required placeholder="이메일 주소"></div>
      <div class="field"><label for="password">비밀번호</label><input id="password" type="password" autocomplete="current-password" required placeholder="비밀번호"></div>
      <button class="btn primary" type="submit" style="width:100%;margin-top:14px">로그인</button>
    </form>
    <button class="text-btn" id="forgotPassword" style="margin-top:14px">비밀번호를 잊으셨나요?</button><br>
    <button class="text-btn" id="showSignup" style="margin-top:16px">처음 오셨나요? 교사 가입 신청</button>
    <div class="login-hint">가입 후 관리자의 승인이 완료되면 출석부를 사용할 수 있어요.</div>
  </div></div>`;

  document.getElementById('loginForm').onsubmit = async (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      toast('이메일 또는 비밀번호를 확인해 주세요.');
      return;
    }
    await openSession(data.user);
  };
  document.getElementById('forgotPassword').onclick = requestPasswordReset;
  document.getElementById('showSignup').onclick = signup;
}

function requestPasswordReset(errorMessage = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
    <div class="brand"><div class="brand-mark">✳</div><div><strong>문백교회 청소년부</strong><small>비밀번호 재설정</small></div></div>
    <h1>새 비밀번호 받기</h1>
    <p>가입한 이메일로 재설정 링크를 보내 드립니다.</p>
    ${errorMessage ? `<div class="login-hint" role="alert">${esc(errorMessage)}</div>` : ''}
    <form id="resetRequestForm">
      <div class="field"><label for="resetEmail">이메일</label><input id="resetEmail" type="email" autocomplete="email" required value="${esc(user?.email || '')}"></div>
      <button class="btn primary" type="submit" style="width:100%;margin-top:14px">재설정 링크 보내기</button>
    </form>
    <button class="text-btn" id="backToLogin" style="margin-top:16px">로그인으로 돌아가기</button>
  </div></div>`;
  document.getElementById('backToLogin').onclick = () => login();
  document.getElementById('resetRequestForm').onsubmit = async (event) => {
    event.preventDefault();
    const email = document.getElementById('resetEmail').value.trim();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.href,
    });
    if (error) {
      requestPasswordReset(error.message);
      return;
    }
    app.innerHTML = `<div class="login"><div class="login-card"><h1>메일을 확인해 주세요</h1><p>계정이 있으면 비밀번호 재설정 링크를 보냈습니다. 메일의 링크를 눌러 새 비밀번호를 정하세요.</p><button class="btn" id="backToLogin">로그인으로</button></div></div>`;
    document.getElementById('backToLogin').onclick = () => login();
  };
}

function passwordRecovery(errorMessage = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
    <div class="brand"><div class="brand-mark">✳</div><div><strong>문백교회 청소년부</strong><small>비밀번호 재설정</small></div></div>
    <h1>새 비밀번호 설정</h1>
    <p>8자 이상으로 새 비밀번호를 입력해 주세요.</p>
    ${errorMessage ? `<div class="login-hint" role="alert">${esc(errorMessage)}</div>` : ''}
    <form id="newPasswordForm">
      <div class="field"><label for="newPassword">새 비밀번호</label><input id="newPassword" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn primary" type="submit" style="width:100%;margin-top:14px">비밀번호 변경</button>
    </form>
  </div></div>`;
  document.getElementById('newPasswordForm').onsubmit = async (event) => {
    event.preventDefault();
    const password = document.getElementById('newPassword').value;
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) {
      passwordRecovery(error.message);
      return;
    }
    recoveryMode = false;
    await openSession(data.user);
  };
}

function signup(errorMessage = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
    <div class="brand"><div class="brand-mark">✳</div><div><strong>문백교회 청소년부</strong><small>교사 가입 신청</small></div></div>
    <h1>교사 계정 신청</h1>
    <p>관리자 승인 후 로그인할 수 있습니다.</p>
    ${errorMessage ? `<div class="login-hint" role="alert">${esc(errorMessage)}</div>` : ''}
    <form id="signupForm">
      <div class="field"><label for="displayName">이름</label><input id="displayName" required maxlength="80" autocomplete="name"></div>
      <div class="field"><label for="email">이메일</label><input id="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">비밀번호 (8자 이상)</label><input id="password" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn primary" type="submit" style="width:100%;margin-top:14px">가입 신청</button>
    </form>
    <button class="text-btn" id="backToLogin" style="margin-top:16px">로그인으로 돌아가기</button>
  </div></div>`;
  document.getElementById('backToLogin').onclick = () => login();
  document.getElementById('signupForm').onsubmit = async (event) => {
    event.preventDefault();
    const displayName = document.getElementById('displayName').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: displayName },
        emailRedirectTo: window.location.href,
      },
    });
    if (error) {
      signup(error.message);
      return;
    }
    if (data.session?.user) {
      await openSession(data.session.user);
    } else {
      app.innerHTML = `<div class="login"><div class="login-card"><h1>이메일을 확인해 주세요</h1><p>인증 링크를 누른 후 관리자 승인을 기다려 주세요.</p><button class="btn" id="backToLogin">로그인으로</button></div></div>`;
      document.getElementById('backToLogin').onclick = () => login();
    }
  };
}

function pendingApproval() {
  app.innerHTML = `<div class="login"><div class="login-card"><div class="brand-mark">◷</div>
    <h1>승인을 기다리고 있어요</h1>
    <p>${esc(user.email)} 계정은 관리자 승인 후 출석부를 사용할 수 있습니다.</p>
    <button class="btn" id="pendingLogout">로그아웃</button>
  </div></div>`;
  document.getElementById('pendingLogout').onclick = () => supabase.auth.signOut();
}

function nav() {
  const items = [
    ['dashboard', '⌂', '대시보드'], ['attendance', '✓', '출석 체크'],
    ['youths', '♙', '청소년 명단'], ['stats', '▥', '출석 통계'],
    ['board', '▤', '묵상 게시판'], ['calendar', '▦', '캘린더'],
  ];
  if (user?.role === 'admin') items.push(['admin', '⚙', '관리']);
  return items.map(([id, icon, label]) => `<button class="${page === id ? 'active' : ''}" data-page="${id}"><span class="ico">${icon}</span>${label}</button>`).join('');
}

function pageTitle() {
  return ({ dashboard: '대시보드', attendance: '출석 체크', youths: '청소년 명단', stats: '출석 통계', board: '묵상 게시판', calendar: '캘린더', admin: '관리' })[page];
}

function shell(content) {
  app.innerHTML = `<div class="shell"><aside class="sidebar">
    <div class="brand"><div class="brand-mark">✳</div><div><strong>문백교회 청소년부</strong><small>함께 자라고, 함께 기록해요</small></div></div>
    <div><div class="nav-label">메뉴</div><nav class="nav">${nav()}</nav></div>
    <div class="side-bottom"><div class="demo-badge"><b>◉ 승인된 교사 전용</b>출석 데이터는 모든 승인된 계정에 공유됩니다.</div></div>
  </aside><main class="main"><header class="topbar">
    <div class="crumb">문백교회 <span> / </span><b>${pageTitle()}</b></div>
    <div class="user-chip"><div class="avatar">${esc(user.name.slice(0, 1))}</div><span class="name">${esc(user.name)} · ${user.role === 'admin' ? '관리자' : '교사'}</span><button class="text-btn" id="logout">로그아웃</button></div>
  </header><section class="content">${content}</section></main></div>`;
  document.querySelectorAll('[data-page]').forEach((button) => {
    button.onclick = () => { page = button.dataset.page; render(); };
  });
  document.getElementById('logout').onclick = () => supabase.auth.signOut();
}

function heading(eyebrow, title, description, actions = '') {
  return `<div class="heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
}

function stat(label, note, value, icon) {
  return `<div class="stat"><div class="stat-top">${label}<span class="stat-icon">${icon}</span></div><div class="stat-num">${value}</div><div class="stat-note">${note}</div></div>`;
}

function dashboard() {
  const c = counts();
  const recentDates = Object.keys(db.attendance).sort().reverse().slice(0, 4);
  const dates = recentDates.length ? recentDates : [selectedDate];
  const recent = dates.map((date) => `<div class="list-row"><div class="person"><div class="person-avatar">${new Date(`${date}T12:00:00`).getDate()}</div><div><strong>${fmt(date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</strong><small>출석 ${Object.values(db.attendance[date] || {}).filter((s) => s === '출석').length}명 · 결석 ${Object.values(db.attendance[date] || {}).filter((s) => s === '결석').length}명</small></div></div><button class="text-btn" data-open-date="${date}">기록 보기</button></div>`).join('');
  return `${heading(`SUNDAY · ${fmt(selectedDate, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`, '아이들과 함께하는 주일', '오늘의 예배를 준비하고, 한 명 한 명의 안부를 살펴봐요.', `<input type="date" class="date-input" id="dashDate" value="${selectedDate}"><button class="btn primary" data-page="attendance">출석 체크 시작 ↗</button>`)}
    <div class="stats">${stat('재적 청소년', '현재 재적 기준', activeYouth().length, '♙')}${stat('출석', '예배 참석', c['출석'], '✓')}${stat('결석', '안부 확인 필요', c['결석'], '!')}${stat('사전 연락 · 미확인', `사전 연락 ${c['사전 연락']} · 미확인 ${c['미확인']}`, c['사전 연락'] + c['미확인'], '◷')}</div>
    <div class="grid-two"><div class="panel"><div class="panel-head"><div><h2>오늘 출석 현황</h2><p>${fmt(selectedDate, { year: 'numeric', month: 'long', day: 'numeric' })} 기준 · 재적 ${activeYouth().length}명</p></div><button class="link-btn" data-page="attendance">출석부 열기 →</button></div>
      ${['출석', '결석', '사전 연락', '미확인'].map((s) => `<div class="progress-row"><span class="label">${s}</span><div class="bar"><i style="width:${activeYouth().length ? (c[s] / activeYouth().length) * 100 : 0}%"></i></div><strong>${c[s]}명</strong></div>`).join('')}
      <p class="notice">출석률은 출석 ÷ (출석 + 결석 + 사전 연락)으로 계산합니다. 미확인과 기록이 없는 날짜는 분모에서 제외합니다.</p></div>
      <div class="panel"><div class="panel-head"><div><h2>최근 출석 기록</h2><p>공유 데이터베이스에 저장된 날짜</p></div><button class="link-btn" data-page="stats">통계 보기 →</button></div><div class="list">${recent}</div></div></div>
    <div class="panel"><div class="panel-head"><div><h2>이번 주 일정</h2><p>다가오는 청소년부 일정</p></div><button class="link-btn" data-page="calendar">캘린더 →</button></div>${eventRows(db.events.filter((e) => e.date >= todayISO()).slice(0, 3)) || '<div class="empty">등록된 일정이 없어요.</div>'}</div>`;
}

function attendancePage() {
  const list = activeYouth().filter((y) => !searchTerm || y.name.includes(searchTerm) || y.group.includes(searchTerm));
  const c = counts();
  return `${heading('ATTENDANCE', '주일 출석 체크', '상태를 누르면 공유 출석부에 바로 저장됩니다.', `<input type="date" class="date-input" id="attDate" value="${selectedDate}">`)}
    <div class="stats">${stat('출석', `재적 ${activeYouth().length}명 기준`, c['출석'], '✓')}${stat('결석', '안부 확인 필요', c['결석'], '!')}${stat('사전 연락', '결석과 별도 집계', c['사전 연락'], '◷')}${stat('미확인', '결석으로 계산하지 않음', c['미확인'], '·')}</div>
    <div class="panel"><div class="panel-head"><div><h2>${fmt(selectedDate, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</h2><p>각 상태를 선택하면 공유 저장소에 기록돼요.</p></div><input class="search" id="attSearch" placeholder="이름 또는 반 검색" value="${esc(searchTerm)}"></div>
      <div class="table-wrap">${list.length ? list.map((y) => `<div class="attendance-row"><div class="attendance-head"><div class="person"><div class="person-avatar">${esc(y.name.slice(0, 1))}</div><div><strong>${esc(y.name)}</strong><small>${esc(y.group || '반 미지정')}</small></div></div><span class="pill ${statusClass(record(y.id))}">${record(y.id)}</span></div><div class="state-group">${['출석', '결석', '사전 연락', '미확인'].map((s) => `<button class="state-btn ${record(y.id) === s ? 'selected' : ''}" data-att="${y.id}" data-status="${s}" aria-label="${esc(y.name)} ${s}">${s}</button>`).join('')}</div></div>`).join('') : '<div class="empty">청소년 명단이 비어 있거나 검색 결과가 없어요.</div>'}</div>
      <p class="notice">출석 ${c['출석']} · 결석 ${c['결석']} · 사전 연락 ${c['사전 연락']} · 미확인 ${c['미확인']}<br>기록이 없는 상태는 미확인으로 표시되며 결석으로 계산하지 않습니다.</p></div>`;
}

function latestStatus(id) {
  const date = Object.keys(db.attendance).filter((d) => db.attendance[d][id]).sort().at(-1);
  return date ? db.attendance[date][id] : '기록 없음';
}

function youthsPage() {
  const youths = db.youths.filter((y) => (rosterFilter === 'all' || (rosterFilter === 'active' ? y.active : !y.active)) && (!searchTerm || y.name.includes(searchTerm) || y.group.includes(searchTerm)));
  const addButton = user.role === 'admin' ? '<button class="btn primary" id="addYouth">＋ 청소년 등록</button>' : '';
  return `${heading('PEOPLE', '청소년 명단', '비활성 처리해도 과거 출석 기록은 보존돼요.', addButton)}
    <div class="panel"><div class="panel-head"><div><h2>청소년 ${youths.length}명</h2><p>이름을 눌러 개인별 출석 이력을 확인하세요.</p></div><div class="actions"><select class="select" id="rosterFilter"><option value="active" ${rosterFilter === 'active' ? 'selected' : ''}>재적</option><option value="inactive" ${rosterFilter === 'inactive' ? 'selected' : ''}>비활성</option><option value="all" ${rosterFilter === 'all' ? 'selected' : ''}>전체</option></select><input class="search" id="youthSearch" placeholder="이름 또는 반 검색" value="${esc(searchTerm)}"></div></div>
    <div class="table-wrap"><table><thead><tr><th>이름</th><th>반 / 연령</th><th>등록일</th><th>최근 상태</th><th>관리</th></tr></thead><tbody>${youths.map((y) => `<tr><td><button class="text-btn" data-history="${y.id}"><b>${esc(y.name)}</b></button></td><td>${esc(y.group || '—')}</td><td>${y.enrollmentDate || '—'}</td><td><span class="pill ${statusClass(latestStatus(y.id))}">${latestStatus(y.id)}</span></td><td>${user.role === 'admin' ? `<div class="row-actions"><button class="text-btn" data-edit="${y.id}">수정</button><button class="text-btn" data-toggle="${y.id}">${y.active ? '비활성' : '재적 복귀'}</button></div>` : '관리자 전용'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">표시할 청소년이 없어요.</td></tr>'}</tbody></table></div>
    <p class="notice">민감 정보는 입력하지 마세요. 출석 기록은 데이터베이스에 공유 저장됩니다.</p></div>`;
}

function statsPage() {
  const month = `${monthCursor.getFullYear()}-${String(monthCursor.getMonth() + 1).padStart(2, '0')}`;
  const dates = Object.keys(db.attendance).filter((date) => date.startsWith(month)).sort();
  let present = 0;
  let absent = 0;
  let denominator = 0;
  dates.forEach((date) => Object.values(db.attendance[date]).forEach((status) => {
    if (status === '출석') present += 1;
    if (status === '결석') absent += 1;
    if (['출석', '결석', '사전 연락'].includes(status)) denominator += 1;
  }));
  const rows = activeYouth().map((y) => {
    let p = 0; let a = 0; let c = 0;
    dates.forEach((date) => {
      const status = db.attendance[date][y.id];
      if (status === '출석') p += 1;
      if (status === '결석') a += 1;
      if (status === '사전 연락') c += 1;
    });
    const total = p + a + c;
    return `<tr><td>${esc(y.name)}</td><td>${p}</td><td>${a}</td><td>${c}</td><td>${total ? `${Math.round((p / total) * 100)}%` : '—'}</td></tr>`;
  }).join('');
  return `${heading('REPORTS', '출석 통계', `${monthCursor.getFullYear()}년 ${monthCursor.getMonth() + 1}월 기록을 요약합니다.`, '<button class="btn" id="prevMonth">← 이전</button><button class="btn" id="nextMonth">다음 →</button>')}
    <div class="stats">${stat('기록된 주일', `${dates.length}개 날짜`, dates.length, '▦')}${stat('출석', '기록 합계', present, '✓')}${stat('결석', '기록 합계', absent, '!')}${stat('출석률', '출석 ÷ 출석·결석·사전 연락', `${denominator ? Math.round((present / denominator) * 100) : 0}%`, '↗')}</div>
    <div class="panel"><div class="panel-head"><div><h2>청소년별 월간 출석</h2><p>${monthCursor.getFullYear()}년 ${monthCursor.getMonth() + 1}월 · 미확인 및 기록 없음은 분모에서 제외</p></div></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>출석</th><th>결석</th><th>사전 연락</th><th>출석률</th></tr></thead><tbody>${rows}</tbody></table></div><p class="notice">저장된 출석 상태만 집계합니다.</p></div>
    <div class="panel"><div class="panel-head"><div><h2>월별 출석 추이</h2><p>주일별 출석 인원</p></div></div>${dates.length ? `<div class="progress-list">${dates.map((date) => { const n = Object.values(db.attendance[date]).filter((s) => s === '출석').length; return `<div class="progress-row"><span class="label">${fmt(date, { month: 'short', day: 'numeric' })}</span><div class="bar"><i style="width:${activeYouth().length ? (n / activeYouth().length) * 100 : 0}%"></i></div><strong>${n}명</strong></div>`; }).join('')}</div>` : '<div class="empty">선택한 달에 출석 기록이 아직 없어요.</div>'}</div>`;
}

function boardPage() {
  const posts = [...db.posts].sort((a, b) => b.date.localeCompare(a.date));
  const meditationCards = db.meditations.length ? [...db.meditations].map((m) => `<div class="med-card"><img class="med-image" src="${esc(m.image)}" alt="묵상 사진" style="object-fit:cover"><div><h3>${esc(m.author)}의 묵상</h3><p>${esc(m.content)}</p><span class="muted">${fmt(m.date, { month: 'short', day: 'numeric' })}</span></div></div>`).join('') : '<div class="empty">아직 묵상 사진이 없어요.</div>';
  const postCards = posts.map((post) => `<article class="med-card" style="grid-template-columns:1fr"><div><span class="pill">${esc(post.category)}</span><h3 style="margin-top:9px">${esc(post.author)} <span class="muted">· ${fmt(post.date, { month: 'short', day: 'numeric' })}</span></h3><p>${esc(post.content)}</p>${post.comments.map((comment) => `<div style="margin:8px 0 0 14px;padding-left:10px;border-left:2px solid #e7eee6;font-size:11px;color:#686f67"><b>${esc(comment.author)}</b> ${esc(comment.content)}</div>`).join('')}<button class="text-btn" data-comment="${post.id}" style="margin-top:10px">＋ 댓글 달기</button></div></article>`).join('');
  return `${heading('MEDITATION', '묵상 게시판', '말씀을 나누고 서로를 격려해요.', '<button class="btn primary" id="newPost">＋ 글 작성</button>')}
    <div class="grid-two"><div class="panel"><div class="panel-head"><div><h2>오늘의 묵상</h2><p>사진과 마음에 남은 생각을 공유합니다.</p></div></div><form id="medForm"><div class="field"><label>사진 (선택, JPG·PNG·WebP 5MB 이하)</label><input type="file" id="medImage" accept="image/jpeg,image/png,image/webp"></div><div class="field" style="margin-top:12px"><label>묵상 내용 *</label><textarea id="medText" required placeholder="오늘 마음에 남은 말씀이나 생각을 나눠 주세요."></textarea></div><button class="btn primary" style="margin-top:12px">공유하기</button></form></div>
    <div class="panel"><div class="panel-head"><div><h2>사진 묵상</h2><p>승인된 교사와 함께 나눠요.</p></div></div>${meditationCards}</div></div>
    <div class="panel"><div class="panel-head"><div><h2>느낀 점과 응원</h2><p>서로의 나눔에 댓글을 남겨 보세요.</p></div></div>${postCards || '<div class="empty">아직 게시글이 없어요.</div>'}</div>`;
}

function eventRows(events) {
  return events.map((event) => `<div class="event-row"><div class="event-date"><strong>${new Date(`${event.date}T12:00:00`).getDate()}</strong>${fmt(event.date, { month: 'short' })}</div><div><strong>${esc(event.title)}</strong><small>${esc(event.description || '')}${event.location ? ` · ${esc(event.location)}` : ''}</small></div></div>`).join('');
}

function calendarPage() {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const offset = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: offset }, () => '<div></div>');
  for (let day = 1; day <= days; day += 1) {
    const date = iso(new Date(year, month, day));
    const events = db.events.filter((event) => event.date === date);
    cells.push(`<div class="cal-day ${events.length ? 'event' : ''}">${day}${events.map((event) => `<small>${esc(event.title)}</small>`).join('')}</div>`);
  }
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthEvents = db.events.filter((event) => event.date.startsWith(monthKey)).sort((a, b) => a.date.localeCompare(b.date));
  const addButton = user.role === 'admin' ? '<button class="btn primary" id="addEvent">＋ 일정 추가</button>' : '';
  return `${heading('CALENDAR', '함께하는 일정', '예배와 청소년부 일정을 확인해요.', `<button class="btn" id="prevMonth">←</button><button class="btn" id="nextMonth">→</button>${addButton}`)}
    <div class="grid-two"><div class="panel"><div class="panel-head"><h2>${year}년 ${month + 1}월</h2></div><div class="month-calendar">${['일', '월', '화', '수', '목', '금', '토'].map((d) => `<div class="cal-label">${d}</div>`).join('')}${cells.join('')}</div></div>
    <div class="panel"><div class="panel-head"><div><h2>일정 목록</h2><p>${year}년 ${month + 1}월</p></div></div>${eventRows(monthEvents) || '<div class="empty">이번 달 일정이 없어요.</div>'}</div></div>`;
}

function adminPage() {
  if (user.role !== 'admin') return '<div class="panel"><div class="empty">관리자만 접근할 수 있어요.</div></div>';
  const rows = db.profiles.map((profile) => `<tr><td>${esc(profile.display_name || '이름 미입력')}</td><td>${esc(profile.email)}</td><td><select class="select" data-role="${profile.user_id}" aria-label="${esc(profile.email)} 권한"><option value="teacher" ${profile.role === 'teacher' ? 'selected' : ''}>교사</option><option value="admin" ${profile.role === 'admin' ? 'selected' : ''}>관리자</option></select></td><td><span class="pill ${profile.is_active ? 'present' : 'unknown'}">${profile.is_active ? '승인됨' : '승인 대기'}</span></td><td><button class="btn small ${profile.is_active ? '' : 'primary'}" data-approve="${profile.user_id}" data-active="${profile.is_active}">${profile.is_active ? '접근 중지' : '승인'}</button></td></tr>`).join('');
  return `${heading('ADMIN', '관리자 설정', '가입 신청을 승인하고 계정 권한을 관리합니다.')}
    <div class="panel"><div class="panel-head"><div><h2>사용자 계정</h2><p>승인되지 않은 계정은 청소년 정보에 접근할 수 없습니다.</p></div></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>이메일</th><th>권한</th><th>상태</th><th>관리</th></tr></thead><tbody>${rows}</tbody></table></div><p class="notice">최초 관리자 계정은 Supabase SQL Editor에서 한 번 활성화해야 합니다.</p></div>`;
}

function modal(title, body, footer) {
  document.querySelector('.modal-back')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-back"><div class="modal"><h2>${title}</h2>${body}<div class="modal-foot">${footer}</div></div></div>`);
  document.querySelectorAll('[data-close]').forEach((button) => { button.onclick = closeModal; });
  document.querySelector('.modal-back').onclick = (event) => { if (event.target.classList.contains('modal-back')) closeModal(); };
}

function closeModal() {
  document.querySelector('.modal-back')?.remove();
}

function youthModal(id = '') {
  const youth = db.youths.find((item) => item.id === id) || {};
  modal(id ? '청소년 정보 수정' : '청소년 등록', `<form id="youthForm" class="form"><input type="hidden" name="id" value="${esc(id)}"><div class="field full"><label>이름 *</label><input name="name" required maxlength="100" value="${esc(youth.name || '')}" placeholder="이름"></div><div class="field"><label>반 또는 연령 구분</label><input name="group" maxlength="80" value="${esc(youth.group || '')}" placeholder="예: 중등부"></div><div class="field"><label>등록일</label><input name="enrollmentDate" type="date" value="${youth.enrollmentDate || todayISO()}"></div><div class="field full"><label>메모 (민감정보 입력 금지)</label><input name="notes" maxlength="500" value="${esc(youth.notes || '')}"></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="saveYouth">저장</button>');
  document.getElementById('saveYouth').onclick = async () => {
    const form = new FormData(document.getElementById('youthForm'));
    const name = String(form.get('name')).trim();
    if (!name) return;
    const data = { name, group_name: String(form.get('group')).trim(), enrollment_date: form.get('enrollmentDate') || null, notes: String(form.get('notes')).trim() };
    const youthId = form.get('id');
    const result = youthId
      ? await supabase.from('youths').update(data).eq('id', youthId)
      : await supabase.from('youths').insert({ ...data, is_active: true });
    if (result.error) { toast('저장하지 못했어요. 권한과 연결을 확인해 주세요.'); return; }
    closeModal();
    await refreshAndRender('청소년 정보를 저장했어요.');
  };
}

function historyModal(id) {
  const youth = db.youths.find((item) => item.id === id);
  const dates = Object.keys(db.attendance).filter((date) => db.attendance[date][id]).sort().reverse();
  const statuses = dates.map((date) => db.attendance[date][id]);
  const summary = ['출석', '결석', '사전 연락'].map((status) => `${status} ${statuses.filter((s) => s === status).length}`).join(' · ');
  modal(`${esc(youth.name)} 출석 이력`, `<p class="muted">${esc(youth.group || '반 미지정')} · ${summary}</p><div class="list">${dates.map((date) => `<div class="list-row"><b style="font-size:12px">${fmt(date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</b><span class="pill ${statusClass(db.attendance[date][id])}">${db.attendance[date][id]}</span></div>`).join('') || '<div class="empty">기록된 출석 이력이 없어요.</div>'}</div>`, '<button class="btn" data-close>닫기</button>');
}

function eventModal() {
  modal('일정 추가', `<form id="eventForm" class="form"><div class="field full"><label>일정 이름 *</label><input name="title" required maxlength="200"></div><div class="field"><label>날짜 *</label><input name="date" type="date" required value="${nextSunday()}"></div><div class="field"><label>장소</label><input name="location" maxlength="200"></div><div class="field full"><label>설명</label><input name="description" maxlength="1000"></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="saveEvent">저장</button>');
  document.getElementById('saveEvent').onclick = async () => {
    const form = new FormData(document.getElementById('eventForm'));
    const title = String(form.get('title')).trim();
    if (!title) return;
    const { error } = await supabase.from('calendar_events').insert({ title, event_date: form.get('date'), location: form.get('location'), description: form.get('description'), created_by: user.id });
    if (error) { toast('일정을 저장하지 못했어요. 관리자 권한을 확인해 주세요.'); return; }
    closeModal();
    await refreshAndRender('일정을 추가했어요.');
  };
}

async function refreshAndRender(message = '') {
  try {
    await loadData();
    render();
    if (message) toast(message);
  } catch (error) {
    toast(error.message || '데이터를 새로고침하지 못했어요.');
  }
}

function render() {
  if (!user) { login(); return; }
  if (!user.isActive) { pendingApproval(); return; }
  if (page === 'admin' && user.role !== 'admin') page = 'dashboard';
  const views = { dashboard, attendance: attendancePage, youths: youthsPage, stats: statsPage, board: boardPage, calendar: calendarPage, admin: adminPage };
  shell(views[page]());
  bind();
}

function bind() {
  const dashDate = document.getElementById('dashDate');
  if (dashDate) dashDate.onchange = () => { selectedDate = dashDate.value; render(); };
  const attendanceDate = document.getElementById('attDate');
  if (attendanceDate) attendanceDate.onchange = () => { selectedDate = attendanceDate.value; render(); };
  const search = document.getElementById('attSearch') || document.getElementById('youthSearch');
  if (search) search.oninput = () => {
    searchTerm = search.value;
    const start = search.selectionStart;
    render();
    const next = document.getElementById('attSearch') || document.getElementById('youthSearch');
    next?.focus();
    next?.setSelectionRange(start, start);
  };
  document.querySelectorAll('[data-att]').forEach((button) => {
    button.onclick = async () => {
      const { error } = await supabase.from('attendance').upsert({
        youth_id: button.dataset.att,
        attendance_date: selectedDate,
        status: button.dataset.status,
        recorded_by: user.id,
      }, { onConflict: 'youth_id,attendance_date' });
      if (error) { toast('출석을 저장하지 못했어요. 다시 로그인하거나 관리자에게 문의해 주세요.'); return; }
      await refreshAndRender('출석 상태를 공유 저장했어요.');
    };
  });
  const roster = document.getElementById('rosterFilter');
  if (roster) roster.onchange = () => { rosterFilter = roster.value; render(); };
  document.getElementById('addYouth')?.addEventListener('click', () => youthModal());
  document.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => youthModal(button.dataset.edit); });
  document.querySelectorAll('[data-toggle]').forEach((button) => {
    button.onclick = async () => {
      const youth = db.youths.find((item) => item.id === button.dataset.toggle);
      const { error } = await supabase.from('youths').update({ is_active: !youth.active }).eq('id', youth.id);
      if (error) { toast('청소년 정보를 변경하지 못했어요.'); return; }
      await refreshAndRender(youth.active ? '비활성 처리했어요.' : '재적 상태로 복귀했어요.');
    };
  });
  document.querySelectorAll('[data-history]').forEach((button) => { button.onclick = () => historyModal(button.dataset.history); });
  document.querySelectorAll('[data-open-date]').forEach((button) => { button.onclick = () => { selectedDate = button.dataset.openDate; page = 'attendance'; render(); }; });
  document.getElementById('prevMonth')?.addEventListener('click', () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1); render(); });
  document.getElementById('nextMonth')?.addEventListener('click', () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1); render(); });
  document.getElementById('addEvent')?.addEventListener('click', eventModal);

  document.querySelectorAll('[data-approve]').forEach((button) => {
    button.onclick = async () => {
      const isActive = button.dataset.active !== 'true';
      const { error } = await supabase.from('profiles').update({ is_active: isActive }).eq('user_id', button.dataset.approve);
      if (error) { toast('계정 상태를 변경하지 못했어요.'); return; }
      await refreshAndRender(isActive ? '계정을 승인했어요.' : '계정 접근을 중지했어요.');
    };
  });
  document.querySelectorAll('[data-role]').forEach((select) => {
    select.onchange = async () => {
      const { error } = await supabase.from('profiles').update({ role: select.value }).eq('user_id', select.dataset.role);
      if (error) { toast('권한을 변경하지 못했어요.'); return; }
      await refreshAndRender('권한을 변경했어요.');
    };
  });

  document.getElementById('newPost')?.addEventListener('click', () => {
    modal('묵상 게시글 작성', `<form id="postForm" class="form"><div class="field"><label>분류</label><select name="category"><option>묵상 나눔</option><option>함께 기도해요</option><option>감사 나눔</option></select></div><div class="field full"><label>내용 *</label><textarea name="content" required maxlength="10000"></textarea></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="savePost">올리기</button>');
    document.getElementById('savePost').onclick = async () => {
      const form = new FormData(document.getElementById('postForm'));
      const content = String(form.get('content')).trim();
      if (!content) return;
      const { error } = await supabase.from('board_posts').insert({ author_id: user.id, author_name: user.name, post_date: todayISO(), category: form.get('category'), content });
      if (error) { toast('게시글을 저장하지 못했어요.'); return; }
      closeModal();
      await refreshAndRender('게시글을 공유했어요.');
    };
  });

  document.querySelectorAll('[data-comment]').forEach((button) => {
    button.onclick = async () => {
      const content = window.prompt('댓글을 입력해 주세요.');
      if (!content?.trim()) return;
      const { error } = await supabase.from('comments').insert({ post_id: button.dataset.comment, author_id: user.id, author_name: user.name, content: content.trim() });
      if (error) { toast('댓글을 저장하지 못했어요.'); return; }
      await refreshAndRender('댓글을 남겼어요.');
    };
  });

  const meditationForm = document.getElementById('medForm');
  if (meditationForm) meditationForm.onsubmit = async (event) => {
    event.preventDefault();
    const content = document.getElementById('medText').value.trim();
    const file = document.getElementById('medImage').files[0];
    if (!content) return;
    let imagePath = null;
    if (file) {
      if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        toast('JPG, PNG, WebP 형식의 5MB 이하 사진을 선택해 주세요.');
        return;
      }
      const extension = file.type.split('/')[1].replace('jpeg', 'jpg');
      imagePath = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from('meditations').upload(imagePath, file, { contentType: file.type, upsert: false });
      if (uploadError) { toast('사진을 올리지 못했어요.'); return; }
    }
    const { error } = await supabase.from('board_posts').insert({ author_id: user.id, author_name: user.name, post_date: todayISO(), category: '묵상 사진', content, image_path: imagePath });
    if (error) { toast('묵상을 저장하지 못했어요.'); return; }
    await refreshAndRender('묵상을 공유했어요.');
  };
}

boot();
