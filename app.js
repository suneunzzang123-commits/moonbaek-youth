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
let boardTab = 'qt';
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
      authorId: post.author_id,
      author: post.author_name,
      date: post.post_date,
      category: post.category,
      content: post.content,
      image,
      imagePath: post.image_path,
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
    ['board', '▤', '큐티 나눔'], ['calendar', '▦', '캘린더'],
  ];
  if (user?.role === 'admin') items.push(['admin', '⚙', '관리']);
  return items.map(([id, icon, label]) => `<button class="${page === id ? 'active' : ''}" data-page="${id}"><span class="ico">${icon}</span>${label}</button>`).join('');
}

function pageTitle() {
  return ({ dashboard: '대시보드', attendance: '출석 체크', youths: '청소년 명단', stats: '출석 통계', board: '큐티 나눔', calendar: '캘린더', admin: '관리' })[page];
}

function shell(content) {
  app.innerHTML = `<div class="site-shell">
    <div class="announcement"><div class="site-width"><span class="announcement-tag">함께</span><span>문백교회 청소년부 · 함께 자라고, 함께 기록해요</span><span class="announcement-date">주일 출석과 청소년부 소식을 한곳에서</span></div></div>
    <div class="utility"><div class="site-width"><span>문백교회 <b>/</b> 청소년부</span><div class="user-chip"><div class="avatar">${esc(user.name.slice(0, 1))}</div><span class="name">${esc(user.name)} · ${user.role === 'admin' ? '관리자' : '교사'}</span><button class="text-btn" id="logout">로그아웃</button></div></div></div>
    <header class="site-header"><div class="site-width"><div class="brand"><div class="brand-mark">✳</div><div><strong>문백교회 청소년부</strong><small>함께 자라고, 함께 기록해요</small></div></div><nav class="nav">${nav()}</nav><div class="approval-mark">● 승인된 교사</div></div></header>
    <main class="main"><section class="content site-width">${content}</section></main>
  </div>`;
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
    <div class="welcome-feature"><div class="welcome-copy"><span class="feature-kicker">SUNDAY · YOUTH MINISTRY</span><h2>한 사람 한 사람,<br>사랑으로 기억해요</h2><p>함께 예배하고 서로의 한 주를 살피는 문백교회 청소년부</p><button class="feature-link" data-page="attendance">오늘 출석 기록하기 <span>↗</span></button><div class="feature-dots"><i></i><i></i><i></i></div></div><div class="feature-side"><span>THIS SUNDAY</span><strong>${fmt(selectedDate, { month: 'long', day: 'numeric', weekday: 'long' })}</strong><div class="feature-count"><b>${c['출석']}</b><small>명 출석 확인</small></div><span class="feature-cross">✳</span></div></div>
    <div class="quick-section"><div class="quick-title"><div><span class="eyebrow">QUICK ACCESS</span><h2>메뉴</h2></div><p>출석부터 일정까지, 자주 쓰는 메뉴를 모았어요.</p></div><div class="quick-grid"><button class="quick-card quick-primary" data-page="attendance"><span>01　ATTENDANCE</span><b>주일 출석 체크</b><small>예배 참석 현황을 기록해요</small><i>↗</i></button><button class="quick-card" data-page="youths"><span>02　PEOPLE</span><b>청소년 명단</b><small>아이들의 정보를 살펴봐요</small><i>↗</i></button><button class="quick-card" data-page="stats"><span>03　INSIGHTS</span><b>출석 통계</b><small>함께 쌓인 기록을 확인해요</small><i>↗</i></button><button class="quick-card" data-page="calendar"><span>04　CALENDAR</span><b>청소년부 일정</b><small>다가오는 일정을 확인해요</small><i>↗</i></button></div></div>
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
  const posts = [...db.posts].sort((a, b) => `${b.date}-${b.id}`.localeCompare(`${a.date}-${a.id}`));
  const qtPosts = posts.filter((post) => !post.image);
  const photoPosts = posts.filter((post) => post.image);
  const qtCards = qtPosts.map((post) => `<article class="qt-post"><div class="qt-post-meta"><span class="pill">${esc(post.category)}</span><span>${fmt(post.date, { year: 'numeric', month: 'long', day: 'numeric' })}</span></div><h3>${esc(post.author)}의 말씀 나눔</h3><p class="qt-post-content">${esc(post.content)}</p><div class="qt-post-bottom"><span>함께 나눈 댓글 ${post.comments.length}개</span><div><button class="text-btn" data-post-detail="${post.id}">댓글 보기</button><button class="text-btn" data-comment="${post.id}">댓글 달기 ↗</button></div></div>${post.comments.length ? `<div class="qt-comments">${post.comments.slice(-2).map((comment) => `<div><b>${esc(comment.author)}</b><span>${esc(comment.content)}</span></div>`).join('')}</div>` : ''}</article>`).join('');
  const photos = photoPosts.map((post) => `<article class="photo-post"><button type="button" class="photo-post-image" data-post-detail="${post.id}" aria-label="${esc(post.author)}의 사진 게시글 보기"><img src="${esc(post.image)}" alt="${esc(post.author)}이(가) 올린 사진"><span>사진과 나눔 보기 ↗</span></button><div class="photo-post-copy"><div class="qt-post-meta"><span>${fmt(post.date, { month: 'long', day: 'numeric' })}</span><span>${post.comments.length}개 댓글</span></div><h3>${esc(post.author)}의 사진 나눔</h3><p>${esc(post.content)}</p><button class="text-btn" data-comment="${post.id}">댓글 달기 ↗</button></div></article>`).join('');
  const tabs = `<div class="board-tabs" role="tablist" aria-label="게시판 선택"><button class="board-tab ${boardTab === 'qt' ? 'active' : ''}" role="tab" aria-selected="${boardTab === 'qt'}" data-board-tab="qt"><span>01</span> 큐티 나눔 <small>${qtPosts.length}</small></button><button class="board-tab ${boardTab === 'photos' ? 'active' : ''}" role="tab" aria-selected="${boardTab === 'photos'}" data-board-tab="photos"><span>02</span> 사진 게시판 <small>${photoPosts.length}</small></button></div>`;
  const qtView = `<div class="qt-intro"><div><span class="feature-kicker">READ · REFLECT · SHARE</span><h2>말씀을 읽고,<br>마음을 나누어요</h2><p>오늘 마음에 남은 말씀과 삶의 이야기를 함께 나눠요.</p></div><div class="qt-intro-side"><span>함께하는 묵상</span><b>작은 나눔이<br>서로의 믿음을 세워요</b><span class="qt-cross" aria-hidden="true">✳</span></div></div><div class="board-section-head"><div><span class="eyebrow">OUR QT</span><h2>우리의 묵상 나눔</h2><p>말씀과 삶을 나누고, 서로를 위해 기도해요.</p></div><button class="btn primary" id="newPost">＋ 큐티 쓰기</button></div><div class="qt-feed">${qtCards || '<div class="empty">첫 번째 큐티 나눔을 기다리고 있어요.</div>'}</div>`;
  const photoView = `<div class="qt-intro photo-intro"><div><span class="feature-kicker">MOMENTS TOGETHER</span><h2>함께한 순간을<br>사진으로 나눠요</h2><p>청소년부의 소중한 순간과 이야기를 기록해요.</p></div><div class="qt-intro-side"><span>우리의 기록</span><b>함께 웃고<br>함께 자라는 시간</b><span class="qt-cross" aria-hidden="true">✳</span></div></div><div class="board-section-head"><div><span class="eyebrow">PHOTO BOARD</span><h2>사진 게시판</h2><p>사진을 누르면 자세한 나눔과 댓글을 볼 수 있어요.</p></div><button class="btn primary" id="newPhotoPost">＋ 사진 올리기</button></div><div class="photo-board-grid">${photos || '<div class="empty">아직 올라온 사진이 없어요.</div>'}</div>`;
  return `${heading('DAILY QT', '말씀을 나누고 함께 자라요', '오늘의 묵상과 청소년부의 순간을 함께 기록해요.')}${tabs}${boardTab === 'qt' ? qtView : photoView}`;
}

function eventRows(events) {
  return events.map((event) => `<div class="event-row"><div class="event-date"><strong>${new Date(`${event.date}T12:00:00`).getDate()}</strong>${fmt(event.date, { month: 'short' })}</div><div><strong>${esc(event.title)}</strong><small>${esc(event.description || '')}${event.location ? ` · ${esc(event.location)}` : ''}</small></div></div>`).join('');
}

function calendarPage() {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const offset = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: offset }, () => '<div class="cal-empty" aria-hidden="true"></div>');
  for (let day = 1; day <= days; day += 1) {
    const date = iso(new Date(year, month, day));
    const events = db.events.filter((event) => event.date === date);
    const weekday = new Date(year, month, day).getDay();
    const classes = ['cal-day', weekday === 0 ? 'sunday' : '', weekday === 6 ? 'saturday' : '', date === todayISO() ? 'today' : '', events.length ? 'event' : ''].filter(Boolean).join(' ');
    cells.push(`<div class="${classes}" aria-label="${year}년 ${month + 1}월 ${day}일${events.length ? ` 일정 ${events.length}개` : ''}"><span class="cal-number">${day}</span><span class="cal-events">${events.slice(0, 2).map((event) => `<small title="${esc(event.title)}">${esc(event.title)}</small>`).join('')}${events.length > 2 ? `<small class="more-events">+${events.length - 2}개 일정</small>` : ''}</span></div>`);
  }
  while (cells.length < 42) cells.push('<div class="cal-empty" aria-hidden="true"></div>');
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthEvents = db.events.filter((event) => event.date.startsWith(monthKey)).sort((a, b) => a.date.localeCompare(b.date));
  const addButton = user.role === 'admin' ? '<button class="btn primary" id="addEvent">＋ 일정 추가</button>' : '';
  return `${heading('CALENDAR', '함께하는 일정', '예배와 청소년부 일정을 확인해요.', `<button class="btn" id="prevMonth">←</button><button class="btn" id="nextMonth">→</button>${addButton}`)}
    <div class="grid-two calendar-layout"><div class="panel calendar-panel"><div class="panel-head"><div><h2>${year}년 ${month + 1}월</h2><p>날짜별 예배와 청소년부 일정</p></div></div><div class="month-calendar" role="grid" aria-label="${year}년 ${month + 1}월 달력">${['일', '월', '화', '수', '목', '금', '토'].map((d, i) => `<div class="cal-label ${i === 0 ? 'sunday' : ''} ${i === 6 ? 'saturday' : ''}" role="columnheader">${d}</div>`).join('')}${cells.join('')}</div></div>
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

function postDetailModal(id) {
  const post = db.posts.find((item) => item.id === id);
  if (!post) return;
  const comments = post.comments.map((comment) => `<div class="comment-row"><b>${esc(comment.author)}</b><p>${esc(comment.content)}</p></div>`).join('');
  const image = post.image ? `<img class="post-detail-image" src="${esc(post.image)}" alt="${esc(post.author)}의 게시 사진">` : '';
  modal(`${post.image ? '사진 나눔' : '큐티 나눔'}`, `<div class="post-detail">${image}<div class="qt-post-meta"><span>${esc(post.author)}</span><span>${fmt(post.date, { year: 'numeric', month: 'long', day: 'numeric' })}</span></div><p class="post-detail-content">${esc(post.content)}</p><section class="comment-thread"><h3>댓글 ${post.comments.length}개</h3>${comments || '<p class="muted">첫 댓글을 남겨 보세요.</p>'}</section></div>`, `<button class="btn" data-close>닫기</button><button class="btn primary" id="detailComment">댓글 달기</button>${post.image && (post.authorId === user.id || user.role === 'admin') ? '<button class="btn" id="editMeditation">수정</button>' : ''}`);
  document.getElementById('detailComment')?.addEventListener('click', () => commentModal(id));
  document.getElementById('editMeditation')?.addEventListener('click', () => editMeditationModal(id));
}

function commentModal(postId) {
  modal('댓글 남기기', `<form id="commentForm" class="form"><div class="field full"><label for="commentText">함께 나눌 말 *</label><textarea id="commentText" name="content" required maxlength="3000" placeholder="따뜻한 응원과 나눔을 적어 주세요."></textarea></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="saveComment">댓글 등록</button>');
  document.getElementById('saveComment').onclick = async () => {
    const content = document.getElementById('commentText').value.trim();
    if (!content) return;
    const { error } = await supabase.from('comments').insert({ post_id: postId, author_id: user.id, author_name: user.name, content });
    if (error) { toast('댓글을 저장하지 못했어요.'); return; }
    closeModal();
    await refreshAndRender('댓글을 남겼어요.');
  };
}

function qtPostModal() {
  modal('오늘의 큐티 나눔', `<form id="qtPostForm" class="form"><div class="field"><label for="qtCategory">나눔 주제</label><select id="qtCategory" name="category"><option>오늘의 묵상</option><option>함께 기도해요</option><option>감사 나눔</option></select></div><div class="field"><label for="qtVerse">말씀 본문 (선택)</label><input id="qtVerse" name="verse" maxlength="160" placeholder="예: 시편 23편 1절"></div><div class="field full"><label for="qtReflection">말씀을 읽고 마음에 남은 점 *</label><textarea id="qtReflection" name="reflection" required maxlength="7500" placeholder="오늘 말씀을 통해 느낀 점이나 삶의 이야기를 나눠 주세요."></textarea></div><div class="field full"><label for="qtPrayer">함께 나눌 기도 (선택)</label><textarea id="qtPrayer" name="prayer" maxlength="2000" placeholder="함께 기도하고 싶은 내용을 적어 주세요."></textarea></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="saveQtPost">나눔 올리기</button>');
  document.getElementById('saveQtPost').onclick = async () => {
    const form = new FormData(document.getElementById('qtPostForm'));
    const reflection = String(form.get('reflection')).trim();
    if (!reflection) return;
    const verse = String(form.get('verse')).trim();
    const prayer = String(form.get('prayer')).trim();
    const content = `${verse ? `말씀 본문: ${verse}\n\n` : ''}묵상 나눔\n${reflection}${prayer ? `\n\n함께 기도해요\n${prayer}` : ''}`;
    const { error } = await supabase.from('board_posts').insert({ author_id: user.id, author_name: user.name, post_date: todayISO(), category: form.get('category'), content });
    if (error) { toast('큐티 나눔을 저장하지 못했어요.'); return; }
    closeModal();
    await refreshAndRender('큐티 나눔을 올렸어요.');
  };
}

function photoPostModal() {
  modal('사진 게시판에 올리기', `<form id="photoPostForm" class="form"><div class="field full"><label for="photoUpload">사진 선택 (JPG·PNG·WebP, 5MB 이하) *</label><input id="photoUpload" name="image" type="file" accept="image/jpeg,image/png,image/webp" required></div><div class="field full"><label for="photoCaption">사진 이야기 *</label><textarea id="photoCaption" name="content" required maxlength="10000" placeholder="이 사진에 담긴 순간을 나눠 주세요."></textarea></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="savePhotoPost">사진 올리기</button>');
  document.getElementById('savePhotoPost').onclick = async () => {
    const form = document.getElementById('photoPostForm');
    const file = form.elements.image.files[0];
    const content = form.elements.content.value.trim();
    if (!file || !content) { form.reportValidity(); return; }
    if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast('JPG, PNG, WebP 형식의 5MB 이하 사진을 선택해 주세요.');
      return;
    }
    const extension = file.type.split('/')[1].replace('jpeg', 'jpg');
    const imagePath = `${user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from('meditations').upload(imagePath, file, { contentType: file.type, upsert: false });
    if (uploadError) { toast('사진을 올리지 못했어요.'); return; }
    const { error } = await supabase.from('board_posts').insert({ author_id: user.id, author_name: user.name, post_date: todayISO(), category: '사진 나눔', content, image_path: imagePath });
    if (error) {
      await supabase.storage.from('meditations').remove([imagePath]);
      toast('사진 게시글을 저장하지 못했어요.');
      return;
    }
    closeModal();
    await refreshAndRender('사진을 게시판에 올렸어요.');
  };
}

function editMeditationModal(id) {
  const meditation = db.meditations.find((item) => item.id === id);
  if (!meditation) return;
  modal('묵상 수정', `<form id="editMedForm" class="form"><div class="field full"><label for="editMedText">묵상 내용 *</label><textarea id="editMedText" name="content" required maxlength="10000">${esc(meditation.content)}</textarea></div><div class="field full"><label for="editMedImage">사진 바꾸기 (선택, JPG·PNG·WebP 5MB 이하)</label><input id="editMedImage" name="image" type="file" accept="image/jpeg,image/png,image/webp"><small class="muted">새 사진을 고르지 않으면 기존 사진을 유지합니다.</small></div></form>`, '<button class="btn" data-close>취소</button><button class="btn primary" id="saveMedEdit">저장</button>');
  document.getElementById('saveMedEdit').onclick = async () => {
    const content = document.getElementById('editMedText').value.trim();
    const file = document.getElementById('editMedImage').files[0];
    if (!content) return;
    let newImagePath = meditation.imagePath;
    let uploadedPath = null;
    if (file) {
      if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        toast('JPG, PNG, WebP 형식의 5MB 이하 사진을 선택해 주세요.');
        return;
      }
      const extension = file.type.split('/')[1].replace('jpeg', 'jpg');
      uploadedPath = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from('meditations').upload(uploadedPath, file, { contentType: file.type, upsert: false });
      if (uploadError) { toast('새 사진을 올리지 못했어요.'); return; }
      newImagePath = uploadedPath;
    }
    const { error } = await supabase.from('board_posts').update({ content, image_path: newImagePath }).eq('id', id);
    if (error) {
      if (uploadedPath) await supabase.storage.from('meditations').remove([uploadedPath]);
      toast('수정하지 못했어요. 게시글 작성자나 관리자 계정인지 확인해 주세요.');
      return;
    }
    if (uploadedPath && meditation.imagePath) await supabase.storage.from('meditations').remove([meditation.imagePath]);
    closeModal();
    await refreshAndRender('묵상을 수정했어요.');
  };
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

  document.querySelectorAll('[data-board-tab]').forEach((button) => {
    button.onclick = () => { boardTab = button.dataset.boardTab; render(); };
  });
  document.getElementById('newPost')?.addEventListener('click', qtPostModal);
  document.getElementById('newPhotoPost')?.addEventListener('click', photoPostModal);

  document.querySelectorAll('[data-comment]').forEach((button) => {
    button.onclick = () => commentModal(button.dataset.comment);
  });

  document.querySelectorAll('[data-post-detail]').forEach((card) => {
    card.onclick = () => postDetailModal(card.dataset.postDetail);
  });

}

boot();
