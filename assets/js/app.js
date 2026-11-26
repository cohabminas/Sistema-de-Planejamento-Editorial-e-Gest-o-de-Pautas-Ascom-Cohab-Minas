/* =============================================================================
 * PLANEJAMENTO EDITORIAL • ASCOM COHAB MINAS
 * Front-end conectado ao Supabase (Auth + Postgres com RLS + Realtime)
 * ========================================================================== */
'use strict';

// Proteção contra clickjacking (o GitHub Pages não permite cabeçalho X-Frame-Options)
if (window.top !== window.self) {
  try { window.top.location = window.self.location.href; } catch (_) { document.documentElement.innerHTML = ''; }
}

// =============================================================================
// CONFIGURAÇÃO E CLIENTE SUPABASE
// =============================================================================
const CFG = window.COHAB_CONFIG || {};
const IS_CONFIGURED = Boolean(
  CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
  !CFG.SUPABASE_URL.includes('SEU-PROJETO') && !CFG.SUPABASE_ANON_KEY.includes('SUA-CHAVE')
);

// Detecta convite/recuperação ANTES do cliente consumir o hash da URL
const AUTH_URL_TYPE = (() => {
  const h = new URLSearchParams(window.location.hash.slice(1));
  return h.get('type') || new URLSearchParams(window.location.search).get('type') || '';
})();
const AUTH_URL_ERROR = (() => {
  const h = new URLSearchParams(window.location.hash.slice(1));
  return h.get('error_description') || '';
})();

const REMEMBER_KEY = 'cohab-ascom-remember';
// Sessão em sessionStorage por padrão (fecha a aba = sai); localStorage só com "Manter conectado"
const authStorage = {
  getItem: (k) => sessionStorage.getItem(k) ?? localStorage.getItem(k),
  setItem: (k, v) => {
    const remember = localStorage.getItem(REMEMBER_KEY) === '1';
    (remember ? localStorage : sessionStorage).setItem(k, v);
    (remember ? sessionStorage : localStorage).removeItem(k);
  },
  removeItem: (k) => { sessionStorage.removeItem(k); localStorage.removeItem(k); }
};

const sb = IS_CONFIGURED && window.supabase
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: authStorage,
        storageKey: 'cohab-ascom-auth'
      }
    })
  : null;

// =============================================================================
// CONSTANTES
// =============================================================================
const LEGACY_KEYS = {
  pautas: 'cohab_minas_ascom_pautas_clean_v1',
  logs: 'cohab_minas_ascom_logs_clean_v1',
  suggestions: 'cohab_minas_ascom_suggestions_clean_v1',
  member: 'cohab_minas_ascom_member_clean_v1',
  editorias: 'cohab_minas_ascom_editorias_clean_v1'
};
const LOGIN_LOCK_KEY = 'cohab-ascom-login-lock';
const FORMAT_OPTIONS = ['Reels', 'Carrossel', 'Card Único', 'Story'];
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const ROLE_LABELS = { admin: 'Administrador', editor: 'Editor', leitor: 'Leitor' };
const TABS = ['calendar', 'suggestions', 'hierarchy', 'completed', 'logs', 'users'];

const TYPE_META = {
  QUENTE: { label: 'Pauta Quente', dotClass: 'bg-red-500', dotHex: '#EF4444', badgeClass: 'bg-white border-cohab-border' },
  FRIA: { label: 'Pauta Fria', dotClass: 'bg-sky-400', dotHex: '#38BDF8', badgeClass: 'bg-white border-cohab-border' }
};
const STATUS_META = {
  'A Fazer': { dotClass: 'bg-amber-400', dotHex: '#FBBF24', borderClass: 'border-l-amber-400', badgeClass: 'bg-white border-cohab-border text-cohab-graphite' },
  'Produzindo': { dotClass: 'bg-orange-500', dotHex: '#F97316', borderClass: 'border-l-orange-500', badgeClass: 'bg-white border-cohab-border text-cohab-graphite' },
  'Aprovado': { dotClass: 'bg-purple-500', dotHex: '#A855F7', borderClass: 'border-l-purple-500', badgeClass: 'bg-white border-cohab-border text-cohab-graphite' },
  'Publicado': { dotClass: 'bg-emerald-500', dotHex: '#10B981', borderClass: 'border-l-emerald-500', badgeClass: 'bg-white border-cohab-border text-cohab-graphite' }
};

// =============================================================================
// ESTADO
// =============================================================================
const state = {
  user: null,
  profile: null,
  aal: 'aal1',
  factors: [],
  pautas: [],
  suggestions: [],
  logs: [],
  profiles: [],
  editorias: ['Serviços'],
  channel: null,
  loaded: false,
  hierarchyFilter: 'ALL'
};
let pautas = []; // alias para compatibilidade com renderizações
let modalAssignees = [];
let currentTab = 'calendar';
const _now = new Date();
let currentYear = _now.getFullYear();
let currentMonth = _now.getMonth();
let searchCloseTimer = null;
let reloadTimer = null;
let mfaEnrollFactorId = null;

// =============================================================================
// PERMISSÕES (a decisão final é sempre do banco via RLS)
// =============================================================================
const can = {
  edit: () => ['admin', 'editor'].includes(state.profile?.role),
  adminRole: () => state.profile?.role === 'admin',
  admin: () => state.profile?.role === 'admin' && (!CFG.ADMIN_REQUIRES_MFA || state.aal === 'aal2')
};

// =============================================================================
// UTILITÁRIOS
// =============================================================================
const $ = (id) => document.getElementById(id);

function formatSentenceCase(str) {
  if (!str) return '';
  const t = String(str).trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
}

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDateBR(isoDate) {
  if (!isoDate) return '';
  const p = String(isoDate).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : isoDate;
}

function formatDateTimeBR(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayISO() { return toISODate(new Date()); }

function getPersonInitials(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function normalizeAssignees(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map(n => String(n || '').trim()).filter(Boolean))];
  if (typeof raw === 'string' && raw.trim()) return [...new Set(raw.split(',').map(n => n.trim()).filter(Boolean))];
  return [];
}

function formatAssigneesFull(raw) {
  return normalizeAssignees(raw).map(n => `${n} (${getPersonInitials(n)})`).join(', ');
}

function normalizeLegacyStatus(status) {
  if (status === 'Em Produção') return 'Produzindo';
  return STATUS_META[status] ? status : 'A Fazer';
}

function appUrl() { return window.location.origin + window.location.pathname; }

function showToast(message, type = 'success') {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto px-4 py-2.5 rounded-xl shadow-lg border text-xs font-bold flex items-center gap-2 transition-opacity duration-300 max-w-sm ${
    type === 'error' ? 'bg-red-50 text-red-800 border-red-200'
      : type === 'info' ? 'bg-white text-cohab-graphite border-cohab-border'
        : 'bg-cohab-graphite text-white border-cohab-graphiteDark'}`;
  const icon = type === 'error' ? 'fa-circle-exclamation text-red-500' : type === 'info' ? 'fa-circle-info text-sky-500' : 'fa-circle-check text-emerald-400';
  toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, type === 'error' ? 5000 : 3000);
}

function translateError(error) {
  const msg = String(error?.message || error || '');
  const code = error?.code || '';
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return /administradores|próprio/i.test(msg) ? msg : 'Você não tem permissão para esta ação.';
  }
  if (/JWT expired|invalid jwt|session/i.test(msg)) return 'Sua sessão expirou. Entre novamente.';
  if (code === '23514') return 'Dados inválidos: verifique o tamanho dos campos.';
  if (code === '23505') return 'Este registro já existe.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sem conexão com o servidor. Verifique sua internet.';
  return msg || 'Ocorreu um erro inesperado.';
}

async function dbRun(promise, okMessage) {
  try {
    const { data, error } = await promise;
    if (error) { showToast(translateError(error), 'error'); return { ok: false, error }; }
    if (okMessage) showToast(okMessage);
    return { ok: true, data };
  } catch (e) {
    showToast(translateError(e), 'error');
    return { ok: false, error: e };
  }
}

// =============================================================================
// MODAIS GENÉRICOS
// =============================================================================
function openModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.remove('hidden');
  m.classList.add('flex');
  const focusable = m.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
  if (focusable) setTimeout(() => focusable.focus(), 50);
}

function closeModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.add('hidden');
  m.classList.remove('flex');
}

function topOpenModal() {
  const open = [...document.querySelectorAll('[data-modal]')].filter(m => !m.classList.contains('hidden'));
  return open.sort((a, b) => (parseInt(getComputedStyle(b).zIndex, 10) || 0) - (parseInt(getComputedStyle(a).zIndex, 10) || 0))[0] || null;
}

let confirmCallback = null;
function openConfirmModal(title, message, onConfirm, confirmLabel = 'Confirmar') {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmAcceptBtn').textContent = confirmLabel;
  confirmCallback = onConfirm;
  openModal('confirmModal');
  setTimeout(() => $('confirmCancelBtn').focus(), 60);
}
function closeConfirmModal() { closeModal('confirmModal'); confirmCallback = null; }

function openShortcutsHelp() { closeAllDropdowns(); openModal('shortcutsModal'); }

// =============================================================================
// TELAS: CONFIGURAÇÃO / LOGIN / APP
// =============================================================================
function showScreen(name) {
  const map = { setup: 'setupScreen', auth: 'authScreen', app: 'appShell' };
  Object.entries(map).forEach(([k, id]) => {
    const el = $(id);
    el.classList.toggle('hidden', k !== name);
    el.classList.toggle('flex', k === name);
  });
}

function showAuthStep(step) {
  showScreen('auth');
  document.querySelectorAll('[data-auth-step]').forEach(f => f.classList.toggle('hidden', f.dataset.authStep !== step));
  hideAuthMessages();
  if (step === 'setpw') renderPasswordRules('newPassword', 'pwRules');
  const first = document.querySelector(`[data-auth-step="${step}"] input`);
  if (first) setTimeout(() => first.focus(), 60);
}

function hideAuthMessages() { $('authError').classList.add('hidden'); $('authInfo').classList.add('hidden'); }
function showAuthError(msg) { $('authErrorText').textContent = msg; $('authError').classList.remove('hidden'); $('authInfo').classList.add('hidden'); }
function showAuthInfo(msg) { $('authInfoText').textContent = msg; $('authInfo').classList.remove('hidden'); $('authError').classList.add('hidden'); }

function setButtonLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i><span>${escapeHTML(label || 'Aguarde…')}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
  }
}

function togglePasswordVisibility(inputId, btn) {
  const input = $(inputId);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = `<i class="fa-regular ${show ? 'fa-eye-slash' : 'fa-eye'} text-xs"></i>`;
}

// ---------------------------------------------------------------- Senhas fortes
const PASSWORD_RULES = [
  { test: p => p.length >= 12, label: '12+ caracteres' },
  { test: p => /[A-Z]/.test(p), label: 'Letra maiúscula' },
  { test: p => /[a-z]/.test(p), label: 'Letra minúscula' },
  { test: p => /\d/.test(p), label: 'Número' },
  { test: p => /[^A-Za-z0-9]/.test(p), label: 'Símbolo (!@#…)' }
];
function isStrongPassword(p) { return PASSWORD_RULES.every(r => r.test(p || '')); }

function renderPasswordRules(inputId, listId) {
  const val = $(inputId)?.value || '';
  const list = $(listId);
  if (!list) return;
  list.innerHTML = PASSWORD_RULES.map(r => {
    const ok = r.test(val);
    return `<li class="${ok ? 'text-emerald-700' : 'text-cohab-medium'}"><i class="fa-solid ${ok ? 'fa-circle-check' : 'fa-circle'} text-[9px] mr-1"></i>${r.label}</li>`;
  }).join('');
}

function generateStrongPassword(inputId, rulesId) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?-_+='];
  const all = sets.join('');
  const rand = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = sets.map(s => s[rand(s.length)]);
  while (chars.length < 16) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rand(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  $(inputId).value = chars.join('');
  renderPasswordRules(inputId, rulesId);
}

// ---------------------------------------------------------------- Bloqueio de tentativas
function getLoginLock() {
  try { return JSON.parse(localStorage.getItem(LOGIN_LOCK_KEY)) || { fails: 0, until: 0 }; } catch { return { fails: 0, until: 0 }; }
}
function registerLoginFail() {
  const lock = getLoginLock();
  lock.fails += 1;
  if (lock.fails >= 5) lock.until = Date.now() + Math.min(15 * 60000, 30000 * Math.pow(2, lock.fails - 5));
  localStorage.setItem(LOGIN_LOCK_KEY, JSON.stringify(lock));
  return lock;
}
function clearLoginLock() { localStorage.removeItem(LOGIN_LOCK_KEY); }

// =============================================================================
// AUTENTICAÇÃO
// =============================================================================
async function bootAuth() {
  if (!sb) { showScreen('setup'); return; }

  sb.auth.onAuthStateChange((event) => {
    // Não chamar o Supabase de forma síncrona aqui (evita travamento do supabase-js)
    if (event === 'PASSWORD_RECOVERY') setTimeout(() => showAuthStep('setpw'), 0);
    // Logout remoto (outra aba, token revogado): só reage se ainda houver usuário em tela
    if (event === 'SIGNED_OUT') setTimeout(() => { if (state.user) { teardownApp(); showAuthStep('login'); showAuthInfo('Sua sessão foi encerrada.'); } }, 0);
  });

  if (AUTH_URL_ERROR) {
    history.replaceState(null, '', appUrl());
    showAuthStep('login');
    showAuthError('O link é inválido ou expirou. Solicite um novo.');
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session && (AUTH_URL_TYPE === 'invite' || AUTH_URL_TYPE === 'recovery')) {
    history.replaceState(null, '', appUrl());
    showAuthStep('setpw');
    return;
  }
  if (session) await afterSignIn();
  else showAuthStep('login');
}

async function handleLogin(event) {
  event.preventDefault();
  hideAuthMessages();
  const lock = getLoginLock();
  if (lock.until > Date.now()) {
    const s = Math.ceil((lock.until - Date.now()) / 1000);
    showAuthError(`Muitas tentativas. Aguarde ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + ' s'} para tentar novamente.`);
    return;
  }
  const email = $('loginEmail').value.trim().toLowerCase();
  const password = $('loginPassword').value;
  if (!email || !password) { showAuthError('Informe e-mail e senha.'); return; }

  localStorage.setItem(REMEMBER_KEY, $('loginRemember').checked ? '1' : '0');
  const btn = $('loginSubmit');
  setButtonLoading(btn, true, 'Entrando…');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  setButtonLoading(btn, false);
  if (error) {
    const l = registerLoginFail();
    if (/email not confirmed/i.test(error.message)) showAuthError('Confirme seu e-mail antes de entrar.');
    else if (/rate limit|too many/i.test(error.message)) showAuthError('Muitas tentativas. Aguarde alguns minutos.');
    else showAuthError(`E-mail ou senha inválidos.${l.fails >= 3 && l.fails < 5 ? ` Restam ${5 - l.fails} tentativa(s) antes do bloqueio temporário.` : ''}`);
    $('loginPassword').value = '';
    return;
  }
  clearLoginLock();
  $('loginPassword').value = '';
  await afterSignIn();
}

async function handleMfaLogin(event) {
  event.preventDefault();
  const code = $('mfaCode').value.replace(/\D/g, '');
  if (code.length !== 6) { showAuthError('Digite os 6 dígitos do código.'); return; }
  const btn = event.submitter || event.target.querySelector('button[type=submit]');
  setButtonLoading(btn, true, 'Verificando…');
  const { data: f } = await sb.auth.mfa.listFactors();
  const factor = (f?.totp || []).find(x => x.status === 'verified') || (f?.totp || [])[0];
  if (!factor) { setButtonLoading(btn, false); showAuthError('Nenhum fator de verificação encontrado.'); return; }
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  setButtonLoading(btn, false);
  $('mfaCode').value = '';
  if (error) { showAuthError('Código inválido ou expirado. Tente novamente.'); return; }
  await afterSignIn();
}

async function handleForgot(event) {
  event.preventDefault();
  const email = $('forgotEmail').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showAuthError('Informe um e-mail válido.'); return; }
  const btn = event.submitter || event.target.querySelector('button[type=submit]');
  setButtonLoading(btn, true, 'Enviando…');
  await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  setButtonLoading(btn, false);
  // Mensagem neutra: não revela se o e-mail existe
  showAuthInfo('Se o e-mail estiver cadastrado, você receberá o link em instantes. Verifique também o spam.');
}

async function handleSetPassword(event) {
  event.preventDefault();
  const p1 = $('newPassword').value;
  const p2 = $('newPasswordConfirm').value;
  if (!isStrongPassword(p1)) { showAuthError('A senha não atende aos requisitos de segurança.'); return; }
  if (p1 !== p2) { showAuthError('As senhas não conferem.'); return; }
  const btn = event.submitter || event.target.querySelector('button[type=submit]');
  setButtonLoading(btn, true, 'Salvando…');
  const { error } = await sb.auth.updateUser({ password: p1 });
  setButtonLoading(btn, false);
  if (error) { showAuthError(/same|different/i.test(error.message) ? 'A nova senha deve ser diferente da anterior.' : translateError(error)); return; }
  $('newPassword').value = ''; $('newPasswordConfirm').value = '';
  showToast('Senha definida com sucesso!');
  await afterSignIn();
}

async function afterSignIn() {
  try {
    const { data: aalData } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData && aalData.nextLevel === 'aal2' && aalData.currentLevel !== 'aal2') {
      showAuthStep('mfa');
      return;
    }
    state.aal = aalData?.currentLevel || 'aal1';

    const { data: { user }, error: uErr } = await sb.auth.getUser();
    if (uErr || !user) { showAuthStep('login'); return; }
    state.user = user;

    const { data: profile, error: pErr } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (pErr || !profile) {
      teardownApp();
      await sb.auth.signOut();
      showAuthStep('login');
      showAuthError('Seu perfil não foi encontrado. Fale com o administrador.');
      return;
    }
    if (!profile.ativo) {
      teardownApp();
      await sb.auth.signOut();
      showAuthStep('login');
      showAuthError('Seu acesso está desativado. Fale com o administrador.');
      return;
    }
    state.profile = profile;
    await refreshFactors();

    if (!sessionStorage.getItem('cohab-ascom-access-logged')) {
      sessionStorage.setItem('cohab-ascom-access-logged', '1');
      sb.rpc('registrar_acesso').then(() => {}, () => {});
    }

    enterApp();
  } catch (e) {
    showAuthStep('login');
    showAuthError(translateError(e));
  }
}

async function refreshFactors() {
  const { data } = await sb.auth.mfa.listFactors();
  state.factors = (data?.all || []).filter(f => f.factor_type === 'totp');
}

async function signOut() {
  closeAllDropdowns();
  sessionStorage.removeItem('cohab-ascom-access-logged');
  teardownApp();
  if (sb) await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  showAuthStep('login');
}

function signOutEverywhere() {
  openConfirmModal('Sair de todos os dispositivos', 'Todas as suas sessões ativas serão encerradas, inclusive esta.', async () => {
    sessionStorage.removeItem('cohab-ascom-access-logged');
    teardownApp();
    await sb.auth.signOut({ scope: 'global' }).catch(() => {});
    showAuthStep('login');
    showAuthInfo('Você saiu de todos os dispositivos.');
  }, 'Sair de todos');
}

function teardownApp() {
  if (state.channel) { sb?.removeChannel(state.channel); state.channel = null; }
  stopIdleTimer();
  Object.assign(state, { user: null, profile: null, aal: 'aal1', factors: [], pautas: [], suggestions: [], logs: [], profiles: [], editorias: ['Serviços'], loaded: false });
  pautas = [];
  document.body.dataset.role = 'none';
  document.querySelectorAll('[data-modal]').forEach(m => { m.classList.add('hidden'); m.classList.remove('flex'); });
  closeModal('idleModal');
}

// =============================================================================
// ENTRADA NO APP
// =============================================================================
let LOADING_HTML = '';
function enterApp() {
  if (!LOADING_HTML) LOADING_HTML = $('loadingState').innerHTML;
  showScreen('app');
  document.body.dataset.role = state.profile.role;
  updateUserChip();
  applyRoleUI();
  $('loadingState').innerHTML = LOADING_HTML;
  $('loadingState').classList.remove('hidden');
  TABS.forEach(t => $(`view-${t}`)?.classList.add('hidden'));
  loadAll().then(() => {
    if (!state.user) return;
    if (!state.loaded) {
      $('loadingState').innerHTML = `<i class="fa-solid fa-triangle-exclamation text-2xl text-cohab-terracotta"></i>
        <span class="text-xs font-bold">Não foi possível carregar os dados.</span>
        <button type="button" onclick="location.reload()" class="btn-primary h-9 px-4 text-xs">Tentar novamente</button>`;
      return;
    }
    $('loadingState').classList.add('hidden');
    switchTab(currentTab === 'users' && !can.adminRole() ? 'calendar' : currentTab);
    checkLocalImport();
  });
  subscribeRealtime();
  startIdleTimer();
}

function updateUserChip() {
  const p = state.profile;
  $('userAvatar').textContent = getPersonInitials(p.nome || p.email) || '?';
  $('userName').textContent = p.nome || p.email;
  $('userRoleLabel').textContent = ROLE_LABELS[p.role] || p.role;
  $('userMenuName').textContent = p.nome || '—';
  $('userMenuEmail').textContent = p.email || state.user?.email || '';
}

function applyRoleUI() {
  document.querySelectorAll('[data-requires="edit"]').forEach(el => el.classList.toggle('hidden', !can.edit()));
  document.querySelectorAll('[data-requires="admin-role"]').forEach(el => el.classList.toggle('hidden', !can.adminRole()));
  $('readOnlyBanner').classList.toggle('hidden', can.edit());
  $('mfaAdminBanner').classList.toggle('hidden', !(can.adminRole() && CFG.ADMIN_REQUIRES_MFA && state.aal !== 'aal2'));
}

// =============================================================================
// DADOS (Supabase)
// =============================================================================
function mapPauta(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    data: row.data,
    tipo: row.tipo,
    prioridade: row.prioridade,
    status: normalizeLegacyStatus(row.status),
    responsavel: normalizeAssignees(row.responsaveis),
    formato: row.formato || '',
    editoria: row.editoria || 'Serviços',
    descricao: row.descricao || '',
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function loadAll() {
  setSync('loading');
  try {
    const [p, s, l, pr, ed] = await Promise.all([
      sb.from('pautas').select('*').order('data', { ascending: true }),
      sb.from('sugestoes').select('*').order('created_at', { ascending: false }),
      sb.from('logs').select('*').order('created_at', { ascending: false }).limit(500),
      sb.from('profiles').select('id, nome, email, role, ativo, created_at').order('nome', { ascending: true }),
      sb.from('editorias').select('nome').order('nome', { ascending: true })
    ]);
    const firstErr = [p, s, l, pr, ed].find(r => r.error)?.error;
    if (firstErr) throw firstErr;

    state.pautas = (p.data || []).map(mapPauta);
    pautas = state.pautas;
    state.suggestions = s.data || [];
    state.logs = l.data || [];
    state.profiles = pr.data || [];
    state.editorias = [...new Set(['Serviços', ...(ed.data || []).map(e => e.nome)])];

    // Atualiza o próprio perfil (papel pode ter mudado por outro admin)
    const me = state.profiles.find(x => x.id === state.user?.id);
    if (me) {
      if (!me.ativo) { await signOut(); showAuthError('Seu acesso foi desativado.'); return; }
      const roleChanged = me.role !== state.profile.role;
      state.profile = { ...state.profile, ...me };
      if (roleChanged) {
        document.body.dataset.role = me.role;
        updateUserChip();
        applyRoleUI();
        showToast(`Seu papel foi alterado para ${ROLE_LABELS[me.role]}.`, 'info');
      }
    }

    state.loaded = true;
    renderEditoriaOptions($('pautaEditoria')?.value || 'Serviços');
    renderAll();
    setSync(state.channel ? 'live' : 'ok');
  } catch (e) {
    setSync('error');
    showToast(translateError(e), 'error');
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { if (state.user) loadAll(); }, 350);
}

function subscribeRealtime() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = sb
    .channel('ascom-planejamento')
    .on('postgres_changes', { event: '*', schema: 'public' }, () => scheduleReload())
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setSync('live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync('ok');
    });
}

function setSync(status) {
  const dot = $('syncDot'), label = $('syncLabel'), wrap = $('syncIndicator');
  if (!dot) return;
  const map = {
    loading: ['bg-amber-400 animate-pulse', 'Sincronizando…'],
    live: ['bg-emerald-500', 'Ao vivo'],
    ok: ['bg-sky-500', 'Conectado'],
    error: ['bg-red-500', 'Erro de conexão']
  };
  const [cls, txt] = map[status] || map.ok;
  dot.className = `w-2 h-2 rounded-full ${cls}`;
  label.textContent = txt;
  wrap.title = status === 'live' ? 'Alterações da equipe aparecem em tempo real' : txt;
}

// =============================================================================
// INATIVIDADE
// =============================================================================
let idleTimer = null, idleWarnTimer = null, idleCountdownTimer = null;
const IDLE_MS = Math.max(5, Number(CFG.INACTIVITY_MINUTES) || 30) * 60000;
const IDLE_WARN_MS = 60000;
const IDLE_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
let lastActivity = 0;

function onActivity() {
  const now = Date.now();
  if (now - lastActivity < 5000) return;
  lastActivity = now;
  if ($('idleModal').classList.contains('hidden')) resetIdleTimer(false);
}

function startIdleTimer() {
  IDLE_EVENTS.forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));
  resetIdleTimer(false);
}

function stopIdleTimer() {
  IDLE_EVENTS.forEach(ev => window.removeEventListener(ev, onActivity));
  clearTimeout(idleTimer); clearTimeout(idleWarnTimer); clearInterval(idleCountdownTimer);
}

function resetIdleTimer(fromModal) {
  clearTimeout(idleTimer); clearTimeout(idleWarnTimer); clearInterval(idleCountdownTimer);
  if (fromModal) { $('idleModal').classList.add('hidden'); $('idleModal').classList.remove('flex'); }
  if (!state.user) return;
  idleWarnTimer = setTimeout(() => {
    let left = IDLE_WARN_MS / 1000;
    $('idleCountdown').textContent = left;
    $('idleModal').classList.remove('hidden'); $('idleModal').classList.add('flex');
    idleCountdownTimer = setInterval(() => { left -= 1; $('idleCountdown').textContent = Math.max(0, left); }, 1000);
  }, IDLE_MS - IDLE_WARN_MS);
  idleTimer = setTimeout(async () => {
    await signOut();
    showAuthInfo('Você foi desconectado por inatividade.');
  }, IDLE_MS);
}

// =============================================================================
// NAVEGAÇÃO E BUSCA
// =============================================================================
function switchTab(tabName) {
  if (tabName === 'users' && !can.adminRole()) tabName = 'calendar';
  currentTab = tabName;
  TABS.forEach(name => {
    $(`view-${name}`)?.classList.toggle('hidden', name !== tabName || !state.loaded);
    const btn = $(`tab-${name}`);
    if (btn) {
      btn.classList.toggle('active', name === tabName);
      btn.setAttribute('aria-selected', name === tabName ? 'true' : 'false');
    }
  });
  renderAll();
}

function openSearchOverlay(shouldFocus = false) {
  clearTimeout(searchCloseTimer); searchCloseTimer = null;
  const panel = $('searchOverlayPanel');
  panel.classList.remove('invisible', 'opacity-0', 'scale-x-95', 'pointer-events-none');
  if (shouldFocus) $('searchInput').focus();
}

function handleSearchMouseLeave() {
  const input = $('searchInput');
  if ((input.value || '').trim() || document.activeElement === input) return;
  searchCloseTimer = setTimeout(() => closeSearchOverlay(false), 140);
}

function handleSearchBlur() {
  const input = $('searchInput');
  if ((input.value || '').trim()) return;
  setTimeout(() => {
    if (!$('navSearchContainer').matches(':hover') && document.activeElement !== input) closeSearchOverlay(false);
  }, 120);
}

function closeSearchOverlay(clear = false) {
  clearTimeout(searchCloseTimer); searchCloseTimer = null;
  const input = $('searchInput');
  if (document.activeElement === input) input.blur();
  $('searchOverlayPanel').classList.add('invisible', 'opacity-0', 'scale-x-95', 'pointer-events-none');
  if (clear) clearSearchInput();
}

function clearSearchInput() { $('searchInput').value = ''; applyFilters(); }

function closeAllDropdowns() { document.querySelectorAll('[data-dropdown-menu]').forEach(m => m.classList.add('hidden')); }

function toggleCustomDropdown(menuId, event) {
  if (event) event.stopPropagation();
  const target = $(menuId);
  if (!target) return;
  const wasHidden = target.classList.contains('hidden');
  closeAllDropdowns();
  if (wasHidden) target.classList.remove('hidden');
}

function applyFilters() {
  const q = ($('searchInput').value || '').trim();
  $('clearSearchBtn').classList.toggle('hidden', !q);
  $('searchActiveDot').classList.toggle('hidden', !q);
  renderAll();
}

function stripAccents(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function matchesSearchAndFilter(pauta) {
  const q = stripAccents(($('searchInput')?.value || '').trim().toLowerCase());
  if (!q) return true;
  const st = normalizeLegacyStatus(pauta.status);
  const tipoLabel = pauta.tipo === 'QUENTE' ? 'pauta quente urgente' : 'pauta fria';
  const prioText = st !== 'Publicado' ? `#${pauta.prioridade || 1} prioridade ${pauta.prioridade || 1}` : 'publicado concluido realizado';
  const assignees = normalizeAssignees(pauta.responsavel);
  const day = pauta.data ? String(parseInt(pauta.data.split('-')[2], 10)) : '';
  const monthName = pauta.data ? (MONTH_NAMES[parseInt(pauta.data.split('-')[1], 10) - 1] || '') : '';
  const haystack = stripAccents([
    pauta.titulo, pauta.editoria, pauta.formato, pauta.descricao, st, tipoLabel, prioText,
    assignees.join(' '), assignees.map(getPersonInitials).join(' '),
    formatDateBR(pauta.data), pauta.data, day ? `dia ${day}` : '', monthName
  ].join(' ').toLowerCase());
  return q.split(/\s+/).filter(Boolean).every(t => haystack.includes(t));
}

function renderCrossMonthBanner() {
  const banner = $('searchCrossMonthBanner');
  const q = ($('searchInput').value || '').trim();
  if (!q || currentTab !== 'calendar') { banner.classList.add('hidden'); banner.classList.remove('flex'); return; }
  const prefix = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
  const matches = state.pautas.filter(matchesSearchAndFilter);
  const inMonth = matches.filter(p => p.data.startsWith(prefix)).length;
  const others = {};
  matches.filter(p => !p.data.startsWith(prefix)).forEach(p => { const k = p.data.slice(0, 7); others[k] = (others[k] || 0) + 1; });
  const keys = Object.keys(others).sort();
  if (keys.length === 0) { banner.classList.add('hidden'); banner.classList.remove('flex'); return; }
  $('searchCrossMonthText').textContent = `${inMonth} resultado(s) neste mês • ${matches.length - inMonth} em outros meses:`;
  $('searchCrossMonthActions').innerHTML = keys.slice(0, 6).map(k => {
    const [y, m] = k.split('-');
    return `<button type="button" onclick="jumpToMonth(${parseInt(y, 10)}, ${parseInt(m, 10) - 1})" class="px-2.5 py-1 rounded-lg bg-white border border-amber-300 font-bold text-amber-900 hover:bg-amber-100">${MONTH_NAMES[parseInt(m, 10) - 1].slice(0, 3)}/${y} (${others[k]})</button>`;
  }).join('');
  banner.classList.remove('hidden'); banner.classList.add('flex');
}

// =============================================================================
// CALENDÁRIO
// =============================================================================
function buildYearOptions() {
  const sel = $('yearSelect');
  const base = new Date().getFullYear();
  const years = new Set([currentYear]);
  for (let y = base - 2; y <= base + 4; y++) years.add(y);
  state.pautas.forEach(p => years.add(parseInt(p.data.slice(0, 4), 10)));
  sel.innerHTML = [...years].sort().map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = String(currentYear);
}

function syncMonthSelectors() {
  if (!$('monthSelect').options.length) {
    $('monthSelect').innerHTML = MONTH_NAMES.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  }
  buildYearOptions();
  $('monthSelect').value = String(currentMonth);
}

function stepMonth(delta) {
  currentMonth += delta;
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  else if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  renderCalendar();
  renderCrossMonthBanner();
}

function jumpToMonth(y, m) { currentYear = y; currentMonth = m; switchTab('calendar'); }

function goToToday() {
  const d = new Date();
  currentYear = d.getFullYear(); currentMonth = d.getMonth();
  if (currentTab !== 'calendar') switchTab('calendar'); else { renderCalendar(); renderCrossMonthBanner(); }
}

function handleMonthYearChange() {
  currentMonth = parseInt($('monthSelect').value, 10);
  currentYear = parseInt($('yearSelect').value, 10);
  renderCalendar();
  renderCrossMonthBanner();
}

function easterDate(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const holidayCache = {};
function getHolidaysForYear(year) {
  if (holidayCache[year]) return holidayCache[year];
  const easter = easterDate(year);
  const rel = (days) => { const d = new Date(easter); d.setDate(d.getDate() + days); return toISODate(d); };
  holidayCache[year] = {
    [`${year}-01-01`]: 'Confraternização Universal',
    [rel(-48)]: 'Carnaval (ponto facultativo)',
    [rel(-47)]: 'Carnaval (ponto facultativo)',
    [rel(-2)]: 'Sexta-feira Santa',
    [`${year}-04-21`]: 'Tiradentes',
    [`${year}-05-01`]: 'Dia do Trabalho',
    [rel(60)]: 'Corpus Christi',
    [`${year}-09-07`]: 'Independência do Brasil',
    [`${year}-10-12`]: 'Nossa Sra. Aparecida',
    [`${year}-10-28`]: 'Dia do Servidor Público',
    [`${year}-11-02`]: 'Finados',
    [`${year}-11-15`]: 'Proclamação da República',
    [`${year}-11-20`]: 'Consciência Negra',
    [`${year}-12-25`]: 'Natal'
  };
  return holidayCache[year];
}

function renderCalendar() {
  const grid = $('calendarGrid');
  if (!grid) return;
  syncMonthSelectors();
  grid.innerHTML = '';

  const firstDayWeekday = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();
  const totalCells = Math.ceil((firstDayWeekday + daysInMonth) / 7) * 7;
  const tISO = todayISO();
  const holidays = { ...getHolidaysForYear(currentYear - 1), ...getHolidaysForYear(currentYear), ...getHolidaysForYear(currentYear + 1) };
  const editable = can.edit();

  const prefix = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
  const monthItems = state.pautas.filter(p => p.data.startsWith(prefix));
  const pub = monthItems.filter(p => p.status === 'Publicado').length;
  $('monthSummary').textContent = monthItems.length ? `${monthItems.length} pauta(s) no mês • ${pub} publicada(s)` : 'Nenhuma pauta neste mês';

  const isAgenda = window.matchMedia('(max-width: 767px)').matches;
  $('calendarWeekHeader').classList.toggle('hidden', isAgenda);
  grid.classList.toggle('calendar-grid-7', !isAgenda);
  grid.classList.toggle('gap-px', !isAgenda);
  grid.classList.toggle('bg-cohab-border', !isAgenda);
  if (isAgenda) { renderAgenda(grid, daysInMonth, tISO, holidays, editable); return; }

  const frag = document.createDocumentFragment();
  for (let cellIdx = 0; cellIdx < totalCells; cellIdx++) {
    const dayOffset = cellIdx - firstDayWeekday + 1;
    let cellYear = currentYear, cellMonth = currentMonth, cellDay = dayOffset, isCurrentMonth = true;
    if (dayOffset <= 0) {
      isCurrentMonth = false; cellDay = daysInPrevMonth + dayOffset; cellMonth = currentMonth - 1;
      if (cellMonth < 0) { cellMonth = 11; cellYear--; }
    } else if (dayOffset > daysInMonth) {
      isCurrentMonth = false; cellDay = dayOffset - daysInMonth; cellMonth = currentMonth + 1;
      if (cellMonth > 11) { cellMonth = 0; cellYear++; }
    }

    const isoDate = `${cellYear}-${String(cellMonth + 1).padStart(2, '0')}-${String(cellDay).padStart(2, '0')}`;
    const isToday = isoDate === tISO;
    const isPastDay = isoDate < tISO && isCurrentMonth;
    const holidayName = isCurrentMonth ? holidays[isoDate] : null;
    const weekend = cellIdx % 7 === 0 || cellIdx % 7 === 6;

    const cell = document.createElement('div');
    cell.className = `calendar-cell p-1.5 xl:p-2 flex flex-col ${
      !isCurrentMonth ? 'bg-neutral-100/80 text-cohab-medium/60'
        : isPastDay ? 'bg-[#EDEDED]'
          : isToday ? 'bg-cohab-terracottaLight/40 ring-1 ring-inset ring-cohab-terracotta/40'
            : weekend ? 'bg-[#FCFCFC] hover:bg-cohab-bg/40' : 'bg-white hover:bg-cohab-bg/30'}`;
    if (editable) {
      cell.ondblclick = (e) => { if (!e.target.closest('[data-pauta-card]')) openPautaModal(null, isoDate); };
    }

    const dayPautas = state.pautas
      .filter(p => p.data === isoDate && matchesSearchAndFilter(p))
      .sort((a, b) => (a.status === 'Publicado') - (b.status === 'Publicado') || (a.prioridade || 99) - (b.prioridade || 99));

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-1 mb-1';
    header.innerHTML = `
      <div class="flex items-center gap-1">
        <span class="text-xs font-extrabold ${isToday ? 'px-1.5 py-0.5 rounded-md bg-cohab-terracotta text-white'
          : isPastDay ? 'line-through text-neutral-500' : isCurrentMonth ? 'text-cohab-graphite' : 'text-cohab-medium/60'}">${cellDay}</span>
        ${isToday ? '<span class="text-[9px] font-extrabold uppercase text-cohab-terracotta hidden sm:inline">Hoje</span>' : ''}
        ${dayPautas.length > 1 ? `<span class="text-[9px] font-bold text-cohab-medium hidden sm:inline">${dayPautas.length}</span>` : ''}
      </div>
      ${isCurrentMonth && editable ? `
        <button type="button" onclick="openPautaModal(null, '${isoDate}')" title="Adicionar pauta em ${formatDateBR(isoDate)}" class="add-day-btn w-5 h-5 rounded-md text-cohab-medium hover:text-cohab-terracotta hover:bg-cohab-terracottaLight flex items-center justify-center transition">
          <i class="fa-solid fa-plus text-[9px]"></i>
        </button>` : ''}`;
    cell.appendChild(header);

    if (holidayName) {
      const hol = document.createElement('div');
      hol.className = 'mb-1 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-[9px] font-bold text-amber-800 truncate';
      hol.title = holidayName;
      hol.innerHTML = `<i class="fa-regular fa-calendar-check mr-1"></i>${escapeHTML(holidayName)}`;
      cell.appendChild(hol);
    }

    const stack = document.createElement('div');
    stack.className = 'space-y-1.5 flex-1 min-w-0';
    dayPautas.forEach(p => stack.appendChild(buildCalendarCard(p, isPastDay, editable)));
    cell.appendChild(stack);
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
}

function renderAgenda(grid, daysInMonth, tISO, holidays, editable) {
  const wd = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  let html = 0;
  const frag = document.createDocumentFragment();
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const items = state.pautas.filter(p => p.data === iso && matchesSearchAndFilter(p))
      .sort((a, b) => (a.status === 'Publicado') - (b.status === 'Publicado') || (a.prioridade || 99) - (b.prioridade || 99));
    const isToday = iso === tISO;
    if (!items.length && !isToday && !holidays[iso]) continue;
    html++;
    const isPast = iso < tISO;
    const row = document.createElement('div');
    row.className = `flex gap-3 px-3 py-3 border-b border-cohab-border ${isToday ? 'bg-cohab-terracottaLight/50' : isPast ? 'bg-[#F3F3F3]' : 'bg-white'}`;
    const dow = new Date(currentYear, currentMonth, d).getDay();
    row.innerHTML = `
      <div class="w-12 shrink-0 text-center">
        <div class="text-[10px] font-extrabold uppercase ${isToday ? 'text-cohab-terracotta' : 'text-cohab-medium'}">${wd[dow]}</div>
        <div class="text-lg font-extrabold leading-tight ${isToday ? 'text-cohab-terracotta' : 'text-cohab-graphiteDark'}">${d}</div>
        ${editable ? `<button type="button" onclick="openPautaModal(null, '${iso}')" title="Adicionar pauta" class="mt-1 w-7 h-7 rounded-lg border border-cohab-border bg-white text-cohab-medium"><i class="fa-solid fa-plus text-[10px]"></i></button>` : ''}
      </div>
      <div class="flex-1 min-w-0 space-y-2" data-agenda-stack></div>`;
    const stack = row.querySelector('[data-agenda-stack]');
    if (holidays[iso]) stack.insertAdjacentHTML('beforeend', `<div class="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-[11px] font-bold text-amber-800"><i class="fa-regular fa-calendar-check mr-1"></i>${escapeHTML(holidays[iso])}</div>`);
    if (!items.length) stack.insertAdjacentHTML('beforeend', `<p class="text-xs text-cohab-medium pt-2">Nada agendado${isToday ? ' para hoje' : ''}.</p>`);
    items.forEach(p => stack.appendChild(buildCalendarCard(p, false, editable)));
    frag.appendChild(row);
  }
  if (!html) {
    grid.innerHTML = emptyState('fa-calendar', 'Nenhuma pauta neste mês.', editable ? 'Toque em + Nova Pauta para criar.' : '');
    return;
  }
  grid.appendChild(frag);
}

function buildCalendarCard(pauta, isPastDay, editable) {
  const statusInfo = STATUS_META[pauta.status] || STATUS_META['A Fazer'];
  const typeInfo = TYPE_META[pauta.tipo] || TYPE_META.FRIA;
  const isPublished = pauta.status === 'Publicado';
  const assignees = normalizeAssignees(pauta.responsavel);

  const card = document.createElement('div');
  card.setAttribute('data-pauta-card', pauta.id);
  card.tabIndex = 0;
  card.onclick = (e) => { if (!e.target.closest('[data-dropdown-root]')) openPautaModal(pauta.id); };
  card.onkeydown = (e) => { if (e.key === 'Enter') openPautaModal(pauta.id); };
  card.className = `w-full rounded-lg border border-l-4 ${statusInfo.borderClass} p-1.5 xl:p-2 shadow-2xs transition cursor-pointer min-w-0 focus:outline-none focus:ring-2 focus:ring-cohab-terracotta/40 ${
    isPastDay ? 'bg-[#E5E5E5] border-neutral-300 hover:bg-white' : 'bg-white border-cohab-border hover:shadow-sm'}`;

  const statusOptionsHTML = Object.keys(STATUS_META).map(st => `
    <button type="button" onclick="event.stopPropagation(); quickChangeStatus('${pauta.id}', '${st}')"
      class="w-full px-2.5 py-1.5 text-left text-[10.5px] whitespace-nowrap ${pauta.status === st ? 'font-extrabold bg-cohab-bg' : 'font-semibold'} text-cohab-graphite hover:bg-cohab-bg flex items-center gap-2 leading-none">
      <span class="w-2 h-2 rounded-full ${STATUS_META[st].dotClass} shrink-0"></span><span>${st}</span>
    </button>`).join('');

  const primaryInitials = assignees.length ? getPersonInitials(assignees[0]) : '—';
  const extra = assignees.length > 1 ? ` +${assignees.length - 1}` : '';
  const assigneeTitle = assignees.length ? `Responsáveis: ${assignees.join(', ')}` : 'Sem designação';

  const statusControl = editable ? `
    <div class="relative flex items-center min-w-0 flex-1" data-dropdown-root>
      <button type="button" onclick="toggleCustomDropdown('statusMenu-${pauta.id}', event)"
        class="w-full h-5 xl:h-6 inline-flex items-center justify-between gap-1 text-[9px] xl:text-[9.5px] font-bold rounded-md px-1.5 xl:px-2 border ${statusInfo.badgeClass} hover:border-cohab-graphite/40 transition min-w-0">
        <span class="truncate leading-none">${escapeHTML(pauta.status)}</span>
        <i class="fa-solid fa-chevron-down text-[6.5px] xl:text-[7px] text-cohab-medium shrink-0"></i>
      </button>
      <div id="statusMenu-${pauta.id}" data-dropdown-menu class="hidden absolute left-0 bottom-full mb-1 w-32 bg-white border border-cohab-border rounded-lg shadow-lg py-1 z-30">${statusOptionsHTML}</div>
    </div>` : `
    <span class="flex-1 min-w-0 h-5 xl:h-6 inline-flex items-center text-[9px] xl:text-[9.5px] font-bold rounded-md px-1.5 border ${statusInfo.badgeClass} truncate">${escapeHTML(pauta.status)}</span>`;

  card.innerHTML = `
    <p class="text-[10.5px] xl:text-[11.5px] font-bold leading-snug truncate ${isPastDay ? 'text-neutral-700' : 'text-cohab-graphiteDark'} ${isPublished ? 'line-through text-cohab-medium' : ''}" title="${escapeHTML(pauta.titulo)}">${escapeHTML(pauta.titulo)}</p>
    ${pauta.editoria ? `<p class="mt-0.5 xl:mt-1 text-[9.5px] xl:text-[10px] font-semibold text-cohab-medium truncate flex items-center gap-1 leading-tight"><i class="fa-solid fa-tag text-[8px] text-cohab-graphite/70 shrink-0"></i><span class="truncate">${escapeHTML(pauta.editoria)}</span></p>` : ''}
    ${pauta.formato ? `<p class="mt-0.5 text-[9.5px] xl:text-[10px] text-cohab-medium truncate flex items-center gap-1 leading-tight"><i class="fa-solid fa-clapperboard text-[8px] text-cohab-graphite/70 shrink-0"></i><span class="truncate">${escapeHTML(pauta.formato)}</span></p>` : ''}
    <div class="mt-1 xl:mt-1.5 pt-1 xl:pt-1.5 border-t ${isPastDay ? 'border-neutral-300' : 'border-cohab-border/70'} flex items-center justify-between gap-1 w-full min-w-0">
      ${statusControl}
      <div class="flex items-center gap-1 shrink-0">
        <span title="${typeInfo.label}" class="w-5 h-5 xl:w-6 xl:h-6 inline-flex items-center justify-center rounded-md border ${typeInfo.badgeClass}"><span class="w-1.5 h-1.5 xl:w-2 xl:h-2 rounded-full ${typeInfo.dotClass}"></span></span>
        <span title="${isPublished ? 'Conteúdo Publicado' : 'Prioridade #' + (pauta.prioridade || 1)}" class="h-5 xl:h-6 min-w-5 xl:min-w-6 px-1.5 inline-flex items-center justify-center rounded-md border border-cohab-border bg-white text-[9px] xl:text-[9.5px] font-extrabold leading-none whitespace-nowrap ${isPublished ? 'text-emerald-600' : 'text-cohab-graphite'}">${isPublished ? '<i class="fa-solid fa-check text-[8px]"></i>' : `#${pauta.prioridade || 1}`}</span>
        <span title="${escapeHTML(assigneeTitle)}" class="h-5 xl:h-6 min-w-5 xl:min-w-6 px-1.5 inline-flex items-center justify-center rounded-md border border-cohab-border bg-white text-[9px] xl:text-[9.5px] font-extrabold leading-none whitespace-nowrap text-cohab-graphite">${escapeHTML(primaryInitials)}${extra}</span>
      </div>
    </div>`;
  return card;
}

// =============================================================================
// PRIORIDADES
// =============================================================================
function orderedActive() {
  return state.pautas
    .filter(p => p.status !== 'Publicado')
    .sort((a, b) => (a.prioridade || 999) - (b.prioridade || 999) || a.data.localeCompare(b.data));
}

async function persistPriorities(orderedIds, motivo = null) {
  const current = orderedActive();
  const changed = motivo || orderedIds.some((id, i) => current.find(p => p.id === id)?.prioridade !== i + 1);
  if (!changed) return true;
  // aplica localmente para resposta imediata
  orderedIds.forEach((id, i) => { const p = state.pautas.find(x => x.id === id); if (p) p.prioridade = i + 1; });
  const res = await dbRun(sb.rpc('reordenar_prioridades', { p_ids: orderedIds, p_motivo: motivo }));
  return res.ok;
}

async function normalizeAndPersist(targetId = null, desired = null, motivo = null) {
  const active = orderedActive();
  if (targetId && desired !== null) {
    const idx = active.findIndex(p => p.id === targetId);
    if (idx !== -1) {
      const [moved] = active.splice(idx, 1);
      active.splice(Math.max(0, Math.min(active.length, desired - 1)), 0, moved);
    }
  }
  return persistPriorities(active.map(p => p.id), motivo);
}

function setHierarchyFilter(f) { state.hierarchyFilter = f; renderHierarchy(); }

function renderHierarchy() {
  const list = $('hierarchyList');
  if (!list) return;
  const allActive = orderedActive().filter(matchesSearchAndFilter);
  const counts = { ALL: allActive.length };
  ['A Fazer', 'Produzindo', 'Aprovado'].forEach(s => { counts[s] = allActive.filter(p => p.status === s).length; });
  $('hierarchyStatusFilter').innerHTML = ['ALL', 'A Fazer', 'Produzindo', 'Aprovado'].map(f => `
    <button type="button" onclick="setHierarchyFilter('${f}')" class="px-3 py-1.5 rounded-lg text-xs font-bold border transition ${state.hierarchyFilter === f ? 'bg-cohab-graphite text-white border-cohab-graphite' : 'bg-white text-cohab-graphite border-cohab-border hover:bg-cohab-bg'}">
      ${f !== 'ALL' ? `<span class="inline-block w-2 h-2 rounded-full ${STATUS_META[f].dotClass} mr-1"></span>` : ''}${f === 'ALL' ? 'Todas' : f} <span class="opacity-70">(${counts[f]})</span>
    </button>`).join('');

  const activePautas = state.hierarchyFilter === 'ALL' ? allActive : allActive.filter(p => p.status === state.hierarchyFilter);
  const editable = can.edit();
  const canReorder = editable && state.hierarchyFilter === 'ALL' && !($('searchInput').value || '').trim();
  list.innerHTML = '';

  if (activePautas.length === 0) {
    list.innerHTML = emptyState('fa-layer-group', 'Nenhuma demanda ativa encontrada.', editable ? 'Crie uma nova pauta para começar.' : '');
    return;
  }
  if (editable && !canReorder) {
    list.insertAdjacentHTML('beforeend', `<p class="text-[11px] text-cohab-medium"><i class="fa-solid fa-circle-info mr-1"></i>Limpe a busca e o filtro para reordenar com as setas.</p>`);
  }

  const tISO = todayISO();
  activePautas.forEach((pauta, idx) => {
    const statusInfo = STATUS_META[pauta.status] || STATUS_META['A Fazer'];
    const typeInfo = TYPE_META[pauta.tipo] || TYPE_META.FRIA;
    const assigneesLabel = formatAssigneesFull(pauta.responsavel);
    const overdue = pauta.data < tISO;
    const row = document.createElement('div');
    row.className = `rounded-2xl border border-cohab-border border-l-4 ${statusInfo.borderClass} bg-white p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shadow-2xs`;
    row.innerHTML = `
      <div class="flex items-start gap-3 min-w-0">
        <div class="flex flex-col items-center gap-0.5 shrink-0">
          ${canReorder ? `<button type="button" onclick="movePriority('${pauta.id}', -1)" ${idx === 0 ? 'disabled' : ''} title="Subir prioridade" class="w-6 h-5 rounded bg-cohab-bg hover:bg-cohab-border/70 disabled:opacity-30 text-cohab-graphite text-[10px] flex items-center justify-center"><i class="fa-solid fa-chevron-up"></i></button>` : ''}
          <span class="text-xs font-extrabold text-cohab-terracotta">#${pauta.prioridade || idx + 1}</span>
          ${canReorder ? `<button type="button" onclick="movePriority('${pauta.id}', 1)" ${idx === activePautas.length - 1 ? 'disabled' : ''} title="Descer prioridade" class="w-6 h-5 rounded bg-cohab-bg hover:bg-cohab-border/70 disabled:opacity-30 text-cohab-graphite text-[10px] flex items-center justify-center"><i class="fa-solid fa-chevron-down"></i></button>` : ''}
        </div>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="font-extrabold text-sm text-cohab-graphiteDark">${escapeHTML(pauta.titulo)}</h4>
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-md border ${overdue ? 'bg-red-50 text-red-700 border-red-200' : 'text-cohab-medium bg-cohab-bg border-cohab-border'}"><i class="fa-regular fa-calendar mr-1"></i>${formatDateBR(pauta.data)}${overdue ? ' • atrasada' : ''}</span>
            ${assigneesLabel ? `<span class="text-[11px] font-bold text-cohab-graphite bg-cohab-bg px-2 py-0.5 rounded-md border border-cohab-border inline-flex items-center gap-1"><i class="fa-solid fa-users text-[9px] text-cohab-terracotta"></i>${escapeHTML(assigneesLabel)}</span>` : ''}
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-3 text-xs text-cohab-medium">
            ${pauta.editoria ? `<span><i class="fa-solid fa-tag text-cohab-graphite/70 mr-1"></i>${escapeHTML(pauta.editoria)}</span>` : ''}
            ${pauta.formato ? `<span><i class="fa-solid fa-clapperboard text-cohab-graphite/70 mr-1"></i>${escapeHTML(pauta.formato)}</span>` : ''}
          </div>
          ${pauta.descricao ? `<p class="mt-1.5 text-xs text-cohab-medium leading-relaxed line-clamp-2">${escapeHTML(pauta.descricao)}</p>` : ''}
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-cohab-border">
        ${editable ? `
        <div class="relative flex items-center" data-dropdown-root>
          <button type="button" onclick="toggleCustomDropdown('prioStatusMenu-${pauta.id}', event)" class="h-8 inline-flex items-center gap-2 rounded-xl px-3 border ${statusInfo.badgeClass} text-xs font-bold whitespace-nowrap hover:border-cohab-graphite/40 transition">
            <span class="w-2.5 h-2.5 rounded-full ${statusInfo.dotClass}"></span><span>${escapeHTML(pauta.status)}</span><i class="fa-solid fa-chevron-down text-[9px] text-cohab-medium"></i>
          </button>
          <div id="prioStatusMenu-${pauta.id}" data-dropdown-menu class="hidden absolute right-0 top-full mt-1 w-36 bg-white border border-cohab-border rounded-xl shadow-lg py-1 z-30">
            ${Object.keys(STATUS_META).map(st => `<button type="button" onclick="quickChangeStatus('${pauta.id}', '${st}')" class="w-full px-3 py-1.5 text-left text-xs whitespace-nowrap ${pauta.status === st ? 'font-extrabold bg-cohab-bg' : 'font-semibold'} text-cohab-graphite hover:bg-cohab-bg flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full ${STATUS_META[st].dotClass}"></span>${st}</button>`).join('')}
          </div>
        </div>` : `<span class="h-8 inline-flex items-center gap-2 rounded-xl px-3 border ${statusInfo.badgeClass} text-xs font-bold"><span class="w-2.5 h-2.5 rounded-full ${statusInfo.dotClass}"></span>${escapeHTML(pauta.status)}</span>`}
        <span title="${typeInfo.label}" class="w-8 h-8 inline-flex items-center justify-center rounded-xl border ${typeInfo.badgeClass}"><span class="w-2.5 h-2.5 rounded-full ${typeInfo.dotClass}"></span></span>
        <button type="button" onclick="openPautaModal('${pauta.id}')" class="h-8 px-3 rounded-xl bg-cohab-bg hover:bg-cohab-border/70 text-cohab-graphite text-xs font-bold border border-cohab-border transition inline-flex items-center gap-1.5">
          <i class="fa-solid ${editable ? 'fa-pen' : 'fa-eye'}"></i> ${editable ? 'Editar' : 'Ver'}
        </button>
      </div>`;
    list.appendChild(row);
  });
}

async function movePriority(id, delta) {
  if (!can.edit()) return;
  const active = orderedActive();
  const index = active.findIndex(p => p.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= active.length) return;
  [active[index], active[target]] = [active[target], active[index]];
  const moved = active[target];
  const ok = await persistPriorities(active.map(p => p.id), `Ordem de prioridade atualizada para "${moved.titulo}" (#${target + 1}).`);
  renderAll();
  if (ok) scheduleReload();
}

async function sortByHotAndDate() {
  if (!can.edit()) return;
  const active = state.pautas.filter(p => p.status !== 'Publicado');
  active.sort((a, b) => (a.tipo !== b.tipo ? (a.tipo === 'QUENTE' ? -1 : 1) : a.data.localeCompare(b.data)));
  const ok = await persistPriorities(active.map(p => p.id), 'Demandas ativas reordenadas automaticamente por Pautas Quentes + Data.');
  if (ok) showToast('Prioridades reorganizadas por Quentes + Data!');
  renderAll();
  scheduleReload();
}

async function quickChangeStatus(pautaId, newStatus) {
  closeAllDropdowns();
  if (!can.edit()) return;
  const pauta = state.pautas.find(p => p.id === pautaId);
  if (!pauta || pauta.status === newStatus) return;
  const old = pauta.status;
  pauta.status = newStatus; // otimista
  renderAll();
  const res = await dbRun(sb.from('pautas').update({ status: newStatus }).eq('id', pautaId).select('id'));
  if (!res.ok || !res.data?.length) {
    pauta.status = old;
    if (res.ok) showToast('Você não tem permissão para alterar esta pauta.', 'error');
    renderAll();
    return;
  }
  if (newStatus === 'Publicado') showToast(`"${pauta.titulo}" publicada! Movida para Realizados.`);
  await normalizeAndPersist();
  scheduleReload();
}

// =============================================================================
// REALIZADOS
// =============================================================================
function emptyState(icon, title, subtitle = '') {
  return `<div class="p-10 text-center">
    <div class="w-12 h-12 rounded-2xl bg-cohab-bg border border-cohab-border flex items-center justify-center mx-auto mb-3 text-cohab-medium"><i class="fa-solid ${icon}"></i></div>
    <p class="text-sm font-bold text-cohab-graphite">${escapeHTML(title)}</p>
    ${subtitle ? `<p class="text-xs text-cohab-medium mt-1">${escapeHTML(subtitle)}</p>` : ''}
  </div>`;
}

function renderCompleted() {
  const list = $('completedList');
  list.innerHTML = '';
  const published = state.pautas.filter(p => p.status === 'Publicado' && matchesSearchAndFilter(p)).sort((a, b) => b.data.localeCompare(a.data));
  if (!published.length) { list.innerHTML = emptyState('fa-circle-check', 'Nenhum conteúdo publicado encontrado.'); return; }

  let lastMonth = '';
  published.forEach(pauta => {
    const mk = pauta.data.slice(0, 7);
    if (mk !== lastMonth) {
      lastMonth = mk;
      const [y, m] = mk.split('-');
      const count = published.filter(p => p.data.startsWith(mk)).length;
      list.insertAdjacentHTML('beforeend', `<div class="px-4 py-2 bg-cohab-bg text-[11px] font-extrabold uppercase tracking-wider text-cohab-graphite flex justify-between"><span>${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}</span><span class="text-cohab-medium">${count}</span></div>`);
    }
    const item = document.createElement('div');
    item.className = 'p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-cohab-bg/40 transition';
    item.innerHTML = `
      <div class="flex items-start sm:items-center gap-3 min-w-0">
        <span class="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-extrabold shrink-0">${formatDateBR(pauta.data)}</span>
        <div class="min-w-0">
          <h4 class="text-sm font-bold text-cohab-graphiteDark truncate">${escapeHTML(pauta.titulo)}</h4>
          <div class="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-cohab-medium">
            ${pauta.editoria ? `<span><i class="fa-solid fa-tag text-cohab-graphite/70 mr-1"></i>${escapeHTML(pauta.editoria)}</span>` : ''}
            ${pauta.formato ? `<span><i class="fa-solid fa-clapperboard text-cohab-graphite/70 mr-1"></i>${escapeHTML(pauta.formato)}</span>` : ''}
            ${pauta.responsavel.length ? `<span><i class="fa-solid fa-users text-cohab-graphite/70 mr-1"></i>${escapeHTML(pauta.responsavel.join(', '))}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-cohab-border bg-white text-xs font-bold"><span class="w-2 h-2 rounded-full bg-emerald-500"></span>Publicado</span>
        <button type="button" onclick="openPautaModal('${pauta.id}')" class="px-3 py-1 rounded-lg bg-cohab-bg hover:bg-cohab-border/70 text-cohab-graphite text-xs font-bold border border-cohab-border transition">${can.edit() ? 'Editar' : 'Ver'}</button>
      </div>`;
    list.appendChild(item);
  });
}

// =============================================================================
// SUGESTÕES
// =============================================================================
function renderSuggestions() {
  const container = $('suggestionsList');
  container.innerHTML = '';
  const q = stripAccents(($('searchInput').value || '').trim().toLowerCase());
  const items = state.suggestions.filter(s => !q || q.split(/\s+/).every(t => stripAccents(`${s.titulo} ${s.descricao || ''} ${s.editoria} ${s.formato || ''} ${s.autor_nome || ''}`.toLowerCase()).includes(t)));
  if (!items.length) {
    container.innerHTML = `<div class="col-span-full bg-cohab-bg/50 rounded-2xl border border-dashed border-cohab-border">${emptyState('fa-lightbulb', 'Nenhuma sugestão cadastrada.', can.edit() ? 'Use o formulário acima para registrar ideias.' : '')}</div>`;
    return;
  }
  const editable = can.edit();
  items.forEach(sug => {
    const typeInfo = TYPE_META[sug.tipo] || TYPE_META.FRIA;
    const card = document.createElement('div');
    card.className = 'rounded-2xl border border-cohab-border bg-white p-4 flex flex-col justify-between gap-3 shadow-2xs hover:shadow-sm transition';
    card.innerHTML = `
      <div>
        <div class="flex items-start justify-between gap-2">
          <h4 class="text-sm font-extrabold text-cohab-graphiteDark">${escapeHTML(sug.titulo)}</h4>
          <span title="${typeInfo.label}" class="w-6 h-6 inline-flex items-center justify-center rounded-md border ${typeInfo.badgeClass} shrink-0"><span class="w-2 h-2 rounded-full ${typeInfo.dotClass}"></span></span>
        </div>
        <div class="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-cohab-medium">
          ${sug.editoria ? `<span><i class="fa-solid fa-tag text-cohab-graphite/70 mr-1"></i>${escapeHTML(sug.editoria)}</span>` : ''}
          ${sug.formato ? `<span><i class="fa-solid fa-clapperboard text-cohab-graphite/70 mr-1"></i>${escapeHTML(sug.formato)}</span>` : ''}
        </div>
        ${sug.descricao ? `<p class="mt-2 text-xs text-cohab-medium leading-relaxed">${escapeHTML(sug.descricao)}</p>` : ''}
      </div>
      <div class="pt-2.5 border-t border-cohab-border flex items-center justify-between gap-2 text-[11px] text-cohab-medium">
        <span class="truncate">Por <strong class="text-cohab-graphite">${escapeHTML(sug.autor_nome || 'Equipe Ascom')}</strong> • ${formatDateBR(String(sug.created_at).slice(0, 10))}</span>
        ${editable ? `<div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="promoteSuggestionToPauta('${sug.id}')" class="px-2.5 py-1 rounded-lg bg-cohab-terracotta hover:bg-cohab-terracottaDark text-white font-bold transition"><i class="fa-regular fa-calendar-plus mr-1"></i>Agendar</button>
          <button type="button" onclick="deleteSuggestion('${sug.id}')" title="Excluir sugestão" class="w-7 h-7 rounded-lg bg-cohab-bg hover:bg-red-50 hover:text-red-600 text-cohab-medium flex items-center justify-center transition"><i class="fa-regular fa-trash-can"></i></button>
        </div>` : ''}
      </div>`;
    container.appendChild(card);
  });
}

async function addSuggestion(event) {
  event.preventDefault();
  if (!can.edit()) return;
  const titulo = $('sugTitulo').value.trim();
  if (!titulo) return;
  let editoria = $('sugEditoria').value;
  if (editoria === '__NEW__') {
    editoria = formatSentenceCase($('sugNovaEditoriaInput').value) || 'Serviços';
    await ensureEditoria(editoria);
  }
  const btn = event.submitter;
  setButtonLoading(btn, true, 'Salvando…');
  const res = await dbRun(sb.from('sugestoes').insert({
    titulo,
    tipo: $('sugTipo').value,
    formato: $('sugFormato').value || null,
    editoria: formatSentenceCase(editoria) || 'Serviços',
    descricao: $('sugDescricao').value.trim() || null
  }), 'Sugestão adicionada!');
  setButtonLoading(btn, false);
  if (!res.ok) return;
  $('sugTitulo').value = ''; $('sugFormato').value = ''; $('sugDescricao').value = '';
  $('sugEditoria').value = 'Serviços';
  $('sugNovaEditoriaWrapper').classList.add('hidden');
  await loadAll();
}

function promoteSuggestionToPauta(sugId) {
  const sug = state.suggestions.find(s => s.id === sugId);
  if (!sug) return;
  openPautaModal(null, null);
  $('modalTitle').textContent = 'Agendar Sugestão como Pauta';
  $('modalSubtitle').textContent = 'A sugestão sairá do banco de ideias ao salvar a pauta';
  $('fromSuggestionId').value = sug.id;
  $('pautaTitulo').value = sug.titulo;
  setFormatoSelectValue('pautaFormato', sug.formato || '');
  renderEditoriaOptions(sug.editoria || 'Serviços');
  $('pautaDescricao').value = sug.descricao || '';
  const radio = document.querySelector(`input[name="pautaTipo"][value="${sug.tipo}"]`);
  if (radio) radio.checked = true;
  setTimeout(() => $('pautaData').focus(), 80);
}

function deleteSuggestion(sugId) {
  const sug = state.suggestions.find(s => s.id === sugId);
  if (!sug) return;
  openConfirmModal('Excluir Sugestão', `Deseja remover a sugestão "${sug.titulo}"?`, async () => {
    const res = await dbRun(sb.from('sugestoes').delete().eq('id', sugId), 'Sugestão removida.');
    if (res.ok) await loadAll();
  }, 'Excluir');
}

// =============================================================================
// EDITORIAS / FORMATO
// =============================================================================
function renderEditoriaOptions(selectedVal = 'Serviços') {
  const normalized = formatSentenceCase(selectedVal) || 'Serviços';
  const list = [...state.editorias];
  if (normalized !== '__new__' && !list.some(e => e.toLowerCase() === normalized.toLowerCase())) list.push(normalized);
  ['pautaEditoria', 'sugEditoria'].forEach(selectId => {
    const el = $(selectId);
    if (!el) return;
    const keep = selectId === 'pautaEditoria' ? normalized : (el.value && el.value !== '__NEW__' ? el.value : 'Serviços');
    el.innerHTML = list.map(ed => `<option value="${escapeHTML(ed)}">${escapeHTML(ed)}</option>`).join('') +
      (can.edit() ? `<option value="__NEW__">+ Nova editoria...</option>` : '');
    const match = list.find(e => e.toLowerCase() === String(keep).toLowerCase());
    el.value = match || 'Serviços';
  });
}

function handleEditoriaSelectChange(selectId, wrapperId, inputId) {
  const isNew = $(selectId).value === '__NEW__';
  $(wrapperId).classList.toggle('hidden', !isNew);
  if (isNew) { $(inputId).value = ''; $(inputId).focus(); }
}

async function ensureEditoria(nome) {
  if (state.editorias.some(e => e.toLowerCase() === nome.toLowerCase())) return;
  state.editorias.push(nome);
  const { error } = await sb.from('editorias').insert({ nome });
  if (error && error.code !== '23505') showToast(translateError(error), 'error');
}

async function confirmNewEditoria(selectId, wrapperId, inputId) {
  const formatted = formatSentenceCase($(inputId).value);
  if (!formatted) { showToast('Digite o nome da nova editoria.', 'error'); return; }
  await ensureEditoria(formatted);
  const other = selectId === 'pautaEditoria' ? 'sugEditoria' : 'pautaEditoria';
  const otherVal = $(other).value;
  renderEditoriaOptions(selectId === 'pautaEditoria' ? formatted : $('pautaEditoria').value);
  $(selectId).value = formatted;
  if (otherVal && otherVal !== '__NEW__') $(other).value = otherVal;
  $(wrapperId).classList.add('hidden');
  showToast(`Editoria "${formatted}" adicionada!`);
}

function setFormatoSelectValue(selectId, value) {
  const sel = $(selectId);
  if (value && ![...sel.options].some(o => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = value;
    sel.appendChild(opt);
  }
  sel.value = value || '';
}

// =============================================================================
// LOG
// =============================================================================
const LOG_ICONS = {
  'CRIAÇÃO': 'fa-plus', 'EDIÇÃO': 'fa-pen', 'EXCLUSÃO': 'fa-trash-can', 'STATUS': 'fa-arrows-rotate',
  'HIERARQUIA': 'fa-layer-group', 'SUGESTÃO': 'fa-lightbulb', 'NOTA': 'fa-pen-clip', 'USUÁRIO': 'fa-user-shield', 'ACESSO': 'fa-right-to-bracket'
};

function renderLogs() {
  const container = $('logsContainer');
  const filter = $('logFilterAction').value;
  container.innerHTML = '';
  const filtered = filter === 'ALL' ? state.logs : state.logs.filter(l => l.acao === filter);
  if (!filtered.length) { container.innerHTML = emptyState('fa-clock-rotate-left', 'Nenhum registro para este filtro.'); return; }

  let lastDay = '';
  filtered.forEach(item => {
    const day = new Date(item.created_at).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    if (day !== lastDay) {
      lastDay = day;
      container.insertAdjacentHTML('beforeend', `<p class="pt-2 text-[10.5px] font-extrabold uppercase tracking-wider text-cohab-medium">${escapeHTML(day)}</p>`);
    }
    const row = document.createElement('div');
    row.className = 'p-3 rounded-xl border border-cohab-border bg-cohab-bg/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs';
    row.innerHTML = `
      <div class="flex items-start sm:items-center gap-2.5 min-w-0">
        <span class="px-2 py-0.5 rounded-md bg-white border border-cohab-border font-extrabold text-[10px] text-cohab-terracotta shrink-0 inline-flex items-center gap-1"><i class="fa-solid ${LOG_ICONS[item.acao] || 'fa-circle'} text-[9px]"></i>${escapeHTML(item.acao)}</span>
        <span class="text-cohab-graphite font-medium break-words">${escapeHTML(item.detalhe)}</span>
      </div>
      <div class="text-[11px] text-cohab-medium shrink-0"><strong class="text-cohab-graphite">${escapeHTML(item.user_nome || 'Sistema')}</strong> &bull; ${new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>`;
    container.appendChild(row);
  });
}

async function addManualLogNote(event) {
  event.preventDefault();
  const input = $('manualLogInput');
  const text = input.value.trim();
  if (!text) return;
  const res = await dbRun(sb.from('logs').insert({ acao: 'NOTA', detalhe: text }), 'Nota registrada no log.');
  if (res.ok) { input.value = ''; await loadAll(); }
}

// =============================================================================
// MODAL DE PAUTA
// =============================================================================
function selectModalStatus(statusVal) {
  $('pautaStatus').value = statusVal;
  document.querySelectorAll('.modal-status-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.statusVal === statusVal));
  $('modalActiveMetaRow').querySelector('.col-span-2').classList.toggle('hidden', statusVal === 'Publicado');
}

function renderAssigneeOptions() {
  const sel = $('pautaResponsavel');
  const people = state.profiles.filter(p => p.ativo && p.nome).map(p => p.nome);
  sel.innerHTML = people.map(n => `<option value="${escapeHTML(n)}">${escapeHTML(n)} (${escapeHTML(getPersonInitials(n))})</option>`).join('') +
    `<option value="CUSTOM">Outra pessoa...</option>`;
  sel.value = people.includes(state.profile?.nome) ? state.profile.nome : (people[0] || 'CUSTOM');
  handlePautaResponsavelChange(false);
}

function renderModalAssigneesList() {
  const container = $('pautaResponsaveisList');
  const ro = $('pautaFieldset').disabled;
  if (!modalAssignees.length) { container.innerHTML = `<span class="text-[11px] text-cohab-medium italic">Nenhuma pessoa designada ainda.</span>`; return; }
  container.innerHTML = modalAssignees.map((person, i) => `
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-cohab-border bg-cohab-bg text-xs font-bold text-cohab-graphite">
      <span class="px-1.5 py-0.5 rounded bg-white border border-cohab-border text-[10px] font-extrabold text-cohab-terracotta">${escapeHTML(getPersonInitials(person))}</span>
      <span>${escapeHTML(person)}</span>
      ${ro ? '' : `<button type="button" onclick="removeModalAssignee(${i})" title="Remover" class="text-cohab-medium hover:text-red-600 ml-0.5"><i class="fa-solid fa-xmark text-[10px]"></i></button>`}
    </span>`).join('');
}

function addSelectedResponsavel() {
  const sel = $('pautaResponsavel');
  const custom = $('pautaResponsavelCustom');
  const name = (sel.value === 'CUSTOM' ? custom.value : sel.value).trim().slice(0, 120);
  if (!name) { showToast('Digite ou selecione o nome do responsável.', 'error'); if (sel.value === 'CUSTOM') custom.focus(); return; }
  if (modalAssignees.some(p => p.toLowerCase() === name.toLowerCase())) { showToast(`${name} já está designado(a).`, 'error'); return; }
  if (modalAssignees.length >= 20) { showToast('Máximo de 20 responsáveis.', 'error'); return; }
  modalAssignees.push(name);
  if (sel.value === 'CUSTOM') custom.value = '';
  renderModalAssigneesList();
}

function removeModalAssignee(index) { modalAssignees.splice(index, 1); renderModalAssigneesList(); }

function handlePautaResponsavelChange(focus = true) {
  const isCustom = $('pautaResponsavel').value === 'CUSTOM';
  $('pautaResponsavelCustom').classList.toggle('hidden', !isCustom);
  if (isCustom && focus) $('pautaResponsavelCustom').focus();
}

function openPautaModal(pautaId = null, prefillDate = null) {
  if (!pautaId && !can.edit()) return;
  closeAllDropdowns();
  const editable = can.edit();
  $('fromSuggestionId').value = '';
  $('pautaNovaEditoriaWrapper').classList.add('hidden');
  $('modalSubtitle').textContent = 'Preencha os blocos abaixo para organizar a demanda no calendário';
  renderAssigneeOptions();
  const meta = $('pautaMetaInfo');
  meta.classList.add('hidden');

  if (pautaId) {
    const pauta = state.pautas.find(p => p.id === pautaId);
    if (!pauta) return;
    $('modalTitle').textContent = editable ? 'Editar Pauta' : 'Detalhes da Pauta';
    $('pautaId').value = pauta.id;
    $('pautaTitulo').value = pauta.titulo;
    $('pautaData').value = pauta.data;
    $('pautaPrioridade').value = pauta.prioridade || 1;
    selectModalStatus(pauta.status);
    modalAssignees = [...pauta.responsavel];
    setFormatoSelectValue('pautaFormato', pauta.formato || '');
    renderEditoriaOptions(pauta.editoria || 'Serviços');
    $('pautaDescricao').value = pauta.descricao || '';
    const radio = document.querySelector(`input[name="pautaTipo"][value="${pauta.tipo || 'FRIA'}"]`);
    if (radio) radio.checked = true;

    const by = (id) => state.profiles.find(p => p.id === id)?.nome;
    const parts = [];
    if (pauta.created_at) parts.push(`Criada por ${by(pauta.created_by) || '—'} em ${formatDateTimeBR(pauta.created_at)}`);
    if (pauta.updated_at && pauta.updated_at !== pauta.created_at) parts.push(`Última edição: ${by(pauta.updated_by) || '—'} em ${formatDateTimeBR(pauta.updated_at)}`);
    if (parts.length) { meta.textContent = parts.join(' • '); meta.classList.remove('hidden'); }

    const delBtn = $('deletePautaBtn');
    delBtn.classList.toggle('hidden', !can.admin());
    delBtn.classList.toggle('inline-flex', can.admin());
  } else {
    $('modalTitle').textContent = 'Nova Pauta';
    $('pautaId').value = '';
    $('pautaTitulo').value = '';
    $('pautaData').value = prefillDate || (currentYear === new Date().getFullYear() && currentMonth === new Date().getMonth()
      ? todayISO() : `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`);
    $('pautaPrioridade').value = state.pautas.filter(p => p.status !== 'Publicado').length + 1;
    selectModalStatus('A Fazer');
    modalAssignees = state.profile?.nome ? [state.profile.nome] : [];
    setFormatoSelectValue('pautaFormato', '');
    renderEditoriaOptions('Serviços');
    $('pautaDescricao').value = '';
    const radio = document.querySelector('input[name="pautaTipo"][value="FRIA"]');
    if (radio) radio.checked = true;
    $('deletePautaBtn').classList.add('hidden');
    $('deletePautaBtn').classList.remove('inline-flex');
  }

  $('pautaFieldset').disabled = !editable;
  if (!editable) $('modalSubtitle').textContent = 'Visualização somente leitura';
  $('pautaResponsavel').closest('.flex').classList.toggle('hidden', !editable);
  $('pautaSaveBtn').classList.toggle('hidden', !editable);
  $('pautaCancelBtn').textContent = editable ? 'Cancelar' : 'Fechar';
  renderModalAssigneesList();
  openModal('pautaModal');
  if (editable) setTimeout(() => $('pautaTitulo').focus(), 60);
}

function closePautaModal() { closeModal('pautaModal'); }

async function savePauta(event) {
  event.preventDefault();
  if (!can.edit()) return;

  const id = $('pautaId').value;
  const fromSugId = $('fromSuggestionId').value;
  const titulo = $('pautaTitulo').value.trim();
  const data = $('pautaData').value;
  if (!titulo || !data) { showToast('Preencha título e data.', 'error'); return; }

  const tipo = document.querySelector('input[name="pautaTipo"]:checked')?.value || 'FRIA';
  const prioridade = Math.max(1, Math.min(999, parseInt($('pautaPrioridade').value, 10) || 1));
  const status = $('pautaStatus').value;

  const customPending = $('pautaResponsavel').value === 'CUSTOM' ? $('pautaResponsavelCustom').value.trim() : '';
  if (customPending && !modalAssignees.some(p => p.toLowerCase() === customPending.toLowerCase())) modalAssignees.push(customPending);

  let editoria = $('pautaEditoria').value;
  if (editoria === '__NEW__') {
    const typed = formatSentenceCase($('pautaNovaEditoriaInput').value);
    editoria = typed || 'Serviços';
    if (typed) await ensureEditoria(typed);
  } else {
    editoria = formatSentenceCase(editoria) || 'Serviços';
  }

  const payload = {
    titulo, data, tipo, prioridade, status,
    responsaveis: [...modalAssignees].slice(0, 20),
    formato: $('pautaFormato').value || null,
    editoria,
    descricao: $('pautaDescricao').value.trim() || null
  };

  const btn = $('pautaSaveBtn');
  setButtonLoading(btn, true, 'Salvando…');
  let targetId = id;
  let res;
  if (id) {
    res = await dbRun(sb.from('pautas').update(payload).eq('id', id).select().single(), 'Pauta atualizada!');
  } else {
    res = await dbRun(sb.from('pautas').insert(payload).select().single(), 'Nova pauta criada!');
    if (res.ok) targetId = res.data.id;
  }
  setButtonLoading(btn, false);
  if (!res.ok) return;

  // atualiza estado local imediatamente
  const mapped = mapPauta(res.data);
  const idx = state.pautas.findIndex(p => p.id === mapped.id);
  if (idx >= 0) state.pautas[idx] = mapped; else state.pautas.push(mapped);

  if (fromSugId) await sb.from('sugestoes').delete().eq('id', fromSugId);

  await normalizeAndPersist(status !== 'Publicado' ? targetId : null, prioridade);
  closePautaModal();

  const [py, pm] = data.split('-').map(Number);
  if (py && pm) { currentYear = py; currentMonth = pm - 1; }
  await loadAll();
}

function deleteCurrentPauta() {
  const id = $('pautaId').value;
  const pauta = state.pautas.find(p => p.id === id);
  if (!pauta || !can.admin()) return;
  openConfirmModal('Excluir Pauta', `Deseja realmente excluir a pauta "${pauta.titulo}"? Esta ação não pode ser desfeita (o registro fica no log).`, async () => {
    const res = await dbRun(sb.from('pautas').delete().eq('id', id).select('id'));
    if (!res.ok) return;
    if (!res.data?.length) { showToast('Exclusão não permitida. Requer administrador com 2FA.', 'error'); return; }
    showToast('Pauta excluída.');
    state.pautas = state.pautas.filter(p => p.id !== id);
    pautas = state.pautas;
    closePautaModal();
    await normalizeAndPersist();
    await loadAll();
  }, 'Excluir');
}

// =============================================================================
// MINHA CONTA / MFA
// =============================================================================
async function openAccountModal() {
  closeAllDropdowns();
  $('myNameInput').value = state.profile?.nome || '';
  $('myEmailLabel').textContent = state.profile?.email || state.user?.email || '';
  $('myRoleLabel').textContent = ROLE_LABELS[state.profile?.role] || '';
  $('myNewPassword').value = ''; $('myNewPasswordConfirm').value = '';
  renderPasswordRules('myNewPassword', 'myPwRules');
  $('mfaEnrollBox').classList.add('hidden');
  await refreshFactors();
  renderMfaStatus();
  openModal('accountModal');
}

function renderMfaStatus() {
  const verified = state.factors.filter(f => f.status === 'verified');
  const pill = $('mfaStatusPill');
  if (verified.length) {
    pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-md border bg-emerald-50 text-emerald-700 border-emerald-200';
    pill.textContent = 'Ativa';
  } else {
    pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-md border bg-amber-50 text-amber-700 border-amber-200';
    pill.textContent = 'Desativada';
  }
  $('mfaEnrollBtn').classList.toggle('hidden', verified.length > 0);
  $('mfaFactorsList').innerHTML = verified.map(f => `
    <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white border border-cohab-border text-xs">
      <span class="font-semibold"><i class="fa-solid fa-mobile-screen-button text-cohab-terracotta mr-1.5"></i>${escapeHTML(f.friendly_name || 'App autenticador')} <span class="text-cohab-medium font-normal">• desde ${formatDateBR(String(f.created_at).slice(0, 10))}</span></span>
      <button type="button" onclick="unenrollFactor('${escapeHTML(f.id)}')" class="text-[11px] font-bold text-cohab-terracotta hover:underline">Remover</button>
    </div>`).join('');
}

async function startMfaEnroll() {
  // Remove fatores não verificados antigos (tentativas abandonadas)
  for (const f of state.factors.filter(x => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Cohab Ascom ${new Date().toLocaleDateString('pt-BR')}` });
  if (error) { showToast(translateError(error), 'error'); return; }
  mfaEnrollFactorId = data.id;
  $('mfaQr').src = data.totp.qr_code;
  $('mfaSecret').textContent = data.totp.secret;
  $('mfaEnrollCode').value = '';
  $('mfaEnrollBox').classList.remove('hidden');
  $('mfaEnrollCode').focus();
}

async function verifyMfaEnroll() {
  const code = $('mfaEnrollCode').value.replace(/\D/g, '');
  if (code.length !== 6 || !mfaEnrollFactorId) { showToast('Digite os 6 dígitos.', 'error'); return; }
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: mfaEnrollFactorId, code });
  if (error) { showToast('Código inválido. Confira o horário do celular e tente novamente.', 'error'); return; }
  mfaEnrollFactorId = null;
  $('mfaEnrollBox').classList.add('hidden');
  await refreshFactors();
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  state.aal = aal?.currentLevel || state.aal;
  renderMfaStatus();
  applyRoleUI();
  renderAll();
  showToast('Verificação em duas etapas ativada!');
}

function unenrollFactor(factorId) {
  const warn = can.adminRole() && CFG.ADMIN_REQUIRES_MFA ? ' Como administrador, você perderá os poderes de admin até reativar.' : '';
  openConfirmModal('Remover 2FA', `Sua conta ficará protegida apenas pela senha.${warn}`, async () => {
    const { error } = await sb.auth.mfa.unenroll({ factorId });
    if (error) { showToast(translateError(error), 'error'); return; }
    await sb.auth.refreshSession();
    await refreshFactors();
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    state.aal = aal?.currentLevel || 'aal1';
    renderMfaStatus(); applyRoleUI(); renderAll();
    showToast('2FA removida.');
  }, 'Remover');
}

async function saveMyName(event) {
  event.preventDefault();
  const nome = $('myNameInput').value.trim().slice(0, 120);
  if (!nome) return;
  const res = await dbRun(sb.from('profiles').update({ nome }).eq('id', state.user.id).select().single(), 'Nome atualizado!');
  if (res.ok) { state.profile = { ...state.profile, ...res.data }; updateUserChip(); await loadAll(); }
}

async function changeMyPassword(event) {
  event.preventDefault();
  const p1 = $('myNewPassword').value, p2 = $('myNewPasswordConfirm').value;
  if (!isStrongPassword(p1)) { showToast('A senha não atende aos requisitos.', 'error'); return; }
  if (p1 !== p2) { showToast('As senhas não conferem.', 'error'); return; }
  const btn = event.submitter;
  setButtonLoading(btn, true, 'Salvando…');
  const { error } = await sb.auth.updateUser({ password: p1 });
  setButtonLoading(btn, false);
  if (error) {
    const msg = /reauthentication|recent/i.test(error.message) ? 'Por segurança, saia e entre novamente antes de trocar a senha.'
      : /same|different/i.test(error.message) ? 'A nova senha deve ser diferente da atual.' : translateError(error);
    showToast(msg, 'error');
    return;
  }
  $('myNewPassword').value = ''; $('myNewPasswordConfirm').value = '';
  renderPasswordRules('myNewPassword', 'myPwRules');
  showToast('Senha alterada com sucesso!');
}

// =============================================================================
// GESTÃO DE USUÁRIOS (ADMIN)
// =============================================================================
async function adminFn(action, payload = {}) {
  if (!can.admin()) { showToast('Ative a verificação em duas etapas para administrar usuários.', 'error'); return null; }
  try {
    const { data, error } = await sb.functions.invoke(CFG.ADMIN_FUNCTION || 'admin-users', {
      body: { action, ...payload, redirectTo: appUrl() }
    });
    if (error) {
      let msg = error.message;
      try { const ctx = await error.context?.json(); if (ctx?.error) msg = ctx.error; } catch (_) { /* noop */ }
      if (/Failed to send|fetch/i.test(msg)) msg = 'Função "admin-users" indisponível. Verifique se ela foi publicada (veja o README).';
      showToast(msg, 'error');
      return null;
    }
    return data;
  } catch (e) {
    showToast(translateError(e), 'error');
    return null;
  }
}

function renderUsers() {
  const body = $('usersTableBody');
  if (!body || !can.adminRole()) return;
  $('createUserForm').classList.toggle('opacity-60', !can.admin());
  [...$('createUserForm').elements].forEach(el => { el.disabled = !can.admin(); });

  const q = stripAccents(($('searchInput').value || '').trim().toLowerCase());
  const list = state.profiles.filter(p => !q || stripAccents(`${p.nome} ${p.email} ${ROLE_LABELS[p.role]}`.toLowerCase()).includes(q));
  if (!list.length) { body.innerHTML = `<tr><td colspan="4">${emptyState('fa-users', 'Nenhum usuário encontrado.')}</td></tr>`; return; }

  const admin = can.admin();
  body.innerHTML = list.map(p => {
    const isMe = p.id === state.user?.id;
    const dis = !admin || isMe ? 'disabled' : '';
    return `
      <tr class="${p.ativo ? '' : 'bg-neutral-50 text-cohab-medium'}">
        <td class="px-4 py-3">
          <div class="flex items-center gap-2.5">
            <span class="w-8 h-8 rounded-lg ${p.ativo ? 'bg-cohab-terracottaLight text-cohab-terracotta' : 'bg-neutral-200 text-neutral-500'} text-[11px] font-extrabold flex items-center justify-center shrink-0">${escapeHTML(getPersonInitials(p.nome || p.email))}</span>
            <div class="min-w-0"><p class="font-bold text-cohab-graphiteDark truncate">${escapeHTML(p.nome || '—')} ${isMe ? '<span class="text-[10px] font-bold text-cohab-terracotta">(você)</span>' : ''}</p><p class="text-[11px] text-cohab-medium truncate">${escapeHTML(p.email)}</p></div>
          </div>
        </td>
        <td class="px-3 py-3">
          <select ${dis} onchange="setUserRole('${p.id}', this.value, this)" class="rounded-lg border border-cohab-border bg-white px-2 py-1 text-xs font-bold disabled:opacity-60 disabled:cursor-not-allowed">
            ${['admin', 'editor', 'leitor'].map(r => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
          </select>
        </td>
        <td class="px-3 py-3">
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-bold ${p.ativo ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-neutral-100 text-neutral-600 border-neutral-300'}">
            <span class="w-1.5 h-1.5 rounded-full ${p.ativo ? 'bg-emerald-500' : 'bg-neutral-400'}"></span>${p.ativo ? 'Ativo' : 'Desativado'}
          </span>
        </td>
        <td class="px-4 py-3">
          <div class="flex items-center justify-end gap-1">
            ${isMe ? '<span class="text-[11px] text-cohab-medium">Use "Minha conta"</span>' : `
            <button ${dis} type="button" onclick="resetUserPassword('${p.id}')" title="Enviar link de redefinição de senha" class="icon-btn"><i class="fa-solid fa-key"></i></button>
            <button ${dis} type="button" onclick="resetUserMfa('${p.id}')" title="Redefinir 2FA (celular perdido)" class="icon-btn"><i class="fa-solid fa-mobile-screen"></i></button>
            <button ${dis} type="button" onclick="toggleUserActive('${p.id}', ${!p.ativo})" title="${p.ativo ? 'Desativar acesso' : 'Reativar acesso'}" class="icon-btn"><i class="fa-solid ${p.ativo ? 'fa-user-lock' : 'fa-user-check'}"></i></button>
            <button ${dis} type="button" onclick="deleteUser('${p.id}')" title="Excluir usuário" class="icon-btn hover:!text-red-600 hover:!bg-red-50"><i class="fa-regular fa-trash-can"></i></button>`}
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function createUser(event) {
  event.preventDefault();
  const nome = $('newUserNome').value.trim();
  const email = $('newUserEmail').value.trim().toLowerCase();
  const role = $('newUserRole').value;
  const mode = $('newUserMode').value;
  const password = mode === 'password' ? $('newUserPassword').value : '';
  if (mode === 'password' && !isStrongPassword(password)) { showToast('A senha temporária não atende aos requisitos.', 'error'); return; }
  const btn = event.submitter;
  setButtonLoading(btn, true, 'Criando…');
  const res = await adminFn('create', { nome, email, role, password: password || undefined });
  setButtonLoading(btn, false);
  if (!res) return;
  showToast(mode === 'invite' ? `Convite enviado para ${email}.` : `Usuário ${nome} criado. Envie a senha temporária por um canal seguro.`);
  $('createUserForm').reset();
  $('newUserPasswordWrap').classList.add('hidden');
  await loadAll();
}

async function setUserRole(userId, role, selectEl) {
  const p = state.profiles.find(x => x.id === userId);
  if (!p) return;
  const res = await dbRun(sb.from('profiles').update({ role }).eq('id', userId).select('id'));
  if (!res.ok || !res.data?.length) { if (res.ok) showToast('Alteração não permitida.', 'error'); selectEl.value = p.role; return; }
  showToast(`${p.nome} agora é ${ROLE_LABELS[role]}.`);
  await loadAll();
}

function toggleUserActive(userId, ativo) {
  const p = state.profiles.find(x => x.id === userId);
  if (!p) return;
  const run = async () => { if (await adminFn('set_active', { user_id: userId, ativo })) { showToast(`Acesso de ${p.nome} ${ativo ? 'reativado' : 'desativado'}.`); await loadAll(); } };
  if (ativo) run();
  else openConfirmModal('Desativar acesso', `${p.nome} será desconectado(a) e não poderá entrar até ser reativado(a). O histórico é mantido.`, run, 'Desativar');
}

function resetUserPassword(userId) {
  const p = state.profiles.find(x => x.id === userId);
  if (!p) return;
  openConfirmModal('Redefinir senha', `Enviar um link de redefinição de senha para ${p.email}?`, async () => {
    if (await adminFn('reset_password', { user_id: userId })) showToast('Link de redefinição enviado.');
  }, 'Enviar link');
}

function resetUserMfa(userId) {
  const p = state.profiles.find(x => x.id === userId);
  if (!p) return;
  openConfirmModal('Redefinir 2FA', `Remover a verificação em duas etapas de ${p.nome}? Use apenas se a pessoa perdeu o celular — confirme a identidade dela antes.`, async () => {
    if (await adminFn('reset_mfa', { user_id: userId })) { showToast('2FA redefinida.'); await loadAll(); }
  }, 'Redefinir');
}

function deleteUser(userId) {
  const p = state.profiles.find(x => x.id === userId);
  if (!p) return;
  openConfirmModal('Excluir usuário', `Excluir permanentemente ${p.nome} (${p.email})? Prefira "Desativar" se quiser manter a possibilidade de retorno.`, async () => {
    if (await adminFn('delete', { user_id: userId })) { showToast('Usuário excluído.'); await loadAll(); }
  }, 'Excluir');
}

// =============================================================================
// IMPORTAÇÃO DOS DADOS LOCAIS DA VERSÃO ANTIGA
// =============================================================================
function readLegacy(key) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; } }

function checkLocalImport() {
  const banner = $('importBanner');
  if (!can.edit() || localStorage.getItem('cohab-ascom-import-dismissed') === '1') { banner.classList.add('hidden'); return; }
  const lp = readLegacy(LEGACY_KEYS.pautas), ls = readLegacy(LEGACY_KEYS.suggestions);
  if (!lp.length && !ls.length) { banner.classList.add('hidden'); return; }
  $('importBannerText').innerHTML = `<i class="fa-solid fa-box-archive mr-1.5"></i>Encontramos <strong>${lp.length} pauta(s)</strong> e <strong>${ls.length} sugestão(ões)</strong> da versão anterior salvas neste navegador.`;
  banner.classList.remove('hidden'); banner.classList.add('flex');
}

function dismissLocalImport() {
  localStorage.setItem('cohab-ascom-import-dismissed', '1');
  $('importBanner').classList.add('hidden'); $('importBanner').classList.remove('flex');
}

async function importLocalData() {
  const lp = readLegacy(LEGACY_KEYS.pautas), ls = readLegacy(LEGACY_KEYS.suggestions);
  const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const rowsP = lp.filter(p => p && p.titulo && validDate(p.data)).map(p => ({
    titulo: String(p.titulo).slice(0, 200),
    data: p.data,
    tipo: p.tipo === 'QUENTE' ? 'QUENTE' : 'FRIA',
    prioridade: Math.max(1, Math.min(999, parseInt(p.prioridade, 10) || 1)),
    status: normalizeLegacyStatus(p.status),
    responsaveis: normalizeAssignees(p.responsavel).slice(0, 20).map(n => n.slice(0, 120)),
    formato: p.formato ? String(p.formato).slice(0, 60) : null,
    editoria: (formatSentenceCase(p.editoria) || 'Serviços').slice(0, 60),
    descricao: p.descricao ? String(p.descricao).slice(0, 5000) : null
  }));
  const rowsS = ls.filter(s => s && s.titulo).map(s => ({
    titulo: String(s.titulo).slice(0, 200),
    tipo: s.tipo === 'QUENTE' ? 'QUENTE' : 'FRIA',
    formato: s.formato ? String(s.formato).slice(0, 60) : null,
    editoria: (formatSentenceCase(s.editoria) || 'Serviços').slice(0, 60),
    descricao: s.descricao ? String(s.descricao).slice(0, 2000) : null
  }));
  const eds = [...new Set([...rowsP, ...rowsS].map(r => r.editoria))];
  for (const e of eds) await ensureEditoria(e);

  if (rowsP.length) { const r = await dbRun(sb.from('pautas').insert(rowsP)); if (!r.ok) return; }
  if (rowsS.length) { const r = await dbRun(sb.from('sugestoes').insert(rowsS)); if (!r.ok) return; }
  Object.values(LEGACY_KEYS).forEach(k => localStorage.removeItem(k));
  dismissLocalImport();
  showToast(`${rowsP.length} pauta(s) e ${rowsS.length} sugestão(ões) importadas!`);
  await loadAll();
  await normalizeAndPersist();
}

// =============================================================================
// RENDER GERAL
// =============================================================================
function updateBadges() {
  const activeCount = state.pautas.filter(p => p.status !== 'Publicado').length;
  const completedCount = state.pautas.length - activeCount;
  $('badgeCountSuggestions').textContent = state.suggestions.length;
  $('badgeCountPautas').textContent = activeCount;
  $('badgeCountCompleted').textContent = completedCount;
  $('badgeCountLogs').textContent = state.logs.length >= 500 ? '500+' : state.logs.length;
  $('badgeCountUsers').textContent = state.profiles.length;
  $('completedSummaryPill').textContent = `${completedCount} ${completedCount === 1 ? 'conteúdo realizado' : 'conteúdos realizados'}`;
}

function renderAll() {
  if (!state.user) return;
  updateBadges();
  // Renderiza somente a aba visível (desempenho) + calendário sempre atualizado
  if (currentTab === 'calendar') renderCalendar();
  if (currentTab === 'hierarchy') renderHierarchy();
  if (currentTab === 'completed') renderCompleted();
  if (currentTab === 'suggestions') renderSuggestions();
  if (currentTab === 'logs') renderLogs();
  if (currentTab === 'users') renderUsers();
  renderCrossMonthBanner();
}

// =============================================================================
// EXPORTAÇÕES (Excel, PNG e Relatório)
// =============================================================================
function getPresetDates(mode) {
  if (mode === 'WEEK') {
    const now = new Date();
    const sun = new Date(now); sun.setDate(now.getDate() - now.getDay());
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    return { start: toISODate(sun), end: toISODate(sat) };
  }
  const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
  const mm = String(currentMonth + 1).padStart(2, '0');
  return { start: `${currentYear}-${mm}-01`, end: `${currentYear}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

function setRangePreset(prefix, mode) {
  const { start, end } = getPresetDates(mode);
  $(`${prefix}StartDate`).value = start;
  $(`${prefix}EndDate`).value = end;
  if (prefix === 'report') generateEditorialReport();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openExcelExportModal() { setRangePreset('excel', 'MONTH'); openModal('excelExportModal'); }
function openPngExportModal() { setRangePreset('png', 'MONTH'); openModal('pngExportModal'); }

function validRange(startStr, endStr) {
  if (!startStr || !endStr || startStr > endStr) { showToast('Selecione um intervalo de datas válido.', 'error'); return false; }
  return true;
}

function exportToExcel(event) {
  event.preventDefault();
  const startStr = $('excelStartDate').value, endStr = $('excelEndDate').value;
  if (!validRange(startStr, endStr)) return;
  const items = state.pautas.filter(p => p.data >= startStr && p.data <= endStr)
    .sort((a, b) => a.data.localeCompare(b.data) || (a.prioridade || 99) - (b.prioridade || 99));
  // Neutraliza injeção de fórmulas (CSV/Excel injection)
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return escapeHTML(s); };
  const rowsHTML = !items.length
    ? `<tr><td colspan="9" style="padding:12px;text-align:center;color:#666;">Nenhuma pauta no período selecionado.</td></tr>`
    : items.map((p, i) => `
      <tr style="background:${i % 2 === 0 ? '#FFFFFF' : '#F8F8F8'};">
        <td style="padding:8px;border:1px solid #DDD;">${formatDateBR(p.data)}</td>
        <td style="padding:8px;border:1px solid #DDD;font-weight:bold;">${cell(p.titulo)}</td>
        <td style="padding:8px;border:1px solid #DDD;">${cell(p.editoria || '-')}</td>
        <td style="padding:8px;border:1px solid #DDD;">${cell(p.formato || '-')}</td>
        <td style="padding:8px;border:1px solid #DDD;">${p.tipo === 'QUENTE' ? 'Pauta Quente' : 'Pauta Fria'}</td>
        <td style="padding:8px;border:1px solid #DDD;">${p.status === 'Publicado' ? '-' : '#' + (p.prioridade || 1)}</td>
        <td style="padding:8px;border:1px solid #DDD;">${cell(p.status)}</td>
        <td style="padding:8px;border:1px solid #DDD;">${cell(formatAssigneesFull(p.responsavel) || '-')}</td>
        <td style="padding:8px;border:1px solid #DDD;">${cell(p.descricao || '')}</td>
      </tr>`).join('');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8" /></head>
    <body style="font-family:Arial,sans-serif;"><table>
      <tr><td colspan="9" style="background:#B84231;color:#FFF;font-size:15px;font-weight:bold;padding:12px;">COHAB MINAS &bull; Planejamento Editorial (${formatDateBR(startStr)} a ${formatDateBR(endStr)})</td></tr>
      <tr style="background:#333;color:#FFF;font-weight:bold;">
        ${['Data', 'Título da Pauta', 'Editoria', 'Formato', 'Classificação', 'Prioridade', 'Status', 'Designação', 'Briefing'].map(h => `<th style="padding:8px;border:1px solid #333;">${h}</th>`).join('')}
      </tr>${rowsHTML}
    </table></body></html>`;
  downloadBlob(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' }), `planejamento_editorial_${startStr}_a_${endStr}.xls`);
  closeModal('excelExportModal');
  showToast('Planilha Excel exportada!');
}

function generateCalendarPNG(event) {
  event.preventDefault();
  const startStr = $('pngStartDate').value, endStr = $('pngEndDate').value;
  if (!validRange(startStr, endStr)) return;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const startDate = new Date(sy, sm - 1, sd), endDate = new Date(ey, em - 1, ed);
  if ((endDate - startDate) / 86400000 > 120) { showToast('Selecione no máximo 4 meses para a imagem.', 'error'); return; }

  const gridStart = new Date(startDate); gridStart.setDate(startDate.getDate() - startDate.getDay());
  const gridEnd = new Date(endDate); gridEnd.setDate(endDate.getDate() + (6 - endDate.getDay()));
  const days = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));

  const weeks = Math.max(1, Math.ceil(days.length / 7));
  const scale = 2, width = 1400, colW = (width - 80) / 7, headerH = 115, weekRowH = 175;
  const height = headerH + 40 + weeks * weekRowH + 40;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#F5F5F5'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#B84231'; ctx.fillRect(0, 0, width, 8);
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 8, width, headerH - 8);

  // Símbolo Cohab
  const mark = [[[48, 4], [8, 27], [48, 50]], [[52, 4], [92, 27], [52, 50]], [[6, 31], [6, 79], [46, 55]], [[94, 31], [94, 79], [54, 55]], [[8, 83], [48, 106], [48, 60]], [[92, 83], [52, 106], [52, 60]]];
  mark.forEach((tri, i) => {
    ctx.fillStyle = i === 3 ? '#B84231' : '#1F1F1F';
    ctx.beginPath();
    tri.forEach(([x, y], j) => { const px = 40 + x * 0.5, py = 30 + y * 0.5; j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.closePath(); ctx.fill();
  });

  ctx.fillStyle = '#333333'; ctx.font = '800 24px Inter, sans-serif';
  ctx.fillText('Planejamento Editorial • Cohab Minas', 104, 56);
  ctx.fillStyle = '#7A7A7A'; ctx.font = '600 14px Inter, sans-serif';
  ctx.fillText(`Assessoria de Comunicação Social  |  Período: ${formatDateBR(startStr)} a ${formatDateBR(endStr)}`, 104, 84);

  const weekNames = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO'];
  const topY = headerH + 12;
  ctx.fillStyle = '#EAEAEA'; ctx.fillRect(40, topY, width - 80, 32);
  ctx.fillStyle = '#4A4A4A'; ctx.font = '800 11px Inter, sans-serif';
  weekNames.forEach((w, i) => ctx.fillText(w, 40 + i * colW + 12, topY + 20));

  days.forEach((d, idx) => {
    const col = idx % 7, row = Math.floor(idx / 7);
    const x = 40 + col * colW, y = topY + 32 + row * weekRowH;
    const iso = toISODate(d);
    const inRange = iso >= startStr && iso <= endStr;
    ctx.fillStyle = inRange ? '#FFFFFF' : '#EFEFEF'; ctx.fillRect(x, y, colW, weekRowH);
    ctx.strokeStyle = '#DCDCDC'; ctx.strokeRect(x, y, colW, weekRowH);
    ctx.fillStyle = inRange ? '#333333' : '#999999'; ctx.font = '800 13px Inter, sans-serif';
    ctx.fillText(String(d.getDate()), x + 10, y + 22);
    if (!inRange) return;

    const dayItems = state.pautas.filter(p => p.data === iso).sort((a, b) => (a.prioridade || 99) - (b.prioridade || 99));
    let cursorY = y + 32;
    dayItems.slice(0, 3).forEach(item => {
      const st = STATUS_META[item.status] || STATUS_META['A Fazer'];
      const tp = TYPE_META[item.tipo] || TYPE_META.FRIA;
      const cardH = 40;
      ctx.fillStyle = '#FAFAFA'; ctx.fillRect(x + 8, cursorY, colW - 16, cardH);
      ctx.strokeStyle = '#E2E2E2'; ctx.strokeRect(x + 8, cursorY, colW - 16, cardH);
      ctx.fillStyle = st.dotHex; ctx.fillRect(x + 8, cursorY, 4, cardH);
      ctx.fillStyle = '#333333'; ctx.font = '700 10px Inter, sans-serif';
      ctx.fillText(item.titulo.length > 24 ? item.titulo.slice(0, 23) + '…' : item.titulo, x + 17, cursorY + 14);
      ctx.fillStyle = '#666666'; ctx.font = '600 9px Inter, sans-serif';
      const a = item.responsavel;
      const initials = a.length ? `${getPersonInitials(a[0])}${a.length > 1 ? ' +' + (a.length - 1) : ''}` : '';
      ctx.fillText(`${item.status}${item.status !== 'Publicado' ? ' • #' + (item.prioridade || 1) : ''}${initials ? ' • ' + initials : ''}`, x + 17, cursorY + 30);
      ctx.fillStyle = tp.dotHex; ctx.beginPath(); ctx.arc(x + colW - 16, cursorY + 12, 3.5, 0, Math.PI * 2); ctx.fill();
      cursorY += cardH + 5;
    });
    if (dayItems.length > 3) {
      ctx.fillStyle = '#B84231'; ctx.font = '700 9px Inter, sans-serif';
      ctx.fillText(`+${dayItems.length - 3} pauta(s)`, x + 12, cursorY + 8);
    }
  });

  canvas.toBlob(blob => {
    if (!blob) return;
    downloadBlob(blob, `calendario_cohab_${startStr}_a_${endStr}.png`);
    closeModal('pngExportModal');
    showToast('Imagem PNG exportada!');
  }, 'image/png');
}

function openReportModal() {
  setRangePreset('report', 'MONTH');
  openModal('reportModal');
}

function generateEditorialReport(event) {
  if (event) event.preventDefault();
  const startStr = $('reportStartDate').value, endStr = $('reportEndDate').value;
  const container = $('reportOutputContainer');
  if (!startStr || !endStr) return;
  const items = state.pautas.filter(p => p.data >= startStr && p.data <= endStr).sort((a, b) => a.data.localeCompare(b.data));
  const total = items.length;
  const countBy = (fn) => items.reduce((acc, it) => { const k = fn(it); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const byStatus = countBy(i => i.status || 'A Fazer');
  const byFormato = countBy(i => i.formato || 'Não definido');
  const byEditoria = countBy(i => i.editoria || 'Serviços');
  const byPessoa = items.reduce((acc, it) => { (it.responsavel.length ? it.responsavel : ['Sem designação']).forEach(n => { acc[n] = (acc[n] || 0) + 1; }); return acc; }, {});
  const quentes = items.filter(i => i.tipo === 'QUENTE').length;
  const frias = total - quentes;
  const publicados = byStatus['Publicado'] || 0;
  const taxa = total ? Math.round((publicados / total) * 100) : 0;
  const atrasadas = items.filter(i => i.status !== 'Publicado' && i.data < todayISO()).length;

  const stopWords = new Set(['para', 'com', 'sobre', 'pela', 'pelo', 'das', 'dos', 'nos', 'nas', 'uma', 'uns', 'umas', 'que', 'por', 'como', 'mais', 'esta', 'este', 'essa', 'esse', 'entre', 'também', 'seus', 'suas']);
  const wordFreq = {};
  items.forEach(it => {
    `${it.titulo || ''} ${it.descricao || ''}`.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w)).forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
  });
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);

  const renderBars = (obj) => {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `<p class="text-xs text-cohab-medium">Sem dados no período.</p>`;
    return entries.map(([label, count]) => {
      const pct = total ? Math.round((count / total) * 100) : 0;
      return `<div class="space-y-1"><div class="flex justify-between text-xs font-bold text-cohab-graphite"><span>${escapeHTML(label)}</span><span>${count} (${pct}%)</span></div>
        <div class="h-2 rounded-full bg-cohab-bg overflow-hidden"><div class="h-full bg-cohab-terracotta rounded-full" style="width:${pct}%"></div></div></div>`;
    }).join('');
  };

  container.innerHTML = `
    <div class="bg-white rounded-2xl border border-cohab-border p-5 space-y-5">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-cohab-border">
        <div>
          <span class="text-[10px] font-extrabold uppercase tracking-wider text-cohab-terracotta">Relatório Executivo • Ascom Cohab Minas</span>
          <h4 class="text-lg font-extrabold text-cohab-graphiteDark">Período: ${formatDateBR(startStr)} a ${formatDateBR(endStr)}</h4>
        </div>
        <span class="text-xs font-bold text-cohab-medium">Emitido por ${escapeHTML(state.profile?.nome || '')} em ${new Date().toLocaleDateString('pt-BR')}</span>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div class="p-3.5 rounded-xl bg-cohab-bg border border-cohab-border"><div class="text-[11px] font-bold text-cohab-medium">Total</div><div class="text-2xl font-extrabold text-cohab-graphiteDark mt-1">${total}</div></div>
        <div class="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200"><div class="text-[11px] font-bold text-emerald-800">Publicados</div><div class="text-2xl font-extrabold text-emerald-700 mt-1">${publicados} <span class="text-xs">(${taxa}%)</span></div></div>
        <div class="p-3.5 rounded-xl bg-red-50 border border-red-200"><div class="text-[11px] font-bold text-red-800">Pautas Quentes</div><div class="text-2xl font-extrabold text-red-600 mt-1">${quentes}</div></div>
        <div class="p-3.5 rounded-xl bg-sky-50 border border-sky-200"><div class="text-[11px] font-bold text-sky-800">Pautas Frias</div><div class="text-2xl font-extrabold text-sky-600 mt-1">${frias}</div></div>
        <div class="p-3.5 rounded-xl bg-amber-50 border border-amber-200"><div class="text-[11px] font-bold text-amber-800">Atrasadas</div><div class="text-2xl font-extrabold text-amber-700 mt-1">${atrasadas}</div></div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="p-4 rounded-xl border border-cohab-border space-y-2.5"><h5 class="text-xs font-extrabold uppercase tracking-wider text-cohab-graphite">Por Status</h5>${renderBars(byStatus)}</div>
        <div class="p-4 rounded-xl border border-cohab-border space-y-2.5"><h5 class="text-xs font-extrabold uppercase tracking-wider text-cohab-graphite">Por Formato</h5>${renderBars(byFormato)}</div>
        <div class="p-4 rounded-xl border border-cohab-border space-y-2.5"><h5 class="text-xs font-extrabold uppercase tracking-wider text-cohab-graphite">Por Editoria</h5>${renderBars(byEditoria)}</div>
        <div class="p-4 rounded-xl border border-cohab-border space-y-2.5"><h5 class="text-xs font-extrabold uppercase tracking-wider text-cohab-graphite">Por Responsável</h5>${renderBars(byPessoa)}</div>
      </div>
      <div class="p-4 rounded-xl border border-cohab-border">
        <h5 class="text-xs font-extrabold uppercase tracking-wider text-cohab-graphite mb-2.5">Palavras mais frequentes</h5>
        <div class="flex flex-wrap gap-2">
          ${!topWords.length ? '<span class="text-xs text-cohab-medium">Nenhuma palavra relevante no período.</span>'
            : topWords.map(([w, c]) => `<span class="px-2.5 py-1 rounded-lg bg-cohab-bg border border-cohab-border text-xs font-bold text-cohab-graphite">${escapeHTML(w)} <span class="text-cohab-terracotta">(${c})</span></span>`).join('')}
        </div>
      </div>
    </div>`;
}

function reportDocument(content) {
  const css = new URL('assets/css/app.css', window.location.href).href;
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório Editorial - Cohab Minas</title><link rel="stylesheet" href="${css}"></head><body class="p-6 bg-white font-sans text-cohab-graphite">${content}</body></html>`;
}

function printEditorialReport() {
  const win = window.open('', '_blank');
  if (!win) { showToast('Permita pop-ups para imprimir.', 'error'); return; }
  win.opener = null;
  win.document.write(reportDocument($('reportOutputContainer').innerHTML));
  win.document.close();
  let printed = false;
  const doPrint = () => { if (printed) return; printed = true; try { win.focus(); win.print(); } catch (_) { /* noop */ } };
  win.onload = doPrint;
  setTimeout(doPrint, 900);
}

function downloadReportHTML() {
  const startStr = $('reportStartDate').value, endStr = $('reportEndDate').value;
  // Versão autônoma: embute o CSS
  fetch('assets/css/app.css').then(r => r.text()).then(css => {
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório Editorial - Cohab Minas</title><style>${css.replace(/url\([^)]*\)/g, 'none')}</style></head><body class="p-6 bg-neutral-100" style="font-family:Inter,Arial,sans-serif">${$('reportOutputContainer').innerHTML}</body></html>`;
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8;' }), `relatorio_editorial_${startStr}_a_${endStr}.html`);
  }).catch(() => showToast('Não foi possível gerar o arquivo.', 'error'));
}

// =============================================================================
// ATALHOS DE TECLADO
// =============================================================================
function isTyping(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('idleModal').classList.contains('hidden')) { resetIdleTimer(true); return; }
    const m = topOpenModal();
    if (m) { m.id === 'confirmModal' ? closeConfirmModal() : closeModal(m.id); e.preventDefault(); return; }
    closeAllDropdowns();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('pautaModal').classList.contains('hidden')) {
    e.preventDefault();
    if (!$('pautaFieldset').disabled) $('pautaForm').requestSubmit();
    return;
  }
  if (!state.user || isTyping(document.activeElement) || topOpenModal() || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n' && can.edit()) { e.preventDefault(); openPautaModal(); }
  else if (e.key === '/') { e.preventDefault(); openSearchOverlay(true); }
  else if (k === 't') { goToToday(); }
  else if (e.key === 'ArrowLeft' && currentTab === 'calendar') stepMonth(-1);
  else if (e.key === 'ArrowRight' && currentTab === 'calendar') stepMonth(1);
  else if (/^[1-6]$/.test(e.key)) {
    const order = ['calendar', 'suggestions', 'hierarchy', 'completed', 'logs', 'users'];
    switchTab(order[parseInt(e.key, 10) - 1]);
  }
});

// =============================================================================
// INICIALIZAÇÃO
// =============================================================================
function initApp() {
  $('confirmCancelBtn').onclick = closeConfirmModal;
  $('confirmAcceptBtn').onclick = async () => {
    const cb = confirmCallback;
    closeConfirmModal();
    if (typeof cb === 'function') await cb();
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-dropdown-root]')) closeAllDropdowns();
  });

  // Fecha modais ao clicar no fundo
  document.querySelectorAll('[data-modal]').forEach(m => {
    m.addEventListener('mousedown', (e) => {
      if (e.target === m) m.id === 'confirmModal' ? closeConfirmModal() : closeModal(m.id);
    });
  });

  $('loginForm').addEventListener('submit', handleLogin);
  $('mfaForm').addEventListener('submit', handleMfaLogin);
  $('forgotForm').addEventListener('submit', handleForgot);
  $('setPasswordForm').addEventListener('submit', handleSetPassword);
  $('loginPassword').addEventListener('keyup', (e) => {
    $('capsLockHint').classList.toggle('hidden', !(e.getModifierState && e.getModifierState('CapsLock')));
  });
  $('mfaCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) $('mfaForm').requestSubmit();
  });
  $('loginRemember').checked = localStorage.getItem(REMEMBER_KEY) === '1';

  // Remove dados antigos de "membro" (agora vem do login)
  localStorage.removeItem(LEGACY_KEYS.member);

  let lastAgenda = window.matchMedia('(max-width: 767px)').matches;
  window.addEventListener('resize', () => {
    const now = window.matchMedia('(max-width: 767px)').matches;
    if (now !== lastAgenda && state.user && currentTab === 'calendar') { lastAgenda = now; renderCalendar(); }
  });

  syncMonthSelectors();
  bootAuth();
}

window.addEventListener('DOMContentLoaded', initApp);
