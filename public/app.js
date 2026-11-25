// Importat direct (fără import map), ca politica CSP să poată interzice orice script inline.
import { createApp, reactive } from '/vendor/vue.js';

// ---------- stare comună ----------
const store = reactive({
  ready: false,
  me: null,
  units: [],
  users: [],
  categories: [],
  absences: [], // absențele în curs și cele programate ale angajaților
  absenceKinds: [],
  today: '', // data de azi după ceasul serverului
  docs: [],
  docsLoaded: false,
  toast: null,
  dialog: null,
  editor: null, // fișierul deschis în editorul de documente: { fileId }
  route: location.hash.slice(1) || 'acasa',
});
window.addEventListener('hashchange', () => (store.route = location.hash.slice(1) || 'acasa'));

// La ieșire (sau la expirarea sesiunii) datele contului anterior dispar imediat din pagină,
// ca următoarea persoană care se autentifică pe același calculator să nu le vadă nici o clipă.
function clearSession() {
  store.me = null;
  store.units = [];
  store.users = [];
  store.categories = [];
  store.absences = [];
  store.docs = [];
  store.docsLoaded = false;
  store.dialog = null;
  store.editor = null;
}

let toastTimer;
function toast(msg, err = false) {
  store.toast = { msg, err };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = null), err ? 6000 : 2800);
}

// Fereastră de confirmare / întrebare în stilul aplicației (în locul confirm/prompt/alert ale browserului).
// Întoarce true/false sau, cu `input: true`, textul introdus (null la anulare).
function ask(opts) {
  return new Promise((resolve) => {
    if (store.dialog) store.dialog.resolve(opts.input ? null : false);
    store.dialog = { title: 'Confirmare', okLabel: 'Confirmă', value: '', ...opts, resolve };
  });
}

async function api(url, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
  if (opts.form) init.body = opts.form;
  else if (opts.raw) {
    init.headers['Content-Type'] = 'application/octet-stream';
    init.body = opts.raw;
  } else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let r;
  try {
    r = await fetch(url, init);
  } catch {
    throw new Error('Serverul nu răspunde. Verificați conexiunea la rețea și reîncercați.');
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401 && store.me) {
      clearSession();
      toast('Sesiunea a expirat. Autentificați-vă din nou.', true);
    }
    throw new Error((data && data.error) || (r.status >= 500 ? 'Eroare internă de server.' : 'Cererea nu a putut fi procesată.'));
  }
  return data;
}

// Rulează o acțiune și afișează rezultatul; întoarce true la succes.
async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

async function loadShared() {
  const [dir, cats] = await Promise.all([api('/api/directory'), api('/api/categories')]);
  store.units = dir.units;
  store.users = dir.users;
  store.absences = dir.absences || [];
  store.absenceKinds = dir.absenceKinds || [];
  store.today = dir.today || '';
  store.categories = cats;
}
async function loadDocs() {
  store.docs = await api('/api/documents');
  store.docsLoaded = true;
}
const inboxCount = () => store.docs.filter((d) => d.unseen || d.mySign === 'pending').length;
// Notificările se actualizează singure, fără reîncărcarea paginii.
setInterval(() => {
  if (store.me && !store.me.must_change && !document.hidden) loadDocs().catch(() => {});
}, 60000);

async function loadSession() {
  let me = null;
  try {
    me = await api('/api/me');
  } catch {}
  if (!me || me.must_change) clearSession();
  if (me && !me.must_change) {
    try {
      await Promise.all([loadShared(), loadDocs()]);
    } catch (e) {
      toast(e.message, true);
    }
  }
  store.me = me;
  store.ready = true;
}

// ---------- utilitare ----------
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const ROLES = { admin: 'Administrator', editor: 'Editor', user: 'Angajat' };
const isAdmin = () => store.me && store.me.role === 'admin';
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
// Culoare stabilă pentru avatar, derivată din nume (aceeași persoană are mereu aceeași culoare).
const AVATAR_COLORS = ['#1d4e89', '#0f766e', '#9a3412', '#6d28d9', '#b45309', '#0e7490', '#be123c', '#4d7c0f'];
const avatarStyle = (name) => {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { background: AVATAR_COLORS[h % AVATAR_COLORS.length] };
};

function childUnits(parentId) {
  const ids = new Set(store.units.map((u) => u.id));
  // subdiviziunile fără părinte valid sunt tratate ca rădăcini
  return store.units.filter((u) => (parentId === null ? u.parent_id === null || !ids.has(u.parent_id) : u.parent_id === parentId));
}
function flatUnits() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const u of childUnits(parentId)) {
      out.push({ ...u, depth, label: '   '.repeat(depth) + u.name });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
const unitName = (id) => (store.units.find((u) => u.id === id) || {}).name || '—';
function tagIndex() {
  const map = new Map();
  for (const c of store.categories) for (const t of c.tags) map.set(t.id, { ...t, color: c.color, category: c.name });
  return map;
}
const chipStyle = (color) => ({ color, borderColor: color, background: color + '14' });

// ---------- componente de bază ----------
// Ferestrele deschise, în ordine; Escape o închide doar pe cea de deasupra.
const modalStack = [];
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) {
    e.preventDefault();
    modalStack[modalStack.length - 1].cancel();
  }
});

const Modal = {
  props: {
    title: String,
    wide: Boolean,
    xl: Boolean,
    busy: Boolean,
    danger: Boolean,
    okLabel: { type: String, default: 'Salvează' },
    busyLabel: { type: String, default: 'Se salvează…' },
    cancelLabel: { type: String, default: 'Anulează' },
  },
  emits: ['close', 'submit'],
  methods: {
    // în timpul salvării fereastra rămâne deschisă, ca utilizatorul să vadă rezultatul
    cancel() {
      if (!this.busy) this.$emit('close');
    },
  },
  mounted() {
    modalStack.push(this);
    this.lastFocus = document.activeElement;
    const el =
      this.$el.querySelector('[autofocus]') ||
      this.$el.querySelector('.modal-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]), .modal-body select, .modal-body textarea') ||
      this.$el.querySelector('.modal-foot .btn:last-child');
    if (el) el.focus();
  },
  unmounted() {
    const i = modalStack.indexOf(this);
    if (i >= 0) modalStack.splice(i, 1);
    if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
  },
  template: /*html*/ `
    <div class="overlay" @mousedown.self="cancel">
      <form class="modal" :class="{ wide, xl }" role="dialog" aria-modal="true" :aria-label="title" @submit.prevent="busy || $emit('submit')">
        <div class="modal-head"><h2>{{ title }}</h2><button type="button" class="x" @click="cancel" aria-label="Închide">×</button></div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot">
          <!-- formularele cu mai mulți pași își pun propriile butoane (Înapoi / Înainte) -->
          <slot name="foot">
            <button v-if="cancelLabel" type="button" class="btn" :disabled="busy" @click="cancel">{{ cancelLabel }}</button>
            <button class="btn" :class="danger ? 'danger-solid' : 'primary'" :disabled="busy">{{ busy ? busyLabel : okLabel }}</button>
          </slot>
        </div>
      </form>
    </div>`,
};

const DialogHost = {
  components: { Modal },
  computed: { d: () => store.dialog },
  methods: {
    close(result) {
      const d = store.dialog;
      store.dialog = null;
      if (d) d.resolve(result);
    },
    ok() {
      if (!this.d.input) return this.close(true);
      const v = this.d.value.trim();
      if (v) this.close(v);
    },
  },
  template: /*html*/ `
    <Modal v-if="d" :title="d.title" :ok-label="d.okLabel" :cancel-label="d.cancelLabel === undefined ? 'Anulează' : d.cancelLabel" :danger="d.danger" @close="close(d.input ? null : false)" @submit="ok">
      <p v-if="d.message" class="dialog-msg">{{ d.message }}</p>
      <label v-if="d.input" class="field"><span>{{ d.label }}</span><input v-model="d.value" :maxlength="d.maxlength || 200" required autofocus /></label>
    </Modal>`,
};

const Brand = {
  template: /*html*/ `<div class="brand"><img class="brand-logo" src="/favicon.svg" alt="" width="30" height="30" /><span>e-Management <span class="brand-mark">ANSC</span></span></div>`,
};

const Login = {
  components: { Brand },
  data: () => ({ username: '', password: '', error: '', busy: false }),
  methods: {
    async submit() {
      this.busy = true;
      this.error = '';
      try {
        await api('/api/login', { method: 'POST', body: { username: this.username, password: this.password } });
        await loadSession();
      } catch (e) {
        this.error = e.message;
      }
      this.busy = false;
    },
  },
  template: /*html*/ `
    <div class="login-wrap">
      <form class="login" @submit.prevent="submit">
        <Brand />
        <h1>Autentificare</h1>
        <p class="muted small login-sub">Agenția Națională pentru Soluționarea Contestațiilor</p>
        <div v-if="error" class="error" role="alert">{{ error }}</div>
        <label class="field"><span>Utilizator</span><input v-model="username" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus required /></label>
        <label class="field"><span>Parolă</span><input v-model="password" type="password" autocomplete="current-password" required /></label>
        <button class="btn primary block" :disabled="busy">{{ busy ? 'Se verifică…' : 'Intră în sistem' }}</button>
      </form>
    </div>`,
};

const PasswordFields = {
  props: { modelValue: Object },
  template: /*html*/ `
    <label class="field"><span>Parola curentă</span><input v-model="modelValue.current" type="password" autocomplete="current-password" required /></label>
    <label class="field"><span>Parola nouă (cel puțin 10 caractere)</span><input v-model="modelValue.next" type="password" autocomplete="new-password" minlength="10" required /></label>
    <label class="field"><span>Repetați parola nouă</span><input v-model="modelValue.again" type="password" autocomplete="new-password" required /></label>`,
};
async function changePassword(f) {
  if (f.next !== f.again) {
    toast('Parolele noi nu coincid.', true);
    return false;
  }
  return run(() => api('/api/password', { method: 'POST', body: { current: f.current, next: f.next } }), 'Parola a fost schimbată.');
}

const ForcedPassword = {
  components: { Brand, PasswordFields },
  data: () => ({ f: { current: '', next: '', again: '' }, busy: false }),
  methods: {
    async submit() {
      this.busy = true;
      if (await changePassword(this.f)) await loadSession();
      this.busy = false;
    },
    async logout() {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      clearSession();
    },
  },
  template: /*html*/ `
    <div class="login-wrap">
      <form class="login" @submit.prevent="submit">
        <Brand />
        <h1>Setați o parolă nouă</h1>
        <p class="muted small login-sub">Înainte de a continua, schimbați parola primită de la administrator.</p>
        <PasswordFields v-model="f" />
        <button class="btn primary block" :disabled="busy">{{ busy ? 'Se salvează…' : 'Salvează parola' }}</button>
        <button type="button" class="btn link block login-alt" @click="logout">Ieșire</button>
      </form>
    </div>`,
};

// ---------- pictograme (comune) ----------
const ICONS = {
  unit: '<path d="M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M15 14h4M17 12v4"/>',
  user: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M19 8v6M16 11h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  clip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.4 7"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 20h6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  review: '<path d="M4 5h16v11H10l-5 4v-4H4z"/><path d="M8 9h8M8 12h5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6z"/>',
};
const Icon = {
  props: { name: String },
  computed: { svg() { return ICONS[this.name] || ''; } },
  template: /*html*/ `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="svg"></svg>`,
};

// Starea „gol” a unei liste: o ilustrație mică, un titlu, o explicație și, opțional, o acțiune (slot).
const EMPTY_ART = {
  search:
    '<rect x="18" y="16" width="52" height="64" rx="8" fill="#fff" stroke="#b9cbe2" stroke-width="2"/><path d="M28 32h32M28 41h32M28 50h20" stroke="#d3e2f4" stroke-width="3" stroke-linecap="round"/><circle cx="74" cy="58" r="15" fill="#e8eff8" stroke="#1d4e89" stroke-width="3"/><path d="m85 69 11 11" stroke="#1d4e89" stroke-width="4" stroke-linecap="round"/>',
  docs:
    '<rect x="16" y="24" width="48" height="58" rx="8" transform="rotate(-8 40 53)" fill="#e8eff8" stroke="#b9cbe2" stroke-width="2"/><rect x="38" y="16" width="48" height="62" rx="8" fill="#fff" stroke="#1d4e89" stroke-width="2"/><path d="M48 32h28M48 41h28M48 50h18" stroke="#9db9dc" stroke-width="3" stroke-linecap="round"/><circle cx="82" cy="72" r="13" fill="#1d4e89"/><path d="M82 66v12M76 72h12" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
  inbox:
    '<path d="M16 50 28 22h48l12 28v24a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6z" fill="#fff" stroke="#b9cbe2" stroke-width="2"/><path d="M16 50h20l5 9h22l5-9h20" fill="#e8eff8" stroke="#b9cbe2" stroke-width="2" stroke-linejoin="round"/><circle cx="76" cy="26" r="13" fill="#12b76a"/><path d="m70 26 4.5 4.5L83 22" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};
const EmptyState = {
  props: { art: { type: String, default: 'docs' }, title: String, text: String },
  computed: { svg() { return EMPTY_ART[this.art] || EMPTY_ART.docs; } },
  template: /*html*/ `
    <div class="card empty empty-state">
      <svg class="empty-art" viewBox="0 0 104 96" fill="none" aria-hidden="true" v-html="svg"></svg>
      <b>{{ title }}</b>
      <p v-if="text">{{ text }}</p>
      <div v-if="$slots.default" class="empty-actions"><slot /></div>
    </div>`,
};

// ---------- documente ----------
// documentele fără dată (formulare, modele) au doc_date = ''
const docDay = (d) => (d.doc_date ? Number(d.doc_date.slice(8)) : '—');
const docMon = (d) => (d.doc_date ? MONTHS[Number(d.doc_date.slice(5, 7)) - 1].slice(0, 3) + ' ' + d.doc_date.slice(0, 4) : 'fără dată');
function visLabel(d) {
  if (d.visibility === 'all') return 'Toți angajații';
  const names = [...d.unitIds.map(unitName), ...d.userIds.map((id) => (store.users.find((u) => u.id === id) || {}).full_name || '—')];
  return names.length ? 'Vizibil pentru: ' + names.join(', ') : d.signers.length ? 'Privat (autor, semnatari și administratori)' : 'Privat (autor și administratori)';
}
// Textul de avertizare când notificarea prin e-mail nu a ajuns la toți semnatarii ('' = totul în regulă).
function mailNote(m) {
  if (!m) return '';
  if (m.disabled) return 'E-mailul nu este configurat în Setări: semnatarii văd solicitarea doar în Notificări.';
  const parts = [];
  if (m.noEmail.length) parts.push('fără adresă de e-mail: ' + m.noEmail.join(', '));
  if (m.failed.length) parts.push('trimitere eșuată: ' + m.failed.join(', '));
  return parts.length ? 'E-mail netrimis — ' + parts.join('; ') : '';
}

// Formatele pe care le deschide editorul de documente (ONLYOFFICE); cele vechi doar pentru citire.
const OFFICE_EDIT = ['docx', 'odt', 'xlsx', 'ods', 'pptx', 'odp', 'pdf'];
const OFFICE_VIEW = [...OFFICE_EDIT, 'doc', 'rtf', 'txt', 'xls', 'csv', 'ppt'];
const extName = (n) => ((/\.([a-z0-9]{1,5})$/i.exec(n) || [])[1] || '').toLowerCase();
const fmtDay = (s) => (s ? s.split('-').reverse().join('.') : '');
// absența în curs azi (sau null) și următoarea absență programată a unei persoane
const absenceNow = (userId) => {
  const t = store.today || today();
  return store.absences.find((a) => a.user_id === userId && a.from_date <= t && a.to_date >= t) || null;
};
const absenceNext = (userId) => {
  const t = store.today || today();
  return store.absences.find((a) => a.user_id === userId && a.from_date > t) || null;
};
// termenul de semnare: depășit (încă nesemnat de toți după termen) sau aproape (azi sau în următoarele 2 zile)
const signOpen = (d) => d.signers.some((s) => !s.signed_at);
const isOverdue = (d) => !!d.sign_until && signOpen(d) && d.sign_until < (store.today || today());
const isDueSoon = (d) => !!d.sign_until && signOpen(d) && !isOverdue(d) && d.sign_until <= addDays(2);
function dueText(d) {
  if (!d.sign_until) return '';
  const t = store.today || today();
  if (d.sign_until < t) return 'termen depășit (' + fmtDay(d.sign_until) + ')';
  if (d.sign_until === t) return 'termen: azi';
  if (d.sign_until === addDays(1)) return 'termen: mâine';
  return 'termen: ' + fmtDay(d.sign_until);
}
// steaua unui document: se schimbă imediat în pagină și revine dacă serverul refuză
async function toggleFav(d) {
  d.fav = !d.fav;
  try {
    await api('/api/documents/' + d.id + '/favorite', { method: 'POST', body: { on: d.fav } });
  } catch (e) {
    d.fav = !d.fav;
    toast(e.message, true);
  }
}
const userName = (id) => (store.users.find((u) => u.id === id) || {}).full_name || '';
const absenceText = (a) => a.kind + (a.from_date === a.to_date ? ', ' + fmtDay(a.from_date) : ', ' + fmtDay(a.from_date) + ' – ' + fmtDay(a.to_date));
const addDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// Formularul de document, pe pași: fiecare pas are câmpurile lui, iar ultimul arată totul înainte de salvare.
// La un document nou pașii se parcurg în ordine (cu validarea pasului curent); la modificare se poate sări oriunde.
const DOC_STEPS = [
  { label: 'Date generale', hint: 'Denumire, dată, număr', icon: 'file' },
  { label: 'Fișiere', hint: 'Ce se atașează', icon: 'clip' },
  { label: 'Etichete și acces', hint: 'Unde apare, cine îl vede', icon: 'shield' },
  { label: 'Semnare și avizare', hint: 'Cine semnează, cine avizează', icon: 'pen' },
  { label: 'Verificare', hint: 'Totul dintr-o privire', icon: 'list' },
];
const DocForm = {
  components: { Modal, Icon },
  props: { doc: Object },
  emits: ['close', 'saved'],
  data() {
    const d = this.doc;
    return {
      steps: DOC_STEPS,
      step: 0,
      // cel mai departe pas atins: până acolo se poate sări direct din bara de pași
      reached: d ? DOC_STEPS.length - 1 : 0,
      busy: false,
      dragging: false,
      userFilter: '',
      signFilter: '',
      newFiles: [],
      needsSign: d ? d.signers.length > 0 : false,
      needsReview: d ? !!d.review_until : false,
      noDate: d ? !d.doc_date : false,
      form: {
        title: d ? d.title : '',
        number: d ? d.number : '',
        doc_date: d && d.doc_date ? d.doc_date : today(),
        description: d ? d.description : '',
        visibility: d ? d.visibility : 'all',
        tagIds: d ? [...d.tagIds] : [],
        unitIds: d ? [...d.unitIds] : [],
        userIds: d ? [...d.userIds] : [],
        signerIds: d ? d.signers.map((s) => s.id) : [],
        review_until: d && d.review_until ? d.review_until : addDays(7),
        sign_until: d ? d.sign_until || '' : '',
        removeFileIds: [],
      },
    };
  },
  computed: {
    store: () => store,
    units: () => flatUnits(),
    people() {
      return this.match(this.userFilter, this.form.userIds);
    },
    signCandidates() {
      const q = this.signFilter.trim().toLowerCase();
      return store.users.filter((u) => !this.form.signerIds.includes(u.id) && (!q || u.full_name.toLowerCase().includes(q)));
    },
    // versiunile semnate fac parte din lanțul de semnare și nu se pot elimina de aici
    keptFiles() {
      return this.doc ? this.doc.files.filter((f) => !f.signed_by_name && !this.form.removeFileIds.includes(f.id)) : [];
    },
    reviewHint() {
      const who = this.form.visibility === 'all' ? 'toți angajații' : 'persoanele și subdiviziunile selectate la „Acces”';
      return 'Până la ' + fmtDay(this.form.review_until) + ', ' + who + ' pot deschide fișierele în editor și propune modificări sau comentarii; apoi documentul devine doar pentru citire, iar dvs. îl puteți modifica în continuare.' + (store.me.office ? '' : ' Atenție: editorul de documente nu este încă configurat (pagina „Setări”).');
    },
    mailHint() {
      return store.me.mailEnabled
        ? 'Persoana aflată la rând primește un e-mail și o notificare în aplicație. Semnatarii văd documentul indiferent de setările de vizibilitate.'
        : 'E-mailul nu este configurat (administratorul îl setează în pagina „Setări”): semnatarii vor fi anunțați doar în aplicație.';
    },
    last() {
      return this.steps.length - 1;
    },
    fileCount() {
      return this.keptFiles.length + this.newFiles.length;
    },
    // pentru pasul de verificare
    chosenTags() {
      const out = [];
      for (const c of store.categories) for (const t of c.tags) if (this.form.tagIds.includes(t.id)) out.push({ id: t.id, name: t.name, color: c.color });
      return out;
    },
    accessText() {
      if (this.form.visibility === 'all') return 'Toți angajații';
      const names = [...this.form.unitIds.map(unitName), ...this.form.userIds.map((id) => this.personName(id))];
      return names.length ? names.join(', ') : 'Doar autorul, semnatarii și administratorii';
    },
    signers() {
      return this.needsSign ? this.form.signerIds : [];
    },
    // un rezumat scurt sub fiecare pas din bară
    stepNotes() {
      return [
        this.form.title ? this.form.title : '',
        this.fileCount ? this.fileCount + (this.fileCount === 1 ? ' fișier' : ' fișiere') : '',
        this.form.visibility === 'all' ? 'toți angajații' : 'acces restrâns',
        this.signers.length ? this.signers.length + (this.signers.length === 1 ? ' semnatar' : ' semnatari') : this.needsReview ? 'avizare' : '',
        '',
      ];
    },
  },
  methods: {
    fmtSize,
    today,
    fmtDay,
    extName,
    kindOf: (name) => EXT_KIND[extName(name)] || 'other',
    // Câmpurile obligatorii ale pasului curent (doar el este afișat) trebuie completate înainte de a merge mai departe.
    paneValid() {
      const pane = this.$refs.pane;
      if (!pane) return true;
      for (const el of pane.querySelectorAll('input, textarea, select')) {
        if (!el.checkValidity()) {
          el.reportValidity();
          return false;
        }
      }
      if (this.step === 3 && this.needsReview && !this.form.review_until) {
        toast('Alegeți termenul de avizare.', true);
        return false;
      }
      return true;
    },
    go(i) {
      if (i === this.step || i < 0 || i > this.last) return;
      if (i > this.step) {
        if (!this.paneValid()) return;
        // la un document nou nu se sare peste pași neatinși (în afară de salt direct la verificare)
        if (!this.doc && i > this.reached + 1 && i !== this.last) return;
      }
      this.step = i;
      this.reached = Math.max(this.reached, i);
      this.$nextTick(() => {
        const el = this.$refs.pane && this.$refs.pane.querySelector('input:not([type=checkbox]):not([type=hidden]):not(:disabled), textarea');
        if (el && this.step < this.last) el.focus();
      });
    },
    // Enter sau butonul principal: pasul următor, iar la final salvarea
    submit() {
      if (this.step < this.last) this.go(this.step + 1);
      else this.save();
    },
    saveNow() {
      if (this.paneValid()) this.save();
    },
    match(filter, selected) {
      const q = filter.trim().toLowerCase();
      return store.users.filter((u) => !q || u.full_name.toLowerCase().includes(q) || selected.includes(u.id));
    },
    toggle(list, id) {
      const i = list.indexOf(id);
      if (i < 0) list.push(id);
      else list.splice(i, 1);
    },
    personName(id) {
      const u = store.users.find((x) => x.id === id) || (this.doc && this.doc.signers.find((s) => s.id === id));
      return u ? u.full_name || u.name : '—';
    },
    hasSigned(id) {
      return !!this.doc && this.doc.signers.some((s) => s.id === id && s.signed_at);
    },
    // un semnatar cu contul dezactivat nu mai poate semna: lanțul rămâne blocat până este eliminat
    inactive(id) {
      const s = this.doc && this.doc.signers.find((x) => x.id === id);
      return !!s && !s.active && !s.signed_at;
    },
    away(id) {
      const a = !this.hasSigned(id) && absenceNow(id);
      if (!a) return '';
      const sub = a.substitute_id && userName(a.substitute_id);
      return a.kind.toLowerCase() + ' până la ' + fmtDay(a.to_date) + (sub ? '; semnează înlocuitorul, ' + sub : '; semnează la final');
    },
    dragLeave(e) {
      if (!e.currentTarget.contains(e.relatedTarget)) this.dragging = false;
    },
    move(i, step) {
      const list = this.form.signerIds;
      list.splice(i + step, 0, list.splice(i, 1)[0]);
    },
    tagStyle(c, t) {
      return this.form.tagIds.includes(t.id) ? { background: c.color, borderColor: c.color } : { borderColor: c.color, color: c.color };
    },
    // Fișierele se adună la fiecare alegere, deci se pot adăuga pe rând .docx, .pdf etc.
    addFiles(list) {
      for (const f of list) {
        if (this.newFiles.some((x) => x.name === f.name && x.size === f.size)) continue;
        if (this.newFiles.length >= 10) return toast('Cel mult 10 fișiere noi la o salvare.', true);
        if (f.size > 50 * 1024 * 1024) toast('„' + f.name + '” depășește 50 MB.', true);
        else this.newFiles.push(f);
      }
    },
    drop(e) {
      this.dragging = false;
      this.addFiles(e.dataTransfer.files);
    },
    async save() {
      const fd = new FormData();
      if (!this.form.title.trim()) return this.go(0);
      if (this.needsReview && !this.form.review_until) return toast('Alegeți termenul de avizare.', true);
      fd.append('data', JSON.stringify({ ...this.form, signerIds: this.needsSign ? this.form.signerIds : [], sign_until: this.needsSign ? this.form.sign_until : '', review_until: this.needsReview ? this.form.review_until : '', doc_date: this.noDate ? '' : this.form.doc_date }));
      for (const f of this.newFiles) fd.append('files', f);
      this.busy = true;
      try {
        const r = await api(this.doc ? '/api/documents/' + this.doc.id : '/api/documents', { method: this.doc ? 'PUT' : 'POST', form: fd });
        const note = mailNote(r.mail);
        toast(note || (this.doc ? 'Documentul a fost actualizat.' : 'Documentul a fost adăugat.'), !!note);
        await loadDocs();
        this.$emit('saved');
      } catch (e) {
        toast(e.message, true);
      }
      this.busy = false;
    },
  },
  template: /*html*/ `
    <Modal xl :title="doc ? 'Modifică documentul' : 'Document nou'" :busy="busy" @close="$emit('close')" @submit="submit">
      <div class="wizard">
        <ol class="wsteps" aria-label="Pașii formularului">
          <li v-for="(s, i) in steps" :key="i" class="stp" :class="{ cur: i === step, done: i < step || (i <= reached && i !== step && doc), open: i <= reached + 1 || doc || i === last }">
            <button type="button" :disabled="busy || !(i <= reached + 1 || doc || i === last)" :aria-current="i === step ? 'step' : null" @click="go(i)">
              <span class="stp-dot"><Icon v-if="i < step" name="check" /><Icon v-else :name="s.icon" /></span>
              <span class="stp-label">{{ s.label }}</span>
              <span class="stp-hint">{{ stepNotes[i] || s.hint }}</span>
            </button>
          </li>
        </ol>
        <div class="stp-bar" aria-hidden="true"><span :style="{ width: (step / last) * 100 + '%' }"></span></div>

        <div ref="pane" class="step-pane" :key="step">
          <!-- 1. date generale -->
          <template v-if="step === 0">
            <div class="pane-head"><span class="pane-ico"><Icon name="file" /></span><div><h3>Despre document</h3><p>Denumirea este obligatorie; data poate lipsi la formulare și modele.</p></div></div>
            <div class="fgrid4">
              <label class="field span4"><span>Denumirea documentului *</span><input v-model="form.title" class="big-input" maxlength="300" required autofocus placeholder="ex. Ordin privind concediile anuale" /></label>
              <div class="field datefield span2">
                <span><label for="doc-date">Data documentului{{ noDate ? '' : ' *' }}</label><label class="nodate"><input type="checkbox" v-model="noDate" /> fără dată</label></span>
                <input v-if="!noDate" id="doc-date" v-model="form.doc_date" type="date" required />
                <button v-else id="doc-date" type="button" class="nodate-box" title="Reveniți la o dată" @click="noDate = false">
                  <Icon name="file" /><span><b>Fără dată</b> · formular, model sau document de referință</span>
                </button>
              </div>
              <label class="field span2"><span>Număr de înregistrare <span class="opt">(opțional)</span></span><input v-model="form.number" maxlength="60" placeholder="ex. 15-P" /></label>
              <label class="field span4 mb0"><span>Descriere <span class="opt">(opțional)</span></span><textarea v-model="form.description" rows="4" maxlength="5000" placeholder="Pe scurt, despre ce este documentul — ajută la căutare"></textarea></label>
            </div>
          </template>

          <!-- 2. fișiere -->
          <template v-else-if="step === 1">
            <div class="pane-head"><span class="pane-ico"><Icon name="clip" /></span><div><h3>Fișierele documentului</h3><p>PDF, Word, Excel, imagini… cel mult 10 fișiere noi, câte 50 MB.</p></div><span v-if="fileCount" class="pill">{{ fileCount }}</span></div>
            <div class="drop big" :class="{ over: dragging }" role="button" tabindex="0" @keydown.enter.prevent="$refs.files.click()" @keydown.space.prevent="$refs.files.click()"
              @dragover.prevent="dragging = true" @dragleave="dragLeave" @drop.prevent="drop" @click="$refs.files.click()">
              <input ref="files" type="file" multiple hidden @change="addFiles($event.target.files); $event.target.value = ''" />
              <span class="drop-art" aria-hidden="true">
                <svg viewBox="0 0 120 90" fill="none">
                  <rect x="22" y="14" width="46" height="60" rx="7" transform="rotate(-9 45 44)" fill="#e8eff8" stroke="#b9cbe2" stroke-width="2"/>
                  <rect x="44" y="10" width="46" height="60" rx="7" fill="#fff" stroke="#1d4e89" stroke-width="2"/>
                  <path d="M54 26h26M54 34h26M54 42h16" stroke="#9db9dc" stroke-width="3" stroke-linecap="round"/>
                  <circle cx="88" cy="64" r="17" fill="#1d4e89"/>
                  <path d="M88 72V57M81 63l7-7 7 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <b>{{ dragging ? 'Eliberați pentru a atașa' : 'Trageți fișierele aici' }}</b>
              <span class="muted small">sau <span class="linklike">alegeți de pe calculator</span></span>
            </div>
            <ul v-if="fileCount" class="filelist cards">
              <li v-for="f in keptFiles" :key="'k' + f.id">
                <span class="ext" :class="kindOf(f.name)">{{ extName(f.name) || 'fișier' }}</span>
                <span class="fname">{{ f.name }}</span><span class="muted small">{{ fmtSize(f.size) }}</span>
                <button type="button" class="icon-btn danger" title="Elimină" aria-label="Elimină fișierul" @click="form.removeFileIds.push(f.id)"><Icon name="trash" /></button>
              </li>
              <li v-for="(f, i) in newFiles" :key="'n' + i">
                <span class="ext" :class="kindOf(f.name)">{{ extName(f.name) || 'fișier' }}</span>
                <span class="fname">{{ f.name }}</span><span class="badge new">nou</span><span class="muted small">{{ fmtSize(f.size) }}</span>
                <button type="button" class="icon-btn danger" title="Elimină" aria-label="Elimină fișierul" @click="newFiles.splice(i, 1)"><Icon name="trash" /></button>
              </li>
            </ul>
            <p v-else class="muted small hint center">Puteți continua și fără fișiere (ex. un document doar cu descriere) și le adăuga mai târziu.</p>
          </template>

          <!-- 3. etichete și acces -->
          <div v-else-if="step === 2" class="fgrid2">
            <section class="fsec">
              <div class="fsec-head"><span class="fnum"><Icon name="tag" /></span><div><h3>Etichete</h3><p>Ajută la găsirea documentului în listă</p></div><span v-if="form.tagIds.length" class="pill">{{ form.tagIds.length }}</span></div>
              <div v-if="!store.categories.length" class="muted small">Administratorul nu a definit încă nicio categorie.</div>
              <div v-for="c in store.categories" :key="c.id" class="pick-group">
                <div><i class="dot" :style="{ background: c.color }"></i>{{ c.name }}</div>
                <div class="pick">
                  <button v-for="t in c.tags" :key="t.id" type="button" :class="{ on: form.tagIds.includes(t.id) }" :style="tagStyle(c, t)" @click="toggle(form.tagIds, t.id)">{{ t.name }}</button>
                  <span v-if="!c.tags.length" class="muted small">fără etichete</span>
                </div>
              </div>
            </section>
            <section class="fsec">
              <div class="fsec-head"><span class="fnum"><Icon name="shield" /></span><div><h3>Acces</h3><p>Cine poate vedea documentul</p></div></div>
              <div class="choice-cards" role="radiogroup" aria-label="Cine poate vedea documentul">
                <button type="button" role="radio" :aria-checked="form.visibility === 'all' ? 'true' : 'false'" :class="{ on: form.visibility === 'all' }" @click="form.visibility = 'all'">
                  <Icon name="globe" /><b>Toți angajații</b><span>apare în lista tuturor</span>
                </button>
                <button type="button" role="radio" :aria-checked="form.visibility === 'restricted' ? 'true' : 'false'" :class="{ on: form.visibility === 'restricted' }" @click="form.visibility = 'restricted'">
                  <Icon name="lock" /><b>Doar cei selectați</b><span>subdiviziuni și persoane</span>
                </button>
              </div>
              <template v-if="form.visibility === 'restricted'">
                <div class="vis-cols mt10">
                  <div class="pickbox">
                    <div class="pickbox-head"><b class="small">Subdiviziuni</b><span class="muted small">{{ form.unitIds.length }}</span></div>
                    <div class="scroll">
                      <label v-for="u in units" :key="u.id" class="check" :style="{ paddingLeft: u.depth * 14 + 'px' }">
                        <input type="checkbox" :checked="form.unitIds.includes(u.id)" @change="toggle(form.unitIds, u.id)" /> {{ u.name }}
                      </label>
                    </div>
                  </div>
                  <div class="pickbox">
                    <div class="pickbox-head"><b class="small">Persoane</b><span class="muted small">{{ form.userIds.length }}</span></div>
                    <input v-model="userFilter" placeholder="Caută după nume…" @keydown.enter.prevent />
                    <div class="scroll">
                      <label v-for="u in people" :key="u.id" class="check">
                        <input type="checkbox" :checked="form.userIds.includes(u.id)" @change="toggle(form.userIds, u.id)" /> {{ u.full_name }}
                      </label>
                    </div>
                  </div>
                </div>
                <p class="muted small hint">O subdiviziune include automat și cele din subordinea ei. Autorul și administratorii văd documentul întotdeauna.</p>
              </template>
            </section>
          </div>

          <!-- 4. semnare și avizare -->
          <div v-else-if="step === 3" class="fgrid2">
            <section class="fsec" :class="{ active: needsSign }">
              <div class="fsec-head"><span class="fnum"><Icon name="pen" /></span><div><h3>Semnare</h3><p>Semnătură digitală, pe rând</p></div>
                <label class="switch" title="Documentul trebuie semnat digital"><input type="checkbox" v-model="needsSign" aria-label="Documentul trebuie semnat digital" /><span></span></label>
              </div>
              <template v-if="needsSign">
                <ol v-if="form.signerIds.length" class="signorder chain">
                  <li v-for="(id, i) in form.signerIds" :key="id" :class="{ signed: hasSigned(id) }">
                    <span class="step">{{ i + 1 }}</span>
                    <span class="fname">{{ personName(id) }} <span v-if="hasSigned(id)" class="muted small">(a semnat)</span><span v-else-if="inactive(id)" class="warn small">(cont dezactivat — eliminați sau înlocuiți)</span><span v-else-if="away(id)" class="warn small">(absent: {{ away(id) }})</span></span>
                    <button type="button" class="icon-btn" :disabled="i === 0" @click="move(i, -1)" title="Mută mai sus" aria-label="Mută mai sus">↑</button>
                    <button type="button" class="icon-btn" :disabled="i === form.signerIds.length - 1" @click="move(i, 1)" title="Mută mai jos" aria-label="Mută mai jos">↓</button>
                    <button type="button" class="icon-btn danger" :disabled="hasSigned(id)" @click="form.signerIds.splice(i, 1)" title="Elimină" aria-label="Elimină semnatarul"><Icon name="trash" /></button>
                  </li>
                </ol>
                <p v-else class="muted small">Adăugați semnatarii în ordinea în care trebuie să semneze.</p>
                <div class="pickbox mt10">
                  <input v-model="signFilter" placeholder="Adaugă semnatar: caută după nume…" @keydown.enter.prevent />
                  <div class="scroll short">
                    <button v-for="u in signCandidates" :key="u.id" type="button" class="side-item" @click="form.signerIds.push(u.id)">
                      <span>+ {{ u.full_name }} <span v-if="!u.email" class="muted small">(fără e-mail)</span><span v-if="away(u.id)" class="warn small">(absent: {{ away(u.id) }})</span></span>
                    </button>
                  </div>
                </div>
                <label class="field mt10 mb0 due-field"><span>Termen de semnare <span class="opt">(opțional)</span></span>
                  <span class="input-btn"><input v-model="form.sign_until" type="date" :min="doc ? undefined : today()" /><button v-if="form.sign_until" type="button" class="btn link sm" @click="form.sign_until = ''">Fără termen</button></span>
                </label>
                <p class="muted small hint">Fiecare semnatar semnează versiunea curentă, apoi vine rândul următorului. Cine este absent semnează la final, iar dacă are înlocuitor, semnează înlocuitorul. <template v-if="form.sign_until">Cu o zi înainte de termen și apoi zilnic, persoana aflată la rând primește o reamintire.</template> {{ mailHint }}</p>
              </template>
              <p v-else class="muted small hint">Activați dacă documentul trebuie semnat de una sau mai multe persoane, în ordine.</p>
            </section>
            <section class="fsec" :class="{ active: needsReview }">
              <div class="fsec-head"><span class="fnum"><Icon name="review" /></span><div><h3>Avizare</h3><p>Observații și propuneri în editor, până la termen</p></div>
                <label class="switch" title="Documentul este trimis spre avizare"><input type="checkbox" v-model="needsReview" aria-label="Documentul este trimis spre avizare" /><span></span></label>
              </div>
              <template v-if="needsReview">
                <label class="field mb0"><span>Termen de avizare (inclusiv)</span><input v-model="form.review_until" type="date" :min="doc ? undefined : today()" required /></label>
                <p class="muted small hint">{{ reviewHint }}</p>
              </template>
              <p v-else class="muted small hint">Activați pentru a cere observații: fiecare deschide fișierul în editor, pe rând. La documentele Word modificările apar ca propuneri, pe care le acceptați sau le respingeți.</p>
            </section>
          </div>

          <!-- 5. verificare -->
          <template v-else>
            <div class="pane-head"><span class="pane-ico ok"><Icon name="check" /></span><div><h3>{{ doc ? 'Verificați modificările' : 'Totul este pregătit' }}</h3><p>Verificați datele; „Modifică” vă duce înapoi la pasul respectiv.</p></div></div>
            <div class="review-grid">
              <div class="rv">
                <div class="rv-head"><Icon name="file" /><b>Document</b><button type="button" class="btn link sm" @click="go(0)">Modifică</button></div>
                <div class="rv-title">{{ form.title || '—' }}</div>
                <div class="muted small">{{ noDate ? 'fără dată' : fmtDay(form.doc_date) }}<template v-if="form.number"> · nr. {{ form.number }}</template></div>
                <p v-if="form.description" class="rv-desc">{{ form.description }}</p>
              </div>
              <div class="rv">
                <div class="rv-head"><Icon name="clip" /><b>Fișiere</b><button type="button" class="btn link sm" @click="go(1)">Modifică</button></div>
                <ul v-if="fileCount" class="rv-files">
                  <li v-for="f in keptFiles" :key="'k' + f.id"><span class="ext" :class="kindOf(f.name)">{{ extName(f.name) || 'fișier' }}</span>{{ f.name }}</li>
                  <li v-for="(f, i) in newFiles" :key="'n' + i"><span class="ext" :class="kindOf(f.name)">{{ extName(f.name) || 'fișier' }}</span>{{ f.name }} <span class="badge new">nou</span></li>
                </ul>
                <p v-else class="warn small">Niciun fișier atașat.</p>
              </div>
              <div class="rv">
                <div class="rv-head"><Icon name="shield" /><b>Etichete și acces</b><button type="button" class="btn link sm" @click="go(2)">Modifică</button></div>
                <div class="pick rv-tags">
                  <span v-for="t in chosenTags" :key="t.id" class="tagchip" :style="{ background: t.color }">{{ t.name }}</span>
                  <span v-if="!chosenTags.length" class="muted small">fără etichete</span>
                </div>
                <div class="rv-line"><Icon :name="form.visibility === 'all' ? 'globe' : 'lock'" />{{ accessText }}</div>
              </div>
              <div class="rv">
                <div class="rv-head"><Icon name="pen" /><b>Semnare și avizare</b><button type="button" class="btn link sm" @click="go(3)">Modifică</button></div>
                <ol v-if="signers.length" class="rv-chain">
                  <li v-for="(id, i) in signers" :key="id"><span class="step">{{ i + 1 }}</span>{{ personName(id) }}</li>
                </ol>
                <p v-else class="muted small">Fără semnare.</p>
                <div v-if="signers.length" class="rv-line"><Icon name="clock" />{{ form.sign_until ? 'Termen de semnare: ' + fmtDay(form.sign_until) : 'Fără termen de semnare' }}</div>
                <div class="rv-line"><Icon name="review" />{{ needsReview ? 'Avizare până la ' + fmtDay(form.review_until) + ' inclusiv' : 'Fără avizare' }}</div>
              </div>
            </div>
            <p v-if="signers.length" class="muted small hint center">{{ doc ? 'Dacă se schimbă persoana aflată la rând, ea este anunțată la salvare.' : 'La salvare, ' + personName(signers[0]) + ' este anunțat(ă) că trebuie să semneze.' }}</p>
          </template>
        </div>
      </div>
      <template #foot>
        <span class="foot-step muted small">Pasul {{ step + 1 }} din {{ steps.length }}</span>
        <button v-if="step === 0" type="button" class="btn" :disabled="busy" @click="$emit('close')">Anulează</button>
        <button v-else type="button" class="btn" :disabled="busy" @click="go(step - 1)"><Icon name="left" />Înapoi</button>
        <button v-if="doc && step < last" type="button" class="btn" :disabled="busy" @click="saveNow">Salvează acum</button>
        <button v-else-if="!doc && step > 0 && step < last - 1" type="button" class="btn ghost" :disabled="busy" @click="go(last)">Sari la verificare</button>
        <button class="btn primary" :disabled="busy">
          <template v-if="step < last">Înainte<Icon name="right" /></template>
          <template v-else>{{ busy ? 'Se salvează…' : doc ? 'Salvează modificările' : 'Adaugă documentul' }}</template>
        </button>
      </template>
    </Modal>`,
};

const EXT_KIND = { pdf: 'pdf', doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', xls: 'xls', xlsx: 'xls', csv: 'xls', png: 'img', jpg: 'img', jpeg: 'img', p7s: 'sig', asice: 'sig', sig: 'sig' };
const FileLink = {
  props: { file: Object },
  emits: ['open'],
  computed: {
    ext() {
      const m = /\.([a-z0-9]{1,5})$/i.exec(this.file.name);
      return m ? m[1].toLowerCase() : 'fișier';
    },
    kind() {
      return EXT_KIND[this.ext] || 'other';
    },
  },
  methods: { fmtSize },
  template: /*html*/ `
    <a class="file" :href="'/api/files/' + file.id" target="_blank" rel="noopener" @click="$emit('open')">
      <span class="ext" :class="kind">{{ ext }}</span><span class="fname">{{ file.name }}</span><span class="muted small">{{ fmtSize(file.size) }}</span>
    </a>`,
};

// ---------- Semnarea cu tokenul prin puntea FleetView ----------
// Browserul NU mai contactează MoldSign direct (MoldSign refuză originea aplicației, fiindcă
// nu e în lista STISC). În schimb trimite cererile agentului FleetView de pe calculator
// („tava"), care le retransmite către MoldSign cu originea permisă. Codul PIN se introduce
// tot în fereastra MoldSign — nimic nu se semnează fără el. Autentificarea față de tavă: un
// jeton de semnare obținut de la server după autentificare, pe care tava îl validează înapoi.
let SIGN_BRIDGE_URL = 'http://127.0.0.1:48625';
let signToken = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Obține o singură dată jetonul de semnare (legat de sesiune) și adresa punții.
async function ensureSignToken() {
  if (signToken) return signToken;
  const r = await api('/api/sign/token', { method: 'POST' });
  signToken = r.token;
  if (r.bridge) SIGN_BRIDGE_URL = r.bridge;
  return signToken;
}

// Pentru browser, orice eșec al cererii către punte arată la fel („nu răspunde”), deși cauzele diferă.
// Bulina verde din tavă înseamnă doar că agentul vorbește cu serverul FleetView, nu că puntea de semnare
// funcționează. Aici deosebim cauzele, ca mesajul să spună ce trebuie reparat pe acel calculator:
//  1. browserul a blocat accesul paginii la calculatorul local (permisiunea „rețea locală”);
//  2. nimic nu ascultă pe portul punții (puntea nu este activată în configurația agentului sau nu a pornit);
//  3. puntea răspunde, dar refuză adresa site-ului: agentul este configurat pentru altă adresă decât cea
//     din bara browserului (alt nume, IP, http/https sau port).
async function bridgeDiagnosis() {
  const origin = location.origin;
  const port = new URL(SIGN_BRIDGE_URL).port;
  // O cerere „no-cors” reușește dacă ceva ascultă pe port, chiar dacă puntea refuză apoi originea.
  let listening = false;
  try {
    await fetch(SIGN_BRIDGE_URL + '/certificates', { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    listening = true;
  } catch {}
  if (listening) {
    return `Agentul FleetView rulează, dar refuză acest site: este configurat pentru altă adresă decât ${origin}. Deschideți aplicația de la adresa folosită la instalarea agentului sau cereți administratorului să corecteze „emanagement_url” în C:\\ProgramData\\FleetView\\agent.config.json (trebuie să fie exact ${origin}), apoi să repornească serviciul FleetView.`;
  }
  // Nici sonda nu trece: fie browserul blochează accesul la calculatorul local (permisiunea „rețea locală”,
  // al cărei nume diferă între versiunile Chrome / Edge), fie puntea nu ascultă. Starea permisiunii contează
  // doar aici: o pagină deschisă chiar de pe calculator nu este supusă acestei permisiuni.
  if (navigator.permissions) {
    for (const name of ['local-network-access', 'loopback-network', 'local-network']) {
      try {
        if ((await navigator.permissions.query({ name })).state === 'denied') {
          return `Browserul a blocat accesul acestui site la calculatorul local, deci nu poate ajunge la agentul FleetView. Faceți clic pe lacătul din stânga adresei → Setări site → „Acces la rețeaua locală” (sau „Dispozitive locale”) → Permite, apoi reîncărcați pagina.`;
        }
      } catch {}
    }
  }
  return `Puntea de semnare FleetView nu răspunde pe acest calculator (portul ${port}). Bulina verde arată doar legătura cu serverul FleetView; semnarea mai cere ca în C:\\ProgramData\\FleetView\\agent.config.json să existe „emanagement_url”: „${origin}”, iar după modificare serviciul FleetView să fie repornit. Dacă setarea există, jurnalul agentului arată motivul (ex. „sign bridge cannot bind”).`;
}

// Trimite o cerere tăvii FleetView, cu jetonul de semnare ca Bearer. Dacă jetonul a
// expirat (401), cere unul nou și reîncearcă o singură dată: tava respinge cererea
// înainte de a o trimite la MoldSign, deci reîncercarea este sigură.
async function bridge(pathname, init = {}, retried = false) {
  const headers = { ...(init.headers || {}) };
  if (signToken) headers.Authorization = 'Bearer ' + signToken;
  let r;
  try {
    r = await fetch(SIGN_BRIDGE_URL + pathname, { ...init, headers, credentials: 'omit' });
  } catch {
    throw new Error(await bridgeDiagnosis());
  }
  if (r.status === 401) {
    signToken = null;
    if (!retried) {
      await ensureSignToken();
      return bridge(pathname, init, true);
    }
  }
  return r;
}
function moldsignError(r) {
  const e = r.headers.get('error') || '';
  if (/pin locked/i.test(e)) return 'Codul PIN al tokenului este blocat.';
  if (/puk locked/i.test(e)) return 'Codul PUK al tokenului este blocat.';
  if (/invalid pin/i.test(e)) return 'Codul PIN introdus este greșit.';
  if (r.status === 401 || r.status === 403) return e || 'Semnarea prin puntea FleetView a fost refuzată.';
  return 'MoldSign nu a putut semna documentul' + (e ? ' (' + e + ').' : '.');
}
async function moldsignCertificates() {
  const r = await bridge('/certificates?private_only=true');
  if (!r.ok) throw new Error(moldsignError(r));
  const d = await r.json().catch(() => ({}));
  return (d.certificateModel || []).filter((c) => c.privateKeyPresent !== false && !c.authority);
}
const dnField = (dn, key) => ((new RegExp('(?:^|,)\\s*' + key + '=([^,]+)', 'i').exec(dn || '') || [])[1] || '').trim();
const certLabel = (c) => c.certificateName || dnField(c.subjectDN, 'CN') || c.label || 'Certificat';
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('Fișierul nu a putut fi citit.'));
    fr.readAsDataURL(blob);
  });
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
// Trimite PDF-ul la MoldSign prin tavă (semnătură PAdES) și așteaptă versiunea semnată.
async function moldsignPdf(blob, cert) {
  const r = await bridge('/sign/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: await blobToBase64(blob), contentType: 'pdf', signFormat: 'PAdES', certificate: cert }),
  });
  if (!r.ok) throw new Error(moldsignError(r));
  // răspunsul indică adresa rezultatului: sign/data/{furnizor}/{sesiune}[/{tip}]
  const loc = r.headers.get('Location');
  if (!loc) throw new Error('MoldSign nu a întors rezultatul semnării.');
  let p = new URL(loc, SIGN_BRIDGE_URL).pathname.replace(/\/+$/, '');
  if (p.split('/').filter(Boolean).length === 4) p += '/pdf';
  // semnatarul introduce PIN-ul în fereastra MoldSign; așteptăm cel mult 5 minute
  for (let i = 0; i < 300; i++) {
    const g = await bridge(p, { headers: { Accept: 'application/json' } });
    if (g.ok) {
      const j = await g.json().catch(() => null);
      if (j && j.base64File) return base64ToBytes(j.base64File);
    } else if (![202, 204, 409].includes(g.status)) throw new Error(moldsignError(g));
    await sleep(1000);
  }
  throw new Error('Timpul pentru semnare a expirat. Reîncercați.');
}

// Rezultatul verificării semnăturilor din versiunea semnată (unul sau mai multe PDF-uri), calculat pe server.
// Ultima versiune conține toate semnăturile aplicate până acum, deci o singură verificare le arată pe toate.
const SIG_STATUS = { valid: 'Semnătură validă', warning: 'Validă, cu observații', invalid: 'Semnătură nevalidă' };
const SignatureCheck = {
  components: { Modal },
  props: { files: Array },
  emits: ['close'],
  data: () => ({ results: [] }),
  async mounted() {
    this.results = this.files.map((f) => ({ file: f, sigs: null, error: '' }));
    await Promise.all(
      this.results.map(async (r) => {
        try {
          r.sigs = (await api('/api/files/' + r.file.id + '/signatures')).signatures;
        } catch (e) {
          r.error = e.message;
        }
      })
    );
  },
  computed: {
    title() {
      return this.files.length === 1 ? 'Semnături: ' + this.files[0].name : 'Verificarea semnăturilor';
    },
  },
  methods: {
    label: (s) => SIG_STATUS[s.status],
    when: (d) => (d ? new Date(d).toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'short' }) : ''),
    day: (d) => (d ? new Date(d).toLocaleDateString('ro-RO') : ''),
  },
  template: /*html*/ `
    <Modal :title="title" wide ok-label="Închide" cancel-label="" @close="$emit('close')" @submit="$emit('close')">
      <div v-for="r in results" :key="r.file.id" class="sigfile">
        <div v-if="files.length > 1" class="section-title">{{ r.file.name }}</div>
        <p v-if="r.error" class="warn">{{ r.error }}</p>
        <p v-else-if="!r.sigs" class="muted">Se verifică…</p>
        <p v-else-if="!r.sigs.length" class="muted">Fișierul nu conține semnături electronice.</p>
        <div v-for="s in r.sigs || []" :key="s.index" class="sigcheck" :class="s.status">
          <div class="sigcheck-head"><b>{{ s.index }}. {{ s.signer || 'Semnatar necunoscut' }}</b><span class="sigstatus">{{ label(s) }}</span></div>
          <div class="small">
            <span v-if="s.idnp">IDNP/cod: {{ s.idnp }} · </span><span v-if="s.organization">{{ s.organization }} · </span>
            <span v-if="s.timestamp && s.timestamp.ok">marcă temporală {{ when(s.timestamp.time) }}</span>
            <span v-else-if="s.signingTime">semnat la {{ when(s.signingTime) }} (ora calculatorului semnatarului)</span>
          </div>
          <div v-if="s.chain && s.chain.length" class="small muted">Certificat: {{ s.chain.join(' → ') }}<template v-if="s.validTo">, valabil până la {{ day(s.validTo) }}</template></div>
          <ul v-if="s.problems.length" class="sigproblems"><li v-for="p in s.problems" :key="p">{{ p }}</li></ul>
          <ul class="signotes small muted"><li v-for="n in s.notes" :key="n">{{ n }}</li></ul>
        </div>
      </div>
    </Modal>`,
};

// Datele din baza de date sunt în UTC ('AAAA-LL-ZZ OO:MM:SS'); le afișăm în ora locală.
const fmtDateTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'short' });

const isPdfName = (n) => /\.pdf$/i.test(n);
// Rândul din listă arată doar esențialul, pe coloane fixe (data, denumirea, starea, numărul de fișiere);
// detaliile, fișierele, semnarea și acțiunile apar la extinderea rândului.
const DOC_TAGS_IN_ROW = 3;

// ---------- editorul de documente (ONLYOFFICE) ----------
// Scriptul editorului vine de pe serverul de documente din rețeaua internă și se încarcă o singură dată.
let docsApiLoad = null;
function loadDocsApi(url) {
  if (window.DocsAPI) return Promise.resolve();
  if (docsApiLoad && docsApiLoad.url === url) return docsApiLoad.p;
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => (window.DocsAPI ? resolve() : reject(new Error('Scriptul editorului s-a încărcat, dar nu este cel așteptat. Verificați adresa serverului de documente din „Setări”.')));
    s.onerror = () => {
      docsApiLoad = null;
      s.remove();
      reject(new Error('Serverul de documente nu răspunde (' + new URL(url).origin + '). Verificați că este pornit și că adresa din „Setări” este corectă.'));
    };
    document.head.appendChild(s);
  });
  docsApiLoad = { url, p };
  return p;
}

// Fereastra editorului, pe tot ecranul. Cine o deschide primul poate modifica fișierul; ceilalți îl văd
// doar pentru citire și sunt anunțați când se eliberează. Semnalul de viață (la 30 s) păstrează blocarea.
const OfficeEditor = {
  components: { Icon },
  props: { fileId: Number },
  emits: ['close'],
  data: () => ({ info: null, error: '', ready: false, canTake: false, lost: false }),
  computed: {
    state() {
      const i = this.info;
      if (!i) return null;
      if (i.mode === 'edit' && i.review) {
        return {
          label: 'Avizare · modificări urmărite',
          cls: 'amber',
          icon: 'review',
          note: 'Modificările dvs. apar ca propuneri; autorul le acceptă sau le respinge.' + (i.reviewUntil ? ' Termen: ' + fmtDay(i.reviewUntil) + '.' : '') + ' Se salvează automat.',
        };
      }
      if (i.mode === 'edit') return { label: 'Editare', cls: 'green', icon: 'edit', note: 'Cât timp editorul este deschis, ceilalți văd fișierul doar pentru citire. Modificările se salvează automat.' };
      return { label: 'Doar citire', cls: 'gray', icon: 'lock', note: i.reason || '' };
    },
  },
  async mounted() {
    this.onKey = (e) => e.key === 'Escape' && !this.editor && this.close();
    document.addEventListener('keydown', this.onKey);
    document.body.classList.add('noscroll');
    await this.open(false);
    this.timer = setInterval(() => this.beat(), 30000);
  },
  beforeUnmount() {
    clearInterval(this.timer);
    document.removeEventListener('keydown', this.onKey);
    document.body.classList.remove('noscroll');
    this.destroy();
  },
  methods: {
    async open(viewOnly) {
      this.destroy();
      Object.assign(this, { ready: false, error: '', canTake: false, lost: false });
      try {
        const info = await api('/api/office/' + this.fileId + '/config' + (viewOnly ? '?view=1' : ''));
        this.info = info;
        await loadDocsApi(info.scriptUrl);
        // editorul înlocuiește elementul primit cu propriul iframe, deci îi dăm unul pe care Vue nu îl gestionează
        const host = this.$refs.host;
        if (!host) return;
        host.textContent = '';
        const ph = document.createElement('div');
        ph.id = 'oo-' + this.fileId + '-' + Date.now();
        host.appendChild(ph);
        this.editor = new window.DocsAPI.DocEditor(ph.id, {
          ...info.config,
          width: '100%',
          height: '100%',
          type: 'desktop',
          events: {
            onAppReady: () => (this.ready = true),
            onDocumentReady: () => (this.ready = true),
            onError: (e) => (this.error = 'Editorul a raportat o eroare: ' + ((e && e.data && e.data.errorDescription) || 'necunoscută') + '.'),
          },
        });
      } catch (e) {
        this.error = e.message;
      }
    },
    destroy() {
      if (!this.editor) return;
      try {
        this.editor.destroyEditor();
      } catch {}
      this.editor = null;
    },
    async beat() {
      if (!this.info || this.error) return;
      try {
        const r = await api('/api/office/' + this.fileId + '/heartbeat', { method: 'POST', body: { editing: this.info.mode === 'edit' } });
        if (this.info.mode === 'edit') this.lost = !r.mine;
        else {
          this.canTake = !!r.free;
          if (r.lockedBy) this.info.reason = r.lockedBy.name + ' lucrează acum la acest fișier.';
          else if (r.free) this.info.reason = 'Fișierul s-a eliberat: îl puteți deschide pentru editare.';
        }
      } catch {}
    },
    close() {
      const editing = this.info && this.info.mode === 'edit';
      this.$emit('close');
      // serverul de documente salvează la câteva secunde după închidere; reîmprospătăm apoi lista
      if (editing) {
        toast('Modificările se salvează automat în câteva secunde.');
        setTimeout(() => loadDocs().catch(() => {}), 12000);
        setTimeout(() => loadDocs().catch(() => {}), 30000);
      }
    },
  },
  template: /*html*/ `
    <div class="oo-overlay" role="dialog" aria-modal="true" :aria-label="'Editor: ' + (info ? info.name : '')">
      <header class="oo-bar">
        <div class="oo-title">
          <b :title="info ? info.name : ''">{{ info ? info.name : 'Se deschide documentul…' }}</b>
          <span v-if="info" class="small" :title="info.title">{{ info.title }}</span>
        </div>
        <span v-if="state" class="pill" :class="state.cls"><Icon :name="state.icon" />{{ state.label }}</span>
        <span v-if="lost" class="oo-note warn small">Legătura s-a întrerupt prea mult timp; închideți și redeschideți fișierul ca să nu lucrați în paralel cu altcineva.</span>
        <span v-else-if="state && state.note" class="oo-note small">{{ state.note }}</span>
        <button v-if="canTake" type="button" class="btn sm primary" @click="open(false)"><Icon name="edit" />Deschide pentru editare</button>
        <button type="button" class="btn sm" @click="close">Închide</button>
      </header>
      <div class="oo-body">
        <div ref="host" class="oo-host"></div>
        <div v-if="error" class="oo-msg"><div class="card oo-err"><b>Editorul nu s-a putut deschide</b><p class="muted">{{ error }}</p><button type="button" class="btn" @click="open(false)">Reîncearcă</button></div></div>
        <div v-else-if="!ready" class="oo-msg"><span class="spinner"></span>Se încarcă editorul…</div>
      </div>
    </div>`,
};

// Versiunile anterioare ale unui fișier modificat în editor (fiecare salvare păstrează versiunea dinainte).
const FileVersions = {
  components: { Modal },
  props: { file: Object },
  emits: ['close'],
  data: () => ({ list: null }),
  async mounted() {
    try {
      this.list = await api('/api/files/' + this.file.id + '/versions');
    } catch (e) {
      toast(e.message, true);
      this.$emit('close');
    }
  },
  methods: { fmtSize, fmtDateTime },
  template: /*html*/ `
    <Modal :title="'Versiuni: ' + file.name" ok-label="Închide" cancel-label="" @close="$emit('close')" @submit="$emit('close')">
      <div class="vlist">
        <div class="vrow current">
          <span class="vnum">v{{ file.version }}</span>
          <span class="vtxt"><b>Versiunea curentă</b><span class="muted small">{{ file.edited_by_name ? 'modificată de ' + file.edited_by_name : 'originalul' }}<template v-if="file.edited_at">, {{ fmtDateTime(file.edited_at) }}</template> · {{ fmtSize(file.size) }}</span></span>
          <a class="btn sm" :href="'/api/files/' + file.id + '?download=1'">Descarcă</a>
        </div>
        <div v-if="!list" class="vrow"><span class="spinner"></span></div>
        <div v-for="v in list || []" :key="v.id" class="vrow">
          <span class="vnum">v{{ v.version }}</span>
          <span class="vtxt"><b>{{ v.version === 1 ? 'Originalul' : 'Versiunea ' + v.version }}</b><span class="muted small">{{ v.edited_by_name ? 'modificată de ' + v.edited_by_name : 'încărcată la adăugare' }}<template v-if="v.created_at">, {{ fmtDateTime(v.created_at) }}</template> · {{ fmtSize(v.size) }}</span></span>
          <a class="btn sm" :href="'/api/file-versions/' + v.id">Descarcă</a>
        </div>
      </div>
      <p class="muted small hint">Pentru a reveni la o versiune veche, descărcați-o și încărcați-o din nou din „Modifică”.</p>
    </Modal>`,
};

const DocCard = {
  components: { FileLink, Modal, SignatureCheck, Icon, FileVersions },
  // selectable: modul de selecție multiplă (bifa din stânga); selected: bifat
  props: { doc: Object, startOpen: Boolean, selectable: Boolean, selected: Boolean },
  emits: ['edit', 'select'],
  data() {
    return { open: this.startOpen, busy: false, reminding: false, signing: '', certPick: null, verifying: null, versionsOf: null };
  },
  computed: {
    store: () => store,
    tags: () => tagIndex(),
    validTags() {
      return this.doc.tagIds.filter((id) => this.tags.has(id));
    },
    shownTags() {
      return this.validTags.slice(0, DOC_TAGS_IN_ROW);
    },
    hiddenTags() {
      return Math.max(0, this.validTags.length - DOC_TAGS_IN_ROW);
    },
    fileCount() {
      return this.originals.length + this.signedLatest.length;
    },
    fullDate() {
      const d = this.doc.doc_date;
      if (!d) return 'Fără dată (formular, model sau document de referință)';
      return Number(d.slice(8)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
    },
    // o singură stare pe rând, în ordinea importanței
    status() {
      const d = this.doc;
      if (d.mySign === 'pending') return { label: 'De semnat de dvs.', cls: isOverdue(d) ? 'red solid' : 'amber solid', icon: 'pen', title: dueText(d) ? 'De semnat de dvs. · ' + dueText(d) : '' };
      if (d.signers.length && d.signers.some((s) => !s.active && !s.signed_at)) return { label: 'Semnare blocată', cls: 'red' };
      if (isOverdue(d)) return { label: 'Termen depășit', cls: 'red', icon: 'clock', title: 'Semnare ' + (d.signers.length - this.pending) + '/' + d.signers.length + ' · ' + dueText(d) };
      if (d.reviewOpen) return { label: 'Avizare · ' + fmtDay(d.review_until).slice(0, 5), cls: '', icon: 'review', title: 'În avizare până la ' + fmtDay(d.review_until) + ' inclusiv' };
      if (d.signers.length && this.pending) return { label: 'Semnare ' + (d.signers.length - this.pending) + '/' + d.signers.length, cls: 'amber', icon: isDueSoon(d) ? 'clock' : '', title: dueText(d) ? 'Semnare în curs · ' + dueText(d) : '' };
      if (d.signers.length) return { label: 'Semnat', cls: 'green', icon: 'pen' };
      if (d.visibility === 'restricted') return { label: 'Acces limitat', cls: 'gray', icon: 'lock' };
      return null;
    },
    // semnez ca înlocuitor al persoanei aflate la rând
    behalf() {
      const d = this.doc;
      return d.mySign === 'pending' && d.signTurn !== store.me.id ? d.signers.find((s) => s.id === d.signTurn) || null : null;
    },
    overdue() {
      return isOverdue(this.doc);
    },
    pending() {
      return this.doc.signers.filter((s) => !s.signed_at).length;
    },
    // ordinea în care se semnează efectiv: cine a semnat, cei prezenți (sau cu înlocuitor), apoi cei absenți
    chain() {
      const sig = this.doc.signers;
      const skipped = (s) => s.absent && !s.absent.substitute_id;
      return [...sig.filter((s) => s.signed_at), ...sig.filter((s) => !s.signed_at && !skipped(s)), ...sig.filter((s) => !s.signed_at && skipped(s))];
    },
    originals() {
      return this.doc.files.filter((f) => !f.signed_by_name);
    },
    // Ultima versiune semnată (se păstrează doar aceasta; documentele mai vechi pot avea și versiuni intermediare).
    signedLatest() {
      const signed = this.doc.files.filter((f) => f.signed_by_name);
      if (!signed.length) return [];
      const last = signed[signed.length - 1];
      return signed.filter((f) => f.signed_by === last.signed_by && f.created_at === last.created_at);
    },
    signedPdfs() {
      return this.signedLatest.filter((f) => isPdfName(f.name));
    },
    // Versiunea care trebuie semnată acum: ultima versiune semnată sau, dacă nu a semnat nimeni, originalele.
    latest() {
      return this.signedLatest.length ? this.signedLatest : this.originals;
    },
    // MoldSign semnează doar PDF-uri; pentru alte formate rămâne încărcarea manuală
    canToken() {
      return this.latest.length > 0 && this.latest.every((f) => isPdfName(f.name));
    },
    hasSignatures() {
      return this.doc.signers.some((s) => s.signed_at);
    },
  },
  methods: {
    fmtDay,
    dueText,
    toggleFav,
    // butonul din dreptul fișierului: serverul decide oricum dreptul real la deschidere
    inEditor(f) {
      return !!store.me.office && OFFICE_VIEW.includes(extName(f.name));
    },
    canModify(f) {
      const d = this.doc;
      return this.inEditor(f) && OFFICE_EDIT.includes(extName(f.name)) && !f.signed_by_name && !this.hasSignatures && (d.canEdit || d.reviewOpen);
    },
    openEditor(f) {
      store.editor = { fileId: f.id };
    },
    chipStyle,
    docDay,
    docMon,
    visLabel,
    fmtDateTime,
    signerTitle(s) {
      if (s.signed_at) return (s.signed_by_name ? 'Semnat de ' + s.signed_by_name + ' (înlocuitor), ' : 'A semnat la ') + fmtDateTime(s.signed_at);
      if (!s.active) return 'Cont dezactivat: lanțul de semnare este blocat';
      const a = s.absent;
      if (a && a.substitute_id) return (s.id === this.doc.signTurn ? 'La rând · semnează ' : 'Absent · înlocuit de ') + a.substitute_name;
      const away = a ? 'Absent până la ' + fmtDay(a.to_date) : '';
      if (s.id === this.doc.signTurn) return away ? away + ' · este la rând' : 'Este la rând';
      return away || 'Așteaptă';
    },
    signerHint(s) {
      const a = !s.signed_at && s.absent;
      if (!a) return null;
      return 'Persoană absentă: ' + a.kind.toLowerCase() + ' până la ' + fmtDay(a.to_date) + '. ' + (a.substitute_id ? 'Semnează în locul ei ' + a.substitute_name + '.' : 'Semnează după ceilalți, când revine.');
    },
    // serverul marchează documentul ca văzut când se deschide un fișier; reîmprospătăm lista puțin mai târziu
    opened() {
      if (this.doc.unseen) setTimeout(() => loadDocs().catch(() => {}), 800);
    },
    markSeen() {
      run(async () => {
        await api('/api/documents/' + this.doc.id + '/seen', { method: 'POST' });
        await loadDocs();
      });
    },
    async uploadSigned(e) {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      const names = files.map((f) => f.name).join(', ');
      const big = files.find((f) => f.size > 50 * 1024 * 1024);
      if (big) return toast('„' + big.name + '” depășește limita de 50 MB.', true);
      if (files.length > 10) return toast('Cel mult 10 fișiere la o încărcare.', true);
      const ok = await ask({
        title: 'Încărcați versiunea semnată?',
        message: '„' + names + '” va fi înregistrat ca versiune semnată de dvs.' + (this.behalf ? ', în locul lui ' + this.behalf.name : '') + '. După încărcare, documentul trece la următorul semnatar.',
        okLabel: 'Încarcă',
      });
      if (!ok) return;
      this.busy = true;
      try {
        await this.sendSigned(files);
        toast(this.lastNote || 'Versiunea semnată a fost încărcată.', !!this.lastNote);
      } catch (err) {
        toast(err.message, true);
      }
      this.busy = false;
    },
    async sendSigned(files, data) {
      const fd = new FormData();
      if (data) fd.append('data', JSON.stringify(data));
      for (const f of files) fd.append('files', f);
      const r = await api('/api/documents/' + this.doc.id + '/sign', { method: 'POST', form: fd });
      this.lastNote = mailNote(r.mail);
      await loadDocs();
    },
    // Semnarea cu tokenul: alegerea certificatului, semnarea fiecărui PDF în MoldSign, apoi încărcarea.
    async signWithToken() {
      this.busy = true;
      this.signing = 'Se contactează MoldSign…';
      try {
        await ensureSignToken();
        const certs = await moldsignCertificates();
        if (!certs.length) throw new Error('MoldSign nu găsește niciun certificat de semnare. Conectați tokenul și reîncercați.');
        const names = this.latest.map((f) => f.name).join(', ');
        const cert = await new Promise((resolve) => (this.certPick = { certs, chosen: 0, names, resolve }));
        if (!cert) return;
        const signed = [];
        for (const f of this.latest) {
          this.signing = 'Introduceți PIN-ul în fereastra MoldSign…';
          const res = await fetch('/api/files/' + f.id + '?download=1', { credentials: 'same-origin' });
          if (!res.ok) throw new Error('„' + f.name + '” nu a putut fi descărcat.');
          const bytes = await moldsignPdf(await res.blob(), cert);
          signed.push(new File([bytes], f.name, { type: 'application/pdf' }));
        }
        this.signing = 'Se încarcă versiunea semnată…';
        await this.sendSigned(signed, { method: 'moldsign' });
        toast(this.lastNote || 'Documentul a fost semnat cu MoldSign.', !!this.lastNote);
      } catch (err) {
        toast(err.message, true);
      } finally {
        this.busy = false;
        this.signing = '';
        this.certPick = null;
      }
    },
    pickCert(ok) {
      const p = this.certPick;
      this.certPick = null;
      if (p) p.resolve(ok ? p.certs[p.chosen] : null);
    },
    certLabel,
    certIssuer: (c) => dnField(c.issuerDN, 'CN'),
    isPdfName,
    async remind() {
      this.reminding = true;
      try {
        const r = await api('/api/documents/' + this.doc.id + '/remind', { method: 'POST' });
        const note = mailNote(r.mail);
        toast(note || 'Notificarea a fost retrimisă pe e-mail.', !!note);
      } catch (e) {
        toast(e.message, true);
      }
      this.reminding = false;
    },
    async remove() {
      const ok = await ask({
        title: 'Ștergeți documentul?',
        message: '„' + this.doc.title + '” va fi șters definitiv, împreună cu toate fișierele atașate. Acțiunea nu poate fi anulată.',
        okLabel: 'Șterge definitiv',
        danger: true,
      });
      if (!ok) return;
      await run(async () => {
        await api('/api/documents/' + this.doc.id, { method: 'DELETE' });
        await loadDocs();
      }, 'Documentul a fost șters.');
    },
  },
  template: /*html*/ `
    <article class="dcard" :class="{ unseen: doc.unseen, open, turn: doc.mySign === 'pending', late: overdue && doc.mySign === 'pending', selmode: selectable, picked: selected }">
      <label v-if="selectable" class="dpick" :title="selected ? 'Deselectează' : 'Selectează'"><input type="checkbox" :checked="selected" @change="$emit('select', doc)" :aria-label="'Selectează ' + doc.title" /></label>
      <button type="button" class="drow" :aria-expanded="open ? 'true' : 'false'" @click="selectable ? $emit('select', doc) : (open = !open)">
        <span v-if="doc.doc_date" class="d-date"><b>{{ docDay(doc) }}</b><span>{{ docMon(doc) }}</span></span>
        <span v-else class="d-date nodate" title="Document fără dată (formular, model, document de referință)"><Icon name="file" /><span>fără dată</span></span>
        <span class="d-main">
          <span class="d-title" :title="doc.title"><i v-if="doc.unseen" class="d-dot" title="Document nou"></i><Icon v-if="doc.fav" name="star" class="d-star" />{{ doc.title }}</span>
          <span class="d-sub">
            <span v-if="doc.number" class="d-nr">nr. {{ doc.number }}</span>
            <span v-if="!doc.doc_date" class="d-kind">formular / model</span>
            <span v-if="doc.sign_until && doc.signers.some((s) => !s.signed_at)" class="d-due" :class="{ late: overdue }"><Icon name="clock" />{{ dueText(doc) }}</span>
            <template v-for="id in shownTags" :key="id"><span class="chip" :style="chipStyle(tags.get(id).color)">{{ tags.get(id).name }}</span></template>
            <span v-if="hiddenTags" class="chip more">+{{ hiddenTags }}</span>
          </span>
        </span>
        <span class="d-status"><span v-if="status" class="pill" :class="status.cls" :title="status.title || status.label"><Icon v-if="status.icon" :name="status.icon" />{{ status.label }}</span></span>
        <span class="d-files" :title="fileCount ? fileCount + (fileCount === 1 ? ' fișier' : ' fișiere') : 'Fără fișiere'"><Icon name="clip" /><b>{{ fileCount }}</b></span>
        <span class="d-chev"><Icon name="chevron" /></span>
      </button>

      <div v-if="open" class="dpanel">
        <div class="dgrid">
          <section class="dsec">
            <h4><Icon name="file" />Fișiere</h4>
            <div v-if="originals.length" class="dfiles">
              <div v-for="f in originals" :key="f.id" class="dfile">
                <FileLink :file="f" @open="opened" />
                <button v-if="inEditor(f)" type="button" class="btn sm" :class="{ primary: canModify(f) && !doc.canEdit }" @click="openEditor(f)">
                  <template v-if="canModify(f)"><Icon :name="doc.canEdit ? 'edit' : 'review'" />{{ doc.canEdit ? 'Editează' : 'Avizează' }}</template>
                  <template v-else><Icon name="eye" />Deschide</template>
                </button>
                <button v-if="f.version > 1" type="button" class="icon-btn" title="Versiuni anterioare" aria-label="Versiuni anterioare" @click="versionsOf = f"><Icon name="history" /></button>
                <span v-if="f.version > 1" class="dfile-meta">v{{ f.version }} · modificat de {{ f.edited_by_name || '—' }}<template v-if="f.edited_at">, {{ fmtDateTime(f.edited_at) }}</template></span>
              </div>
            </div>
            <p v-else class="muted small">Nu sunt fișiere atașate.</p>
            <p v-if="doc.reviewOpen && !doc.canEdit && store.me.office && !hasSignatures" class="review-note small"><Icon name="review" />În avizare până la {{ fmtDay(doc.review_until) }}. Apăsați „Avizează”: modificările dvs. apar ca propuneri pentru autor.</p>
            <template v-if="signedLatest.length">
              <h4 class="mt14"><Icon name="pen" />Versiunea semnată</h4>
              <div class="dfiles"><FileLink v-for="f in signedLatest" :key="f.id" :file="f" @open="opened" /></div>
              <p class="muted small mt4">Încărcată de {{ signedLatest[0].signed_by_name }}<template v-if="signedLatest[0].created_at">, {{ fmtDateTime(signedLatest[0].created_at) }}</template></p>
            </template>
          </section>
          <section class="dsec">
            <h4><Icon name="tag" />Detalii</h4>
            <dl class="dmeta">
              <dt>Data</dt><dd>{{ fullDate }}</dd>
              <dt>Număr</dt><dd>{{ doc.number || '—' }}</dd>
              <dt>Adăugat de</dt><dd>{{ doc.author || '—' }}</dd>
              <dt>Acces</dt><dd>{{ visLabel(doc) }}</dd>
              <template v-if="doc.sign_until"><dt>Termen</dt><dd :class="{ 'warn-text': overdue }">{{ fmtDay(doc.sign_until) }}<template v-if="overdue"> · depășit</template></dd></template>
              <template v-if="doc.review_until"><dt>Avizare</dt><dd>{{ doc.reviewOpen ? 'deschisă până la ' + fmtDay(doc.review_until) + ' inclusiv' : 'încheiată (termen ' + fmtDay(doc.review_until) + ')' }}</dd></template>
              <dt>Etichete</dt>
              <dd>
                <span v-if="!validTags.length" class="muted">—</span>
                <span v-else class="dchips"><span v-for="id in validTags" :key="id" class="chip" :style="chipStyle(tags.get(id).color)">{{ tags.get(id).name }}</span></span>
              </dd>
            </dl>
            <p v-if="doc.description" class="ddesc">{{ doc.description }}</p>
          </section>
        </div>

        <section v-if="doc.signers.length" class="dsec dsign" :class="{ done: !pending }">
          <h4><Icon name="pen" />Semnare <span class="pill" :class="pending ? 'amber' : 'green'">{{ doc.signers.length - pending }} din {{ doc.signers.length }}</span></h4>
          <ol class="stepper">
            <li v-for="(s, i) in chain" :key="s.id" :class="{ ok: s.signed_at, turn: s.id === doc.signTurn, blocked: !s.active && !s.signed_at, away: s.absent && !s.signed_at }">
              <span class="st-dot">{{ s.signed_at ? '✓' : i + 1 }}</span>
              <span class="st-txt" :title="signerHint(s) || signerTitle(s)"><b>{{ s.name }}</b><span class="small">{{ signerTitle(s) }}</span></span>
            </li>
          </ol>
          <div v-if="doc.mySign === 'pending'" class="myturn">
            <div class="myturn-txt">
              <b v-if="behalf">Semnați în locul lui {{ behalf.name }}<template v-if="behalf.absent">, absent până la {{ fmtDay(behalf.absent.to_date) }}</template>.</b>
              <b v-else>Este rândul dvs. să semnați.</b>
              <span v-if="doc.sign_until" class="small" :class="overdue ? 'warn-text' : 'muted'"><Icon name="clock" class="inline-ico" />{{ dueText(doc) }}</span>
              <span class="muted small">{{ canToken ? 'Semnați cu tokenul prin MoldSign sau încărcați fișierul semnat în altă aplicație.' : 'Descărcați versiunea curentă, semnați-o digital, apoi încărcați fișierul semnat.' }}</span>
            </div>
            <div class="myturn-act">
              <input ref="signed" type="file" multiple hidden @change="uploadSigned" />
              <button type="button" class="btn" :class="{ primary: !canToken }" :disabled="busy" @click="$refs.signed.click()"><Icon name="upload" />{{ busy && !signing ? 'Se încarcă…' : 'Încarcă fișierul semnat' }}</button>
              <button v-if="canToken" type="button" class="btn primary" :disabled="busy" @click="signWithToken"><Icon name="pen" />{{ signing || 'Semnează cu MoldSign' }}</button>
            </div>
          </div>
        </section>

        <footer class="dfoot">
          <div class="dfoot-side">
            <button type="button" class="btn sm fav-btn" :class="{ on: doc.fav }" :aria-pressed="doc.fav ? 'true' : 'false'" @click="toggleFav(doc)"><Icon name="star" />{{ doc.fav ? 'Favorit' : 'Adaugă la favorite' }}</button>
            <button v-if="signedPdfs.length" type="button" class="btn sm" @click="verifying = signedPdfs">Verifică semnăturile</button>
            <button v-if="doc.canEdit && pending && store.me.mailEnabled" type="button" class="btn sm" :disabled="reminding" @click="remind">Retrimite e-mailul</button>
          </div>
          <div class="dfoot-side">
            <button v-if="doc.unseen" type="button" class="btn sm" @click="markSeen">Marchează ca văzut</button>
            <button v-if="doc.canEdit" type="button" class="btn sm" @click="$emit('edit', doc)"><Icon name="edit" />Modifică</button>
            <button v-if="doc.canDelete" type="button" class="btn sm danger" @click="remove"><Icon name="trash" />Șterge</button>
          </div>
        </footer>
      </div>

      <Modal v-if="certPick" title="Semnare cu MoldSign" ok-label="Semnează" @close="pickCert(false)" @submit="pickCert(true)">
        <p class="dialog-msg">„{{ certPick.names }}” va fi semnat electronic. După ce apăsați „Semnează”, MoldSign vă cere codul PIN al tokenului.</p>
        <div class="section-title">Certificatul de semnare</div>
        <label v-for="(c, i) in certPick.certs" :key="i" class="check certopt">
          <input type="radio" name="cert" :value="i" v-model="certPick.chosen" />
          <span><b>{{ certLabel(c) }}</b><span class="muted small"><template v-if="certIssuer(c)"> · emis de {{ certIssuer(c) }}</template></span></span>
        </label>
      </Modal>
      <SignatureCheck v-if="verifying" :files="verifying" @close="verifying = null" />
      <FileVersions v-if="versionsOf" :file="versionsOf" @close="versionsOf = null" />
    </article>`,
};

// Categoriile deschise în bara laterală se țin minte în browser, separat pentru fiecare cont
// (implicit toate sunt restrânse). Fără acces la localStorage, pur și simplu nu se păstrează.
const openCatsKey = () => 'ansc.openCats.' + store.me.id;
function readOpenCats() {
  try {
    const v = JSON.parse(localStorage.getItem(openCatsKey()) || '[]');
    return Array.isArray(v) ? v.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}
function writeOpenCats(ids) {
  try {
    localStorage.setItem(openCatsKey(), JSON.stringify(ids));
  } catch {}
}

const DocsView = {
  components: { DocForm, DocCard, Icon, EmptyState },
  data: () => ({ sel: { type: 'all', id: null }, year: '', q: '', editing: undefined, openCats: readOpenCats(), selecting: false, picked: [] }),
  // tasta „/” duce la căutare (când nu se scrie deja într-un câmp și nu este deschisă o fereastră)
  mounted() {
    this.slash = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || modalStack.length) return;
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      this.$refs.search.focus();
    };
    document.addEventListener('keydown', this.slash);
  },
  unmounted() {
    document.removeEventListener('keydown', this.slash);
  },
  computed: {
    store: () => store,
    docs: () => store.docs,
    canAdd: () => store.me.role !== 'user',
    tags: () => tagIndex(),
    // anii, cu numărul de documente din fiecare; documentele fără dată au propria opțiune
    years() {
      const n = new Map();
      for (const d of this.docs) if (d.doc_date) n.set(d.doc_date.slice(0, 4), (n.get(d.doc_date.slice(0, 4)) || 0) + 1);
      return [...n].map(([year, count]) => ({ year, count }));
    },
    undatedCount() {
      return this.docs.filter((d) => !d.doc_date).length;
    },
    favCount() {
      return this.docs.filter((d) => d.fav).length;
    },
    pickedDocs() {
      const ids = new Set(this.picked);
      return this.docs.filter((d) => ids.has(d.id));
    },
    pickedFiles() {
      return this.pickedDocs.reduce((n, d) => n + d.files.length, 0);
    },
    allPicked() {
      return this.filtered.length > 0 && this.filtered.every((d) => this.picked.includes(d.id));
    },
    counts() {
      const tag = {};
      const cat = {};
      for (const d of this.docs) {
        const cats = new Set();
        for (const id of d.tagIds) {
          tag[id] = (tag[id] || 0) + 1;
          const t = this.tags.get(id);
          if (t) cats.add(t.category_id);
        }
        for (const c of cats) cat[c] = (cat[c] || 0) + 1;
      }
      return { tag, cat };
    },
    filtered() {
      const q = this.q.trim().toLowerCase();
      return this.docs.filter((d) => {
        if (this.year === 'none' ? d.doc_date : this.year && !d.doc_date.startsWith(this.year)) return false;
        if (this.sel.type === 'fav' && !d.fav) return false;
        if (this.sel.type === 'tag' && !d.tagIds.includes(this.sel.id)) return false;
        if (this.sel.type === 'cat' && !d.tagIds.some((id) => (this.tags.get(id) || {}).category_id === this.sel.id)) return false;
        if (!q) return true;
        const hay = [d.title, d.number, d.description, d.author, ...d.files.map((f) => f.name), ...d.tagIds.map((id) => (this.tags.get(id) || {}).name)];
        return hay.join(' ').toLowerCase().includes(q);
      });
    },
    // Lista vine deja ordonată după data documentului (cele mai recente primele, cele fără dată la sfârșit);
    // aici doar o grupăm pe luni.
    groups() {
      const out = [];
      for (const d of this.filtered) {
        const key = d.doc_date.slice(0, 7);
        if (!out.length || out[out.length - 1].key !== key) {
          out.push({ key, label: key ? MONTHS[Number(key.slice(5)) - 1] + ' ' + key.slice(0, 4) : 'Fără dată', hint: key ? '' : 'formulare, modele, documente de referință', docs: [] });
        }
        out[out.length - 1].docs.push(d);
      }
      return out;
    },
  },
  methods: {
    plural,
    isSel(type, id) {
      return this.sel.type === type && this.sel.id === id;
    },
    toggleCat(id) {
      const i = this.openCats.indexOf(id);
      if (i < 0) this.openCats.push(id);
      else this.openCats.splice(i, 1);
      writeOpenCats(this.openCats);
    },
    clearFilters() {
      this.q = '';
      this.year = '';
      this.sel = { type: 'all', id: null };
    },
    startSelect() {
      this.selecting = !this.selecting;
      this.picked = [];
    },
    togglePick(d) {
      const i = this.picked.indexOf(d.id);
      if (i < 0) this.picked.push(d.id);
      else this.picked.splice(i, 1);
    },
    pickAll() {
      this.picked = this.allPicked ? [] : this.filtered.map((d) => d.id);
    },
    // arhiva se descarcă direct de browser (fără să treacă prin memoria paginii)
    downloadZip() {
      if (!this.pickedFiles) return toast('Documentele alese nu au fișiere.', true);
      const a = document.createElement('a');
      a.href = '/api/documents/zip?ids=' + this.picked.join(',');
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Arhiva se descarcă: ' + plural(this.picked.length, 'document', 'documente') + ', ' + plural(this.pickedFiles, 'fișier', 'fișiere') + '.');
      setTimeout(() => loadDocs().catch(() => {}), 2500);
    },
    async seenPicked() {
      const ok = await run(async () => {
        await api('/api/documents/seen-many', { method: 'POST', body: { ids: this.picked } });
        await loadDocs();
      }, 'Documentele alese au fost marcate ca văzute.');
      if (ok) this.picked = [];
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Documente</h1>
        <p class="muted page-sub">{{ filtered.length === docs.length ? plural(docs.length, 'document', 'documente') : filtered.length + ' din ' + plural(docs.length, 'document', 'documente') }}</p>
      </div>
      <div class="head-actions">
        <button v-if="docs.length" class="btn" :class="{ on: selecting }" :aria-pressed="selecting ? 'true' : 'false'" @click="startSelect"><Icon name="check" />{{ selecting ? 'Gata' : 'Selectează' }}</button>
        <button v-if="canAdd" class="btn primary" @click="editing = null">+ Document nou</button>
      </div>
    </div>
    <div class="docs">
      <aside class="card side">
        <button class="side-item" :class="{ on: sel.type === 'all' }" @click="sel = { type: 'all', id: null }">
          <span>Toate documentele</span><span class="count">{{ docs.length }}</span>
        </button>
        <button class="side-item side-fav" :class="{ on: sel.type === 'fav' }" @click="sel = { type: 'fav', id: null }" title="Documentele marcate cu stea">
          <span><Icon name="star" />Favorite</span><span class="count">{{ favCount }}</span>
        </button>
        <div class="side-sep"></div>
        <template v-for="c in store.categories" :key="c.id">
          <div class="side-catrow" :class="{ open: openCats.includes(c.id) }">
            <button class="side-caret" :disabled="!c.tags.length" :aria-expanded="openCats.includes(c.id) ? 'true' : 'false'" :aria-label="(openCats.includes(c.id) ? 'Restrânge ' : 'Extinde ') + c.name" :title="c.tags.length ? (openCats.includes(c.id) ? 'Restrânge' : 'Arată etichetele') : 'Fără etichete'" @click="toggleCat(c.id)"><Icon name="chevron" /></button>
            <button class="side-item side-cat" :class="{ on: isSel('cat', c.id) }" @click="sel = { type: 'cat', id: c.id }">
              <span :title="c.name"><i class="dot" :style="{ background: c.color }"></i>{{ c.name }}</span><span class="count">{{ counts.cat[c.id] || 0 }}</span>
            </button>
          </div>
          <template v-if="openCats.includes(c.id)">
            <button v-for="t in c.tags" :key="t.id" class="side-item side-tag" :class="{ on: isSel('tag', t.id) }" @click="sel = { type: 'tag', id: t.id }">
              <span :title="t.name">{{ t.name }}</span><span class="count">{{ counts.tag[t.id] || 0 }}</span>
            </button>
          </template>
        </template>
      </aside>

      <section>
        <div class="toolbar">
          <span class="searchbox">
            <input ref="search" v-model="q" type="search" placeholder="Caută: denumire, număr, autor, fișier, etichetă…" title="Scurtătură: tasta /  ·  Esc golește căutarea" @keydown.esc="q = ''" />
            <kbd v-if="!q" aria-hidden="true">/</kbd>
          </span>
          <select v-model="year" aria-label="Anul" :class="{ active: year }">
            <option value="">Toți anii ({{ docs.length }})</option>
            <option v-for="y in years" :key="y.year" :value="y.year">{{ y.year }} ({{ y.count }})</option>
            <option v-if="undatedCount" value="none">Fără dată ({{ undatedCount }})</option>
          </select>
        </div>

        <div v-if="selecting" class="selbar" role="region" aria-label="Documente selectate">
          <label class="check"><input type="checkbox" :checked="allPicked" @change="pickAll" />{{ allPicked ? 'Deselectează tot' : 'Selectează tot (' + filtered.length + ')' }}</label>
          <span class="selbar-n">{{ picked.length ? plural(picked.length, 'document ales', 'documente alese') : 'Bifați documentele dorite' }}</span>
          <span class="selbar-act">
            <button class="btn sm" :disabled="!picked.length" @click="seenPicked">Marchează ca văzute</button>
            <button class="btn sm primary" :disabled="!picked.length" @click="downloadZip"><Icon name="download" />Descarcă ZIP</button>
          </span>
        </div>
        <template v-if="store.docsLoaded && !groups.length">
          <EmptyState v-if="sel.type === 'fav' && !favCount" art="docs" title="Încă nu aveți favorite" text="Deschideți un document și apăsați „Adaugă la favorite”: formularele și regulamentele folosite des rămân la îndemână aici și pe pagina Acasă." />
          <EmptyState v-else-if="docs.length" art="search" title="Niciun document găsit" text="Niciun document nu corespunde căutării sau filtrelor alese.">
            <button class="btn" @click="clearFilters">Șterge filtrele</button>
          </EmptyState>
          <EmptyState v-else art="docs" title="Încă nu există documente" :text="canAdd ? 'Adăugați primul document; formularul vă ghidează pas cu pas.' : 'Documentele la care aveți acces vor apărea aici.'">
            <button v-if="canAdd" class="btn primary" @click="editing = null">+ Document nou</button>
          </EmptyState>
        </template>
        <div v-if="groups.length" class="dhead" aria-hidden="true"><span>Data</span><span>Document</span><span>Stare</span><span>Fișiere</span><span></span></div>
        <template v-for="g in groups" :key="g.key">
          <div class="month" :class="{ undated: !g.key }"><Icon v-if="!g.key" name="file" />{{ g.label }}<span v-if="g.hint" class="month-hint">{{ g.hint }}</span><span class="month-count">{{ g.docs.length }}</span></div>
          <DocCard v-for="d in g.docs" :key="d.id" :doc="d" :selectable="selecting" :selected="picked.includes(d.id)" @select="togglePick" @edit="editing = $event" />
        </template>
      </section>
    </div>
    <DocForm v-if="editing !== undefined" :doc="editing" @close="editing = undefined" @saved="editing = undefined" />`,
};

// documentele cu termen de semnare primele (cel mai apropiat termen întâi), apoi celelalte
const byDeadline = (list) => [...list].sort((a, b) => (a.sign_until || '9999').localeCompare(b.sign_until || '9999'));

// ---------- acasă ----------
// Pagina de start: ce are de făcut utilizatorul azi, documentele favorite și cine lipsește.
const HomeView = {
  components: { DocForm, DocCard, Icon, EmptyState },
  data: () => ({ editing: undefined }),
  computed: {
    store: () => store,
    firstName: () => (store.me.full_name || '').split(' ')[0],
    todayLong() {
      const d = new Date();
      const days = ['duminică', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];
      return days[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()].toLowerCase() + ' ' + d.getFullYear();
    },
    hello() {
      const h = new Date().getHours();
      return h < 11 ? 'Bună dimineața' : h < 18 ? 'Bună ziua' : 'Bună seara';
    },
    toSign: () => byDeadline(store.docs.filter((d) => d.mySign === 'pending')),
    overdueMine() {
      return this.toSign.filter(isOverdue).length;
    },
    fresh: () => store.docs.filter((d) => d.unseen && d.mySign !== 'pending'),
    favs: () => store.docs.filter((d) => d.fav),
    // documentele mele (ca autor) aflate încă la semnare
    // (fără cele pe care le am chiar eu de semnat, care apar deja mai sus)
    mine: () => byDeadline(store.docs.filter((d) => d.created_by === store.me.id && d.mySign !== 'pending' && d.signers.some((s) => !s.signed_at))),
    reviews: () => store.docs.filter((d) => d.reviewOpen).sort((a, b) => a.review_until.localeCompare(b.review_until)),
    away() {
      const t = store.today || today();
      return store.absences
        .filter((a) => a.from_date <= t && a.to_date >= t)
        .map((a) => ({ ...a, name: userName(a.user_id), sub: a.substitute_id ? userName(a.substitute_id) : '' }))
        .filter((a) => a.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    tiles() {
      return [
        { key: 'sign', n: this.toSign.length, label: 'de semnat de dvs.', sub: this.overdueMine ? this.overdueMine + ' cu termen depășit' : '', cls: this.overdueMine ? 'red' : this.toSign.length ? 'amber' : '', href: '#notificari', icon: 'pen' },
        { key: 'new', n: this.fresh.length, label: this.fresh.length === 1 ? 'document nou' : 'documente noi', sub: 'încă nedeschise', cls: this.fresh.length ? 'blue' : '', href: '#notificari', icon: 'file' },
        { key: 'rev', n: this.reviews.length, label: this.reviews.length === 1 ? 'avizare deschisă' : 'avizări deschise', sub: this.reviews.length ? 'prima se închide ' + fmtDay(this.reviews[0].review_until) : '', cls: '', href: '#documente', icon: 'review' },
        { key: 'away', n: this.away.length, label: this.away.length === 1 ? 'coleg absent azi' : 'colegi absenți azi', sub: '', cls: '', href: '#angajati', icon: 'calendar' },
      ];
    },
  },
  methods: { fmtDay, plural, initials, avatarStyle },
  template: /*html*/ `
    <div class="page-head home-head">
      <div>
        <h1>{{ hello }}, {{ firstName }}</h1>
        <p class="muted page-sub">Azi este {{ todayLong }}.</p>
      </div>
      <a href="#documente" class="btn"><Icon name="list" />Toate documentele</a>
    </div>
    <div class="tiles">
      <a v-for="t in tiles" :key="t.key" :href="t.href" class="tile card" :class="t.cls">
        <span class="tile-ico"><Icon :name="t.icon" /></span>
        <span class="tile-txt"><b>{{ t.n }}</b><span>{{ t.label }}</span><small v-if="t.sub">{{ t.sub }}</small></span>
      </a>
    </div>
    <div class="home">
      <div class="home-main">
        <section class="home-sec">
          <div class="month">De semnat de dvs.<span class="month-count">{{ toSign.length }}</span></div>
          <DocCard v-for="d in toSign.slice(0, 6)" :key="d.id" :doc="d" @edit="editing = $event" />
          <a v-if="toSign.length > 6" href="#notificari" class="home-more">Toate cele {{ toSign.length }} documente de semnat →</a>
          <p v-if="!toSign.length" class="home-empty"><Icon name="check" />Nu aveți nimic de semnat. Sunteți la zi.</p>
        </section>
        <section v-if="mine.length" class="home-sec">
          <div class="month">Documentele dvs. în curs de semnare<span class="month-count">{{ mine.length }}</span></div>
          <DocCard v-for="d in mine.slice(0, 5)" :key="d.id" :doc="d" @edit="editing = $event" />
        </section>
        <section class="home-sec">
          <div class="month">Favorite<span class="month-count">{{ favs.length }}</span></div>
          <DocCard v-for="d in favs.slice(0, 8)" :key="d.id" :doc="d" @edit="editing = $event" />
          <a v-if="favs.length > 8" href="#documente" class="home-more">Toate favoritele, în pagina Documente →</a>
          <p v-if="!favs.length" class="home-empty"><Icon name="star" />Marcați cu stea formularele și documentele folosite des („Adaugă la favorite”, în cardul documentului); apar aici.</p>
        </section>
        <section v-if="fresh.length" class="home-sec">
          <div class="month">Documente noi<span class="month-count">{{ fresh.length }}</span></div>
          <DocCard v-for="d in fresh.slice(0, 5)" :key="d.id" :doc="d" @edit="editing = $event" />
          <a v-if="fresh.length > 5" href="#notificari" class="home-more">Toate documentele noi →</a>
        </section>
      </div>
      <aside class="home-side">
        <section class="card side-box">
          <h3><Icon name="calendar" />Absenți azi</h3>
          <ul v-if="away.length" class="away-list">
            <li v-for="a in away" :key="a.id">
              <span class="avatar sm" :style="avatarStyle(a.name)">{{ initials(a.name) }}</span>
              <span class="who-txt"><b>{{ a.name }}</b><span class="muted small">{{ a.kind }} · până la {{ fmtDay(a.to_date) }}</span><span v-if="a.sub" class="small sub-line"><Icon name="swap" />înlocuit de {{ a.sub }}</span></span>
            </li>
          </ul>
          <p v-else class="muted small">Toți colegii sunt prezenți.</p>
        </section>
        <section v-if="reviews.length" class="card side-box">
          <h3><Icon name="review" />Avizări deschise</h3>
          <ul class="rev-list">
            <li v-for="d in reviews.slice(0, 6)" :key="d.id"><span class="rev-title" :title="d.title">{{ d.title }}</span><span class="muted small">până la {{ fmtDay(d.review_until) }}</span></li>
          </ul>
        </section>
      </aside>
    </div>
    <DocForm v-if="editing !== undefined" :doc="editing" @close="editing = undefined" @saved="editing = undefined" />`,
};

// ---------- notificări ----------
// Aceeași așezare ca pagina Documente: filtre în stânga, lista cu aceleași coloane în dreapta.
const InboxView = {
  components: { DocForm, DocCard, EmptyState },
  data: () => ({ editing: undefined, show: 'all' }),
  computed: {
    toSign: () => byDeadline(store.docs.filter((d) => d.mySign === 'pending')),
    fresh: () => store.docs.filter((d) => d.unseen && d.mySign !== 'pending'),
    total() {
      return this.toSign.length + this.fresh.length;
    },
    groups() {
      const out = [];
      if (this.show !== 'new' && this.toSign.length) out.push({ key: 'sign', label: 'Așteaptă semnătura dvs.', docs: this.toSign });
      if (this.show !== 'sign' && this.fresh.length) out.push({ key: 'new', label: 'Documente noi, încă nevăzute', docs: this.fresh });
      return out;
    },
  },
  methods: {
    plural,
    seenAll() {
      run(async () => {
        await api('/api/documents/seen-all', { method: 'POST' });
        await loadDocs();
      }, 'Toate documentele au fost marcate ca văzute.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Notificări</h1>
        <p class="muted page-sub">{{ total ? plural(total, 'notificare', 'notificări') : 'Nicio notificare nouă' }}</p>
      </div>
      <button v-if="fresh.length" class="btn" @click="seenAll">Marchează toate ca văzute</button>
    </div>
    <div class="docs">
      <aside class="card side">
        <button class="side-item" :class="{ on: show === 'all' }" @click="show = 'all'"><span>Toate notificările</span><span class="count">{{ total }}</span></button>
        <button class="side-item" :class="{ on: show === 'sign' }" @click="show = 'sign'"><span>De semnat de dvs.</span><span class="count">{{ toSign.length }}</span></button>
        <button class="side-item" :class="{ on: show === 'new' }" @click="show = 'new'"><span>Documente nevăzute</span><span class="count">{{ fresh.length }}</span></button>
      </aside>
      <section>
        <EmptyState v-if="!groups.length" art="inbox" :title="total ? 'Nimic aici' : 'Sunteți la zi'" :text="total ? 'Nicio notificare în această categorie.' : 'Nu aveți documente de semnat sau nevăzute.'" />
        <div v-else class="dhead" aria-hidden="true"><span>Data</span><span>Document</span><span>Stare</span><span>Fișiere</span><span></span></div>
        <template v-for="g in groups" :key="g.key">
          <div class="month">{{ g.label }}<span class="month-count">{{ g.docs.length }}</span></div>
          <DocCard v-for="d in g.docs" :key="d.id" :doc="d" @edit="editing = $event" />
        </template>
      </section>
    </div>
    <DocForm v-if="editing !== undefined" :doc="editing" @close="editing = undefined" @saved="editing = undefined" />`,
};

// ---------- copie de rezervă ----------
const BackupView = {
  data: () => ({ busy: false, file: null }),
  methods: {
    fmtSize,
    async restore() {
      if (!this.file) return;
      const ok = await ask({
        title: 'Înlocuiți toate datele?',
        message: 'Importul ÎNLOCUIEȘTE toate datele actuale (utilizatori, organigramă, documente, fișiere) cu cele din arhiva „' + this.file.name + '”. Toți utilizatorii vor fi deconectați.',
        okLabel: 'Importă și înlocuiește',
        danger: true,
      });
      if (!ok) return;
      this.busy = true;
      try {
        const r = await api('/api/admin/import', { method: 'POST', raw: this.file });
        await ask({
          title: 'Import finalizat',
          message:
            r.documents + ' documente, ' + r.files + ' fișiere, ' + r.users + ' utilizatori.' +
            (r.missing ? '\n' + r.missing + ' fișiere lipseau deja la momentul exportului.' : '') +
            '\n\nAutentificați-vă din nou cu un cont din arhivă.',
          okLabel: 'Continuă',
          cancelLabel: '',
        });
        location.reload();
      } catch (e) {
        toast(e.message, true);
      }
      this.busy = false;
    },
  },
  // Afișat în pagina „Setări”, în coloana din dreapta.
  template: /*html*/ `
      <section class="card panel">
        <div class="panel-head"><h2>Export complet</h2><span class="pill">Backup</span></div>
        <p class="muted small">Un singur fișier comprimat cu tot: utilizatori (parole criptate), organigramă, categorii, documente, semnături și fișiere. Fiecare element are sumă de control.</p>
        <div class="panel-foot">
          <a class="btn primary" href="/api/admin/export" download>Descarcă exportul</a>
          <span class="muted small">Păstrați-l într-un loc sigur: conține toate documentele.</span>
        </div>
      </section>
      <section class="card panel danger-panel">
        <div class="panel-head"><h2>Import (restaurare)</h2><span class="pill red">Înlocuiește tot</span></div>
        <p class="muted small">Înlocuiește toate datele actuale cu cele dintr-un export. Arhiva este verificată integral înainte; dacă este deteriorată sau incompletă, nu se schimbă nimic.</p>
        <label class="filepick" :class="{ chosen: file }">
          <input type="file" accept=".anscbackup" :disabled="busy" @change="file = $event.target.files[0] || null" />
          <span>{{ file ? file.name + ' — ' + fmtSize(file.size) : 'Alegeți fișierul .anscbackup…' }}</span>
        </label>
        <div class="panel-foot">
          <button class="btn danger-solid" :disabled="!file || busy" @click="restore">{{ busy ? 'Se importă… nu închideți pagina' : 'Importă și înlocuiește tot' }}</button>
        </div>
      </section>`,
};

// ---------- utilizatori ----------
const UserForm = {
  components: { Modal },
  props: { user: Object, unitId: Number },
  emits: ['close', 'saved'],
  data() {
    const u = this.user;
    return {
      busy: false,
      form: {
        full_name: u ? u.full_name : '',
        username: u ? u.username : '',
        position: u ? u.position : '',
        email: u ? u.email : '',
        phone: u ? u.phone || '' : '',
        unit_id: u ? u.unit_id : this.unitId || null,
        role: u ? u.role : 'user',
        active: u ? !!u.active : true,
        password: '',
      },
    };
  },
  computed: { units: () => flatUnits() },
  methods: {
    // parolă inițială aleatorie, fără caractere ușor de confundat (0/O, 1/l/I)
    generate() {
      const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = crypto.getRandomValues(new Uint8Array(14));
      this.form.password = [...bytes].map((b) => abc[b % abc.length]).join('');
    },
    async submit() {
      this.busy = true;
      let r;
      const ok = await run(async () => {
        r = await api(this.user ? '/api/users/' + this.user.id : '/api/users', { method: this.user ? 'PUT' : 'POST', body: this.form });
        await loadShared();
      });
      this.busy = false;
      if (!ok) return;
      if (r && r.blockedDocs) {
        toast('Contul a fost dezactivat. ' + r.blockedDocs + ' document(e) așteaptă semnătura acestei persoane: autorii trebuie să modifice lanțul de semnare.', true);
      } else toast(this.user ? 'Datele angajatului au fost actualizate.' : 'Angajatul a fost adăugat.');
      this.$emit('saved');
    },
  },
  template: /*html*/ `
    <Modal :title="user ? 'Modifică angajatul' : 'Angajat nou'" :busy="busy" @close="$emit('close')" @submit="submit">
      <div class="row">
        <label class="field"><span>Nume și prenume *</span><input v-model="form.full_name" maxlength="150" required autofocus /></label>
        <label class="field"><span>Funcția</span><input v-model="form.position" maxlength="150" placeholder="ex. Consultant principal" /></label>
      </div>
      <div class="row">
        <label class="field"><span>E-mail</span><input v-model="form.email" type="email" maxlength="150" /></label>
        <label class="field"><span>Telefon</span><input v-model="form.phone" type="tel" maxlength="40" placeholder="ex. 022 820 650" /></label>
      </div>
      <label class="field"><span>Subdiviziunea (locul în organigramă)</span>
        <select v-model="form.unit_id">
          <option :value="null">— fără subdiviziune —</option>
          <option v-for="u in units" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
      </label>
      <div class="row">
        <label class="field"><span>Nume de utilizator *</span><input v-model="form.username" maxlength="40" required autocomplete="off" placeholder="ex. ion.popescu" /></label>
        <label class="field"><span>{{ user ? 'Parolă nouă (opțional)' : 'Parolă inițială *' }}</span>
          <span class="input-btn">
            <input v-model="form.password" type="text" minlength="10" maxlength="200" :required="!user" autocomplete="off" spellcheck="false" placeholder="cel puțin 10 caractere" />
            <button type="button" class="btn sm" @click="generate" title="Generează o parolă aleatorie">Generează</button>
          </span>
        </label>
      </div>
      <label class="field"><span>Rol</span>
        <select v-model="form.role">
          <option value="user">Angajat — vede documentele la care are acces</option>
          <option value="editor">Editor — poate adăuga și modifica documentele proprii</option>
          <option value="admin">Administrator — gestionează tot sistemul</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" v-model="form.active" /> Cont activ</label>
      <p class="muted small hint">La prima autentificare (sau după resetarea parolei) utilizatorul va fi obligat să își seteze o parolă proprie.</p>
    </Modal>`,
};

// ---------- import în masă al angajaților (CSV) ----------
// Coloane recunoscute (antet, fără diacritice/majuscule): Nume, Prenume, Funcția, E-mail,
// Telefon, Utilizator, Subdiviziune. În locul coloanelor Nume + Prenume se acceptă și una singură,
// „Numele, prenumele” / „Nume și prenume” (ca în lista de telefoane: întâi numele de familie).
// „Subdiviziune” este calea în organigramă, de sus în jos, cu „>” între niveluri. Lipsa coloanei
// „Utilizator” = prenume.nume fără diacritice. Fișierul poate veni din Excel așa cum l-a salvat:
// UTF-8 sau ANSI (Windows-1250) sau UTF-16, cu separator ; , sau tab, cu rândul „sep=;” și cu
// un titlu deasupra antetului.
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const slugName = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const BOM = String.fromCharCode(0xfeff);

async function readTextFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1250').decode(buf); // „CSV” salvat de Excel în românește
  }
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

// Pozițiile coloanelor dintr-un rând de antet, sau null dacă rândul nu este antetul.
function headerColumns(head) {
  const keys = head.map((h) => fold(h).replace(/[^a-z]+/g, ' ').trim());
  const find = (test) => keys.findIndex(test);
  // Se recunoaște și exportul de utilizatori din Microsoft 365 / Entra (First name, Last name,
  // User principal name, Job title, Department).
  const mail = find((k) => k.startsWith('e mail') || k.startsWith('email') || k === 'mail');
  const c = {
    nume: find((k) => ['nume', 'numele', 'nume de familie', 'familia', 'last name', 'surname'].includes(k)),
    prenume: find((k) => ['prenume', 'prenumele', 'first name', 'given name', 'givenname'].includes(k)),
    both: find((k) => /^numele? (si )?prenumele?$/.test(k) || k === 'nume si prenume'),
    functia: find((k) => k.startsWith('functi') || k === 'job title' || k === 'title'),
    email: mail >= 0 ? mail : find((k) => k === 'user principal name' || k === 'userprincipalname'),
    user: find((k) => ['utilizator', 'nume de utilizator', 'username', 'login'].includes(k)),
    unit: find((k) => k.startsWith('subdiviziun') || k.startsWith('unitate') || k === 'department'),
    phone: find((k) => k.startsWith('telefon') || ['tel', 'phone', 'office phone', 'mobile phone', 'business phone'].includes(k)),
    // conturile șterse din Microsoft 365 au completată data ștergerii: nu le importăm
    deleted: find((k) => k.startsWith('soft deletion')),
  };
  if (c.nume >= 0 && c.prenume >= 0) c.both = -1;
  else if (c.both < 0) return null;
  return c;
}

function peopleFromCsv(text) {
  text = text.replace(BOM, '');
  let seps = [';', ',', '\t'];
  const sepLine = /^"?sep=(.)"?\r?\n/i.exec(text); // Excel scrie uneori „sep=;” pe primul rând
  if (sepLine) {
    seps = [sepLine[1]];
    text = text.slice(sepLine[0].length);
  }
  let found = null;
  for (const sep of seps) {
    const rows = parseCsv(text, sep);
    // antetul poate fi precedat de un titlu: îl căutăm în primele rânduri
    for (let i = 0; i < Math.min(rows.length, 10) && !found; i++) {
      const cols = headerColumns(rows[i]);
      if (cols) found = { cols, lines: rows.slice(i + 1) };
    }
    if (found) break;
  }
  if (!found) {
    const first = text.split(/\r?\n/, 1)[0].slice(0, 120);
    throw new Error(
      'Nu am găsit coloanele „Nume” și „Prenume” (sau „Numele, prenumele”). Primul rând din fișier este: „' +
        first +
        '”. Salvați tabelul ca CSV (UTF-8 sau „CSV separat prin virgulă”) cu antetul: Nume; Prenume; Funcția; E-mail; Utilizator; Subdiviziune.'
    );
  }
  const { cols: c, lines } = found;
  const at = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const active = lines.filter((r) => !at(r, c.deleted));
  if (lines.length && !active.length) {
    throw new Error(
      'Toate conturile din fișier sunt marcate ca șterse („Soft deletion time stamp” completat): acesta pare exportul de utilizatori șterși din Microsoft 365. Exportați lista utilizatorilor activi.'
    );
  }
  return active
    .map((r) => {
      let nume = at(r, c.nume);
      let prenume = at(r, c.prenume);
      if (c.both >= 0) {
        // „Munteanu Angela”: ultimul cuvânt este prenumele, restul numele de familie
        const words = at(r, c.both).split(/\s+/).filter(Boolean);
        prenume = words.length > 1 ? words.pop() : '';
        nume = words.join(' ');
      }
      return {
        full_name: [prenume, nume].filter(Boolean).join(' '),
        username: at(r, c.user) || [slugName(prenume), slugName(nume)].filter(Boolean).join('.'),
        email: at(r, c.email),
        phone: at(r, c.phone),
        position: at(r, c.functia),
        path: at(r, c.unit).split(/\s*[>›]\s*/).filter(Boolean),
      };
    })
    .filter((p) => p.full_name);
}

const ImportPeople = {
  components: { Modal },
  emits: ['close', 'done'],
  data: () => ({ rows: [], fileName: '', parentId: null, preview: null, result: null, busy: false, error: '' }),
  created() {
    // Cu o singură subdiviziune de nivel superior (de regulă instituția), subdiviziunile noi intră sub ea.
    const top = childUnits(null);
    if (top.length === 1) this.parentId = top[0].id;
  },
  computed: {
    units: () => flatUnits(),
    okLabel() {
      if (this.result) return 'Închide';
      return this.preview ? 'Importă ' + this.preview.created.length + ' angajați' : 'Verifică fișierul';
    },
  },
  methods: {
    async pick(e) {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      this.error = '';
      this.preview = null;
      this.fileName = file.name;
      try {
        this.rows = peopleFromCsv(await readTextFile(file));
        if (!this.rows.length) throw new Error('Fișierul nu conține angajați.');
        await this.check();
      } catch (err) {
        this.rows = [];
        this.error = err.message;
      }
    },
    async check() {
      this.busy = true;
      try {
        this.preview = await api('/api/admin/import-people', { method: 'POST', body: { rows: this.rows, parent_id: this.parentId, dry_run: true } });
      } catch (err) {
        this.error = err.message;
      }
      this.busy = false;
    },
    async submit() {
      if (this.result) return this.close();
      if (!this.rows.length) return (this.error = 'Alegeți mai întâi fișierul CSV.');
      if (!this.preview) return this.check();
      if (!this.preview.created.length) return (this.error = 'Nu este niciun angajat nou de importat.');
      this.busy = true;
      try {
        this.result = await api('/api/admin/import-people', { method: 'POST', body: { rows: this.rows, parent_id: this.parentId } });
        await loadShared();
      } catch (err) {
        this.error = err.message;
      }
      this.busy = false;
    },
    close() {
      this.$emit(this.result ? 'done' : 'close');
    },
    // Lista cu parolele temporare, de transmis angajaților (o singură dată; nu se mai pot vedea ulterior).
    downloadPasswords() {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['Nume și prenume', 'Utilizator', 'Parolă temporară', 'E-mail', 'Subdiviziune'].map(q).join(';')];
      for (const c of this.result.created) lines.push([c.full_name, c.username, c.password, c.email, c.unit].map(q).join(';'));
      const blob = new Blob([BOM + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'parole-temporare.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  },
  template: /*html*/ `
    <Modal title="Import angajați din CSV" xl :busy="busy" :ok-label="okLabel" busy-label="Se verifică…" :cancel-label="result ? '' : 'Anulează'" @close="close" @submit="submit">
      <template v-if="!result">
        <p class="dialog-msg">Coloane: <b>Nume</b>, <b>Prenume</b>, Funcția, E-mail, Telefon, Utilizator, Subdiviziune (calea în organigramă, cu „&gt;” între niveluri). Subdiviziunile lipsă se creează; conturile existente nu se modifică. Fiecare cont nou primește o parolă temporară, de schimbat la prima autentificare.</p>
        <div class="row">
          <label class="field"><span>Fișierul CSV</span><input type="file" accept=".csv,.txt,text/csv,text/plain" @change="pick" /></label>
          <label class="field"><span>Plasează subdiviziunile noi de nivel superior sub</span>
            <select v-model="parentId" @change="rows.length && check()">
              <option :value="null">— nivelul superior —</option>
              <option v-for="u in units" :key="u.id" :value="u.id">{{ u.label }}</option>
            </select>
          </label>
        </div>
        <p v-if="error" class="warn">{{ error }}</p>
        <template v-if="preview">
          <p><b>{{ preview.created.length }}</b> conturi noi, <b>{{ preview.units.length }}</b> subdiviziuni noi<template v-if="preview.skipped.length">, <b>{{ preview.skipped.length }}</b> rânduri omise</template> ({{ fileName }}).</p>
          <p v-if="preview.units.length" class="small muted">Subdiviziuni noi: {{ preview.units.join('; ') }}</p>
          <div v-if="preview.skipped.length" class="small"><b>Omise:</b><ul><li v-for="s in preview.skipped" :key="s.line">rândul {{ s.line }} {{ s.name }}: {{ s.reason }}</li></ul></div>
          <div class="table-wrap import-preview">
            <table>
              <thead><tr><th>Nume și prenume</th><th>Utilizator</th><th>Funcția</th><th>E-mail</th><th>Telefon</th><th>Subdiviziune</th></tr></thead>
              <tbody><tr v-for="c in preview.created" :key="c.line"><td>{{ c.full_name }}</td><td><code class="uname">{{ c.username }}</code></td><td>{{ rows[c.line - 1].position || '—' }}</td><td>{{ c.email || '—' }}</td><td class="nowrap">{{ rows[c.line - 1].phone || '—' }}</td><td>{{ c.unit || '—' }}</td></tr></tbody>
            </table>
          </div>
        </template>
      </template>
      <template v-else>
        <p><b>{{ result.created.length }}</b> conturi create și <b>{{ result.units.length }}</b> subdiviziuni adăugate în organigramă.</p>
        <p class="warn">Descărcați acum lista cu parolele temporare: după închiderea ferestrei nu mai poate fi afișată. Păstrați-o în siguranță și ștergeți-o după ce ați transmis parolele.</p>
        <button type="button" class="btn primary" @click="downloadPasswords">Descarcă parolele temporare (CSV)</button>
      </template>
    </Modal>`,
};

// ---------- organigramă ----------
// Vizibilă tuturor angajaților; doar administratorii văd butoanele de editare.
const ORG_PREVIEW = 5; // câte persoane se văd pe un card înainte de „încă N”
const readPref = (k, d) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};
const writePref = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
// Starea organigramei rămâne aceeași când utilizatorul trece la alte pagini și revine.
const orgUi = reactive({
  mode: readPref('org.mode', 'chart'),
  zoom: Number(readPref('org.zoom', '1')) || 1,
  // „Potrivește”: schema se micșorează automat ca să încapă întreagă în fereastră
  fit: readPref('org.fit', '1') === '1',
  collapsed: new Set(),
  morePeople: new Set(),
  focus: null,
});

const peopleOf = (unitId) => store.users.filter((u) => u.unit_id === unitId);
function subtreeIds(unitId, out = new Set()) {
  if (out.has(unitId)) return out;
  out.add(unitId);
  for (const c of childUnits(unitId)) subtreeIds(c.id, out);
  return out;
}
const subtreePeople = (unitId) => {
  const ids = subtreeIds(unitId);
  return store.users.filter((u) => ids.has(u.unit_id)).length;
};
function unitPath(unitId) {
  const byId = new Map(store.units.map((u) => [u.id, u]));
  const out = [];
  for (let u = byId.get(unitId); u && out.length < 50; u = byId.get(u.parent_id)) out.unshift(u.name);
  return out;
}


// Rândul unei persoane, folosit în ambele vizualizări și în rezultatele căutării.
const OrgPerson = {
  components: { Icon },
  props: { p: Object, hit: Boolean },
  computed: {
    // absența de azi: un inel pe avatar și un rând sub funcție
    away() {
      const a = absenceNow(this.p.id);
      if (!a) return null;
      const sub = a.substitute_id ? userName(a.substitute_id) : '';
      return { text: 'Absent până la ' + fmtDay(a.to_date), title: a.kind + ', ' + fmtDay(a.from_date) + ' – ' + fmtDay(a.to_date) + (sub ? ' · înlocuit de ' + sub : '') };
    },
  },
  methods: { initials, avatarStyle },
  template: /*html*/ `
    <li class="person" :class="{ hit, away: !!away }">
      <span class="avatar" :style="avatarStyle(p.full_name)">{{ initials(p.full_name) }}</span>
      <div class="person-txt"><b :title="p.full_name">{{ p.full_name }}</b><span class="muted small" :title="p.position">{{ p.position || '—' }}</span><span v-if="away" class="person-away" :title="away.title">{{ away.text }}</span></div>
      <a v-if="p.phone" class="person-mail" :href="'tel:' + p.phone.replace(/[^0-9+]/g, '')" :title="'Telefon: ' + p.phone" :aria-label="'Sună: ' + p.full_name"><Icon name="phone" /></a>
      <a v-if="p.email" class="person-mail" :href="'mailto:' + p.email" :title="'Scrie-i un e-mail: ' + p.email" :aria-label="'E-mail către ' + p.full_name"><Icon name="mail" /></a>
    </li>`,
};

// Butoanele de administrare ale unei subdiviziuni (aceleași în schemă și în listă).
const OrgAdmin = {
  components: { Icon },
  props: { unit: Object },
  inject: ['org'],
  template: /*html*/ `
    <div class="org-admin">
      <button type="button" class="icon-btn" title="Adaugă o subdiviziune subordonată" @click="org.addUnit(unit.id)"><Icon name="unit" /></button>
      <button type="button" class="icon-btn" title="Adaugă un angajat în această subdiviziune" @click="org.addUser(unit.id)"><Icon name="user" /></button>
      <button type="button" class="icon-btn" title="Modifică subdiviziunea" @click="org.editUnit(unit)"><Icon name="edit" /></button>
      <button type="button" class="icon-btn danger" title="Șterge subdiviziunea" @click="org.removeUnit(unit)"><Icon name="trash" /></button>
    </div>`,
};

const orgNodeMixin = {
  props: { unit: Object, depth: { type: Number, default: 0 } },
  inject: ['org'],
  computed: {
    admin: isAdmin,
    ui: () => orgUi,
    children() {
      return childUnits(this.unit.id);
    },
    people() {
      return peopleOf(this.unit.id);
    },
    total() {
      return subtreePeople(this.unit.id);
    },
    collapsed() {
      return this.children.length > 0 && orgUi.collapsed.has(this.unit.id);
    },
    showAll() {
      return orgUi.morePeople.has(this.unit.id) || !!this.org.q();
    },
    shownPeople() {
      return this.showAll ? this.people : this.people.slice(0, ORG_PREVIEW);
    },
    hit() {
      return this.org.unitHit(this.unit);
    },
  },
  methods: {
    plural,
    toggle() {
      const s = orgUi.collapsed;
      s.has(this.unit.id) ? s.delete(this.unit.id) : s.add(this.unit.id);
    },
    toggleMore() {
      const s = orgUi.morePeople;
      s.has(this.unit.id) ? s.delete(this.unit.id) : s.add(this.unit.id);
    },
  },
};

// Vizualizarea „Schemă”: arbore de sus în jos, cu linii de legătură.
const OrgChartNode = {
  name: 'OrgChartNode',
  mixins: [orgNodeMixin],
  components: { OrgPerson, OrgAdmin },
  computed: {
    // subdiviziunile finale (fără alte subdiviziuni) se așază una sub alta, ca schema să nu devină foarte lată
    stacked() {
      return this.children.length > 0 && this.children.every((c) => !childUnits(c.id).length) && (this.depth >= 1 || this.children.length > 5);
    },
  },
  template: /*html*/ `
    <li>
      <div class="oc-card" :id="'unit-' + unit.id" :class="['lvl' + Math.min(depth, 3), { hit, focus: ui.focus === unit.id }]">
        <div class="oc-top">
          <span class="oc-type">{{ unit.type || 'Subdiviziune' }}</span>
          <OrgAdmin v-if="admin" :unit="unit" />
        </div>
        <div class="oc-name">{{ unit.name }}</div>
        <div class="oc-count">
          {{ plural(people.length, 'angajat', 'angajați') }}<template v-if="children.length && total !== people.length"> · {{ total }} cu subordonații</template>
        </div>
        <ul v-if="people.length" class="oc-people">
          <OrgPerson v-for="p in shownPeople" :key="p.id" :p="p" :hit="org.personHit(p)" />
        </ul>
        <button v-if="people.length > ${ORG_PREVIEW} && !org.q()" type="button" class="oc-more" @click="toggleMore">
          {{ showAll ? 'Arată mai puțin' : 'Încă ' + (people.length - ${ORG_PREVIEW}) + '…' }}
        </button>
        <button v-if="children.length" type="button" class="oc-toggle" :class="{ closed: collapsed }" @click="toggle"
          :title="collapsed ? 'Arată ' + plural(children.length, 'subdiviziunea subordonată', 'subdiviziunile subordonate') : 'Ascunde subdiviziunile subordonate'"
          :aria-expanded="!collapsed">{{ collapsed ? children.length : '−' }}</button>
      </div>
      <ul v-if="children.length && !collapsed" :class="stacked ? 'oc-stack' : 'oc-level'">
        <OrgChartNode v-for="c in children" :key="c.id" :unit="c" :depth="depth + 1" />
      </ul>
    </li>`,
};

// Vizualizarea „Listă”: ierarhie indentată, potrivită pe ecrane înguste și pentru tipărire.
const OrgListNode = {
  name: 'OrgListNode',
  mixins: [orgNodeMixin],
  components: { OrgPerson, OrgAdmin },
  template: /*html*/ `
    <div class="ol-node">
      <div class="card ol-card" :id="'unit-' + unit.id" :class="['lvl' + Math.min(depth, 3), { hit, focus: ui.focus === unit.id }]">
        <div class="ol-head">
          <button v-if="children.length" type="button" class="ol-caret" :class="{ closed: collapsed }" @click="toggle" :aria-expanded="!collapsed" :aria-label="collapsed ? 'Extinde' : 'Restrânge'">▾</button>
          <span v-else class="ol-caret-space"></span>
          <h3>{{ unit.name }}</h3>
          <span v-if="unit.type" class="badge">{{ unit.type }}</span>
          <span class="muted small">{{ plural(people.length, 'angajat', 'angajați') }}<template v-if="collapsed"> · {{ plural(children.length, 'subdiviziune ascunsă', 'subdiviziuni ascunse') }}</template></span>
          <OrgAdmin v-if="admin" :unit="unit" class="ol-admin" />
        </div>
        <ul v-if="people.length" class="people">
          <OrgPerson v-for="p in people" :key="p.id" :p="p" :hit="org.personHit(p)" />
        </ul>
      </div>
      <div v-if="children.length && !collapsed" class="ol-children">
        <OrgListNode v-for="c in children" :key="c.id" :unit="c" :depth="depth + 1" />
      </div>
    </div>`,
};

const OrgView = {
  components: { OrgChartNode, OrgListNode, OrgPerson, Modal, UserForm },
  provide() {
    return {
      org: {
        addUnit: this.addUnit,
        editUnit: this.editUnit,
        removeUnit: this.removeUnit,
        addUser: (id) => (this.userUnit = id),
        q: () => this.query,
        unitHit: this.unitHit,
        personHit: this.personHit,
      },
    };
  },
  data: () => ({ q: '', unitForm: null, userUnit: null, busy: false }),
  computed: {
    store: () => store,
    ui: () => orgUi,
    admin: isAdmin,
    query() {
      return this.q.trim().toLowerCase();
    },
    roots: () => childUnits(null),
    unassigned: () => store.users.filter((u) => !store.units.some((x) => x.id === u.unit_id)),
    stats() {
      return plural(store.units.length, 'subdiviziune', 'subdiviziuni') + ' · ' + plural(store.users.length, 'angajat', 'angajați');
    },
    results() {
      const q = this.query;
      if (!q) return null;
      const people = store.users.filter((p) => this.personHit(p));
      const units = store.units.filter((u) => this.matches(u.name + ' ' + u.type));
      return { people: people.slice(0, 60), units: units.slice(0, 30), more: people.length > 60 };
    },
    zoomPct() {
      return Math.round(orgUi.zoom * 100) + '%';
    },
    parents() {
      // o subdiviziune nu poate fi mutată sub ea însăși sau sub una din subordinea ei
      const banned = this.unitForm && this.unitForm.id ? subtreeIds(this.unitForm.id) : new Set();
      return flatUnits().filter((u) => !banned.has(u.id));
    },
  },
  watch: {
    'ui.mode'(v) {
      writePref('org.mode', v);
      if (v === 'chart') this.$nextTick(this.center);
    },
    'ui.zoom'(v) {
      writePref('org.zoom', String(v));
      // după micșorare pot dispărea barele de derulare: încă o potrivire, cu spațiul eliberat
      if (orgUi.fit) requestAnimationFrame(() => this.fitChart());
    },
    'ui.fit'(v) {
      writePref('org.fit', v ? '1' : '0');
      if (v) this.fitChart();
    },
  },
  mounted() {
    // schema se repotrivește când se schimbă fereastra sau când se extind/restrâng ramuri
    this.resizeObs = new ResizeObserver(() => this.fitChart());
    this.observeChart();
    this.$nextTick(this.center);
  },
  updated() {
    this.observeChart();
  },
  beforeUnmount() {
    this.resizeObs.disconnect();
  },
  methods: {
    plural,
    unitPath,
    matches(text) {
      return String(text || '').toLowerCase().includes(this.query);
    },
    personHit(p) {
      return !!this.query && this.matches(p.full_name + ' ' + p.position + ' ' + p.email);
    },
    unitHit(u) {
      return !!this.query && (this.matches(u.name + ' ' + u.type) || peopleOf(u.id).some(this.personHit));
    },
    setZoom(step) {
      orgUi.fit = false;
      orgUi.zoom = step ? Math.min(1.5, Math.max(0.2, Math.round((orgUi.zoom + step) * 10) / 10)) : 1;
    },
    observeChart() {
      const el = this.$refs.scroll;
      const root = this.$refs.root;
      if (el === this.observed?.[0] && root === this.observed?.[1]) return;
      this.resizeObs.disconnect();
      if (el && root) {
        this.resizeObs.observe(el);
        this.resizeObs.observe(root);
        this.fitChart();
      }
      this.observed = [el, root];
    },
    // Calculează mărirea la care schema încape întreagă (lățime și înălțime) în chenar.
    fitChart() {
      if (!orgUi.fit || orgUi.mode !== 'chart') return;
      const el = this.$refs.scroll;
      const root = this.$refs.root;
      if (!el || !root) return;
      const box = root.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const availW = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const availH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (!box.width || availW <= 0 || availH <= 0) return;
      // mărirea aplicată efectiv în pagină (starea poate fi deja schimbată, dar încă nedesenată)
      const applied = parseFloat(this.$refs.canvas.style.zoom) || 1;
      const w = box.width / applied;
      const h = box.height / applied;
      // pe ecrane înguste chenarul crește după conținut: potrivim doar lățimea
      const tall = getComputedStyle(el).maxHeight === 'none';
      const z = Math.min(1, availW / w, tall ? Infinity : availH / h);
      const next = Math.max(0.2, Math.floor(z * 100) / 100);
      if (Math.abs(next - orgUi.zoom) >= 0.01) orgUi.zoom = next;
    },
    expandAll() {
      orgUi.collapsed.clear();
    },
    collapseAll() {
      // rămâne vizibil primul nivel sub conducere
      for (const u of store.units) if (childUnits(u.id).length && !this.roots.some((r) => r.id === u.id)) orgUi.collapsed.add(u.id);
    },
    // centrează schema pe orizontală (de obicei e mai lată decât ecranul)
    center() {
      const el = this.$refs.scroll;
      if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    },
    // Deschide ramura unei subdiviziuni și o aduce în centrul ecranului.
    reveal(unitId) {
      if (!unitId) return;
      const byId = new Map(store.units.map((u) => [u.id, u]));
      for (let u = byId.get(unitId); u; u = byId.get(u.parent_id)) {
        if (u.id !== unitId) orgUi.collapsed.delete(u.id);
      }
      orgUi.focus = unitId;
      this.$nextTick(() => {
        const el = document.getElementById('unit-' + unitId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      });
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => (orgUi.focus = null), 2200);
    },
    // Schema se poate deplasa trăgând cu mausul de fundal.
    pan(e) {
      if (e.button !== 0 || e.target.closest('.oc-card, button, a, input')) return;
      const el = this.$refs.scroll;
      const sx = e.clientX, sy = e.clientY, l = el.scrollLeft, t = el.scrollTop;
      el.classList.add('panning');
      const move = (ev) => {
        el.scrollLeft = l - (ev.clientX - sx);
        el.scrollTop = t - (ev.clientY - sy);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        el.classList.remove('panning');
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up, { once: true });
      e.preventDefault();
    },
    addUnit(parentId) {
      this.unitForm = { id: null, name: '', type: '', parent_id: parentId, sort: 0 };
    },
    editUnit(u) {
      this.unitForm = { id: u.id, name: u.name, type: u.type, parent_id: u.parent_id, sort: u.sort };
    },
    async saveUnit() {
      const f = this.unitForm;
      this.busy = true;
      const ok = await run(async () => {
        await api(f.id ? '/api/units/' + f.id : '/api/units', { method: f.id ? 'PUT' : 'POST', body: f });
        await loadShared();
      }, 'Organigrama a fost actualizată.');
      this.busy = false;
      if (ok) this.unitForm = null;
    },
    async removeUnit(u) {
      const ok = await ask({ title: 'Ștergeți subdiviziunea?', message: '„' + u.name + '” va fi eliminată din organigramă.', okLabel: 'Șterge', danger: true });
      if (!ok) return;
      await run(async () => {
        await api('/api/units/' + u.id, { method: 'DELETE' });
        await loadShared();
      }, 'Subdiviziunea a fost ștearsă.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Organigramă</h1>
        <p class="muted page-sub">{{ stats }}</p>
      </div>
      <button v-if="admin" class="btn primary" @click="addUnit(null)">+ Adaugă subdiviziune</button>
    </div>

    <div class="org-toolbar">
      <input v-model="q" type="search" class="org-search" placeholder="Caută o persoană, o funcție sau o subdiviziune…" aria-label="Caută în organigramă" />
      <div class="seg" role="group" aria-label="Mod de afișare">
        <button type="button" :class="{ on: ui.mode === 'chart' }" @click="ui.mode = 'chart'">Schemă</button>
        <button type="button" :class="{ on: ui.mode === 'list' }" @click="ui.mode = 'list'">Listă</button>
      </div>
      <div class="seg" role="group" aria-label="Ramuri">
        <button type="button" @click="expandAll" title="Arată toate subdiviziunile">Extinde tot</button>
        <button type="button" @click="collapseAll" title="Arată doar primele niveluri">Restrânge</button>
      </div>
      <div v-if="ui.mode === 'chart'" class="seg zoom" role="group" aria-label="Mărire">
        <button type="button" :class="{ on: ui.fit }" @click="ui.fit = true; fitChart()" title="Micșorează schema ca să încapă întreagă pe ecran">Potrivește</button>
        <button type="button" @click="setZoom(-0.1)" :disabled="ui.zoom <= 0.2" aria-label="Micșorează">−</button>
        <button type="button" class="zoom-val" @click="setZoom(0)" title="Mărime normală">{{ zoomPct }}</button>
        <button type="button" @click="setZoom(0.1)" :disabled="ui.zoom >= 1.5" aria-label="Mărește">+</button>
      </div>
    </div>

    <div v-if="results" class="card org-results">
      <div v-if="!results.people.length && !results.units.length" class="muted">Nimic găsit pentru „{{ q.trim() }}”.</div>
      <template v-if="results.units.length">
        <div class="section-title">Subdiviziuni</div>
        <div class="res-units">
          <button v-for="u in results.units" :key="u.id" type="button" class="res-unit" @click="reveal(u.id)">
            <b>{{ u.name }}</b><span class="muted small">{{ unitPath(u.id).slice(0, -1).join(' › ') || u.type || 'nivel superior' }}</span>
          </button>
        </div>
      </template>
      <template v-if="results.people.length">
        <div class="section-title" :class="{ spaced: results.units.length }">Persoane</div>
        <ul class="people res-people">
          <li v-for="p in results.people" :key="p.id" class="res-person">
            <ul class="bare"><OrgPerson :p="p" /></ul>
            <button v-if="p.unit_id && store.units.some((x) => x.id === p.unit_id)" type="button" class="btn link small" @click="reveal(p.unit_id)">{{ unitPath(p.unit_id).slice(-1)[0] }} ›</button>
            <span v-else class="muted small">fără subdiviziune</span>
          </li>
        </ul>
        <p v-if="results.more" class="muted small hint">Sunt afișate primele 60 de persoane; restrângeți căutarea.</p>
      </template>
    </div>

    <div v-if="!roots.length" class="card empty">
      Organigrama nu a fost încă definită.
      <div v-if="admin" class="mt10"><button class="btn primary" @click="addUnit(null)">+ Adaugă prima subdiviziune</button></div>
    </div>

    <div v-else-if="ui.mode === 'chart'" ref="scroll" class="oc-scroll card" @mousedown="pan">
      <div ref="canvas" class="oc-canvas" :style="{ zoom: ui.zoom }">
        <ul ref="root" class="oc-level oc-root">
          <OrgChartNode v-for="u in roots" :key="u.id" :unit="u" :depth="0" />
        </ul>
      </div>
    </div>

    <div v-else class="ol-tree">
      <OrgListNode v-for="u in roots" :key="u.id" :unit="u" :depth="0" />
    </div>

    <div v-if="admin && unassigned.length" class="card ol-card unassigned">
      <div class="ol-head"><h3>Fără subdiviziune</h3><span class="muted small">{{ plural(unassigned.length, 'persoană', 'persoane') }} · atribuiți-le din pagina „Angajați”</span></div>
      <ul class="people">
        <OrgPerson v-for="p in unassigned" :key="p.id" :p="p" />
      </ul>
    </div>

    <Modal v-if="unitForm" :title="unitForm.id ? 'Modifică subdiviziunea' : 'Subdiviziune nouă'" :busy="busy" @close="unitForm = null" @submit="saveUnit">
      <label class="field"><span>Denumirea *</span><input v-model="unitForm.name" maxlength="200" required autofocus placeholder="ex. Direcția juridică" /></label>
      <div class="row">
        <label class="field"><span>Tipul</span>
          <input v-model="unitForm.type" maxlength="60" list="unit-types" placeholder="ex. Direcție" />
          <datalist id="unit-types"><option>Conducere</option><option>Direcție</option><option>Serviciu</option><option>Secție</option></datalist>
        </label>
        <label class="field"><span>Ordinea de afișare</span><input v-model.number="unitForm.sort" type="number" /></label>
      </div>
      <label class="field"><span>Subordonată față de</span>
        <select v-model="unitForm.parent_id">
          <option :value="null">— nivelul superior —</option>
          <option v-for="u in parents" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
      </label>
    </Modal>
    <UserForm v-if="userUnit" :unit-id="userUnit" @close="userUnit = null" @saved="userUnit = null" />`,
};

// ---------- categorii și etichete ----------
const CategoriesView = {
  components: { Modal, Icon },
  data: () => ({ catForm: null, newTag: {}, busy: false }),
  computed: { store: () => store },
  methods: {
    act(fn, msg) {
      return run(async () => {
        await fn();
        store.categories = await api('/api/categories');
      }, msg);
    },
    // ordinea de aici este ordinea din bara laterală a documentelor și din formulare
    move(i, step) {
      const ids = store.categories.map((c) => c.id);
      ids.splice(i + step, 0, ids.splice(i, 1)[0]);
      const before = store.categories;
      store.categories = ids.map((id) => before.find((c) => c.id === id)); // imediat, fără să aștepte serverul
      run(() => api('/api/categories/order', { method: 'POST', body: { ids } })).then((ok) => {
        if (!ok) store.categories = before;
      });
    },
    async saveCat() {
      const f = this.catForm;
      this.busy = true;
      const ok = await this.act(() => api(f.id ? '/api/categories/' + f.id : '/api/categories', { method: f.id ? 'PUT' : 'POST', body: f }), 'Categoria a fost salvată.');
      this.busy = false;
      if (ok) this.catForm = null;
    },
    async removeCat(c) {
      const ok = await ask({
        title: 'Ștergeți categoria?',
        message: '„' + c.name + '” va fi ștearsă împreună cu toate etichetele ei. Documentele rămân, dar pierd aceste etichete.',
        okLabel: 'Șterge categoria',
        danger: true,
      });
      if (ok) this.act(() => api('/api/categories/' + c.id, { method: 'DELETE' }), 'Categoria a fost ștearsă.');
    },
    async addTag(c) {
      const name = (this.newTag[c.id] || '').trim();
      if (!name) return;
      if (await this.act(() => api('/api/tags', { method: 'POST', body: { category_id: c.id, name } }))) this.newTag[c.id] = '';
    },
    async renameTag(t) {
      const name = await ask({ title: 'Redenumește eticheta', input: true, label: 'Denumirea etichetei', value: t.name, maxlength: 80, okLabel: 'Salvează' });
      if (name && name !== t.name) this.act(() => api('/api/tags/' + t.id, { method: 'PUT', body: { name } }), 'Eticheta a fost redenumită.');
    },
    async removeTag(t) {
      const ok = await ask({
        title: 'Ștergeți eticheta?',
        message: '„' + t.name + '” va fi ștearsă. Documentele rămân, dar pierd această etichetă.',
        okLabel: 'Șterge eticheta',
        danger: true,
      });
      if (ok) this.act(() => api('/api/tags/' + t.id, { method: 'DELETE' }), 'Eticheta a fost ștearsă.');
    },
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Categorii și etichete</h1>
        <p class="muted page-sub">Categoriile grupează etichetele (ex. „Resurse umane” → „Concedii”). La adăugarea unui document se aleg una sau mai multe etichete. Săgețile schimbă ordinea categoriilor în toată aplicația.</p>
      </div>
      <button class="btn primary" @click="catForm = { id: null, name: '', color: '#1d4e89', sort: 0 }">+ Adaugă categorie</button>
    </div>
    <div class="cats">
      <div v-for="(c, i) in store.categories" :key="c.id" class="card cat" :style="{ borderTopColor: c.color }">
        <div class="cat-head">
          <span class="cat-pos" :title="'Poziția ' + (i + 1) + ' în listă'">{{ i + 1 }}</span>
          <h2 :title="c.name">{{ c.name }}</h2>
          <button class="icon-btn" :disabled="i === 0" title="Mută mai în față" aria-label="Mută categoria mai în față" @click="move(i, -1)"><Icon name="left" /></button>
          <button class="icon-btn" :disabled="i === store.categories.length - 1" title="Mută mai în spate" aria-label="Mută categoria mai în spate" @click="move(i, 1)"><Icon name="right" /></button>
          <button class="icon-btn" title="Modifică categoria" @click="catForm = { id: c.id, name: c.name, color: c.color, sort: c.sort }"><Icon name="edit" /></button>
          <button class="icon-btn danger" title="Șterge categoria" @click="removeCat(c)"><Icon name="trash" /></button>
        </div>
        <div v-for="t in c.tags" :key="t.id" class="tagrow">
          <span class="tagname" :title="t.name">{{ t.name }}</span>
          <button class="icon-btn" title="Redenumește eticheta" @click="renameTag(t)"><Icon name="edit" /></button>
          <button class="icon-btn danger" title="Șterge eticheta" @click="removeTag(t)"><Icon name="trash" /></button>
        </div>
        <div v-if="!c.tags.length" class="muted small">Nicio etichetă încă.</div>
        <form class="addrow" @submit.prevent="addTag(c)">
          <input v-model="newTag[c.id]" maxlength="80" placeholder="Etichetă nouă…" />
          <button class="btn">Adaugă</button>
        </form>
      </div>
    </div>
    <div v-if="!store.categories.length" class="card empty">Nicio categorie. Adăugați prima categorie pentru a putea eticheta documentele.</div>

    <Modal v-if="catForm" :title="catForm.id ? 'Modifică categoria' : 'Categorie nouă'" :busy="busy" @close="catForm = null" @submit="saveCat">
      <label class="field"><span>Denumirea *</span><input v-model="catForm.name" maxlength="80" required autofocus placeholder="ex. Resurse umane" /></label>
      <label class="field"><span>Culoarea</span><input v-model="catForm.color" type="color" /></label>
    </Modal>`,
};

// ---------- jurnal de audit ----------
const yesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const AuditView = {
  data: () => ({ rows: [], total: 0, oldest: null, retention: 90, q: '', until: yesterday(), busy: false, loaded: false }),
  computed: {
    shown() {
      const q = this.q.trim().toLowerCase();
      return q ? this.rows.filter((r) => (r.username + ' ' + r.action + ' ' + r.details + ' ' + r.ip).toLowerCase().includes(q)) : this.rows;
    },
    maxDate: yesterday,
  },
  methods: {
    fmtDateTime,
    async load() {
      await run(async () => {
        const r = await api('/api/admin/audit');
        Object.assign(this, { rows: r.rows, total: r.total, oldest: r.oldest, retention: r.retentionDays });
      });
      this.loaded = true;
    },
    async prune() {
      if (!this.until) return;
      const shown = this.until.split('-').reverse().join('.');
      const ok = await ask({
        title: 'Curățați jurnalul?',
        message: 'Toate înregistrările până la ' + shown + ' inclusiv vor fi șterse definitiv. Ștergerea va rămâne consemnată în jurnal.',
        okLabel: 'Șterge înregistrările',
        danger: true,
      });
      if (!ok) return;
      this.busy = true;
      let r;
      if (await run(async () => (r = await api('/api/admin/audit/prune', { method: 'POST', body: { until: this.until } })))) {
        toast(r.deleted ? r.deleted + ' înregistrări au fost șterse.' : 'Nu existau înregistrări până la această dată.');
        await this.load();
      }
      this.busy = false;
    },
  },
  mounted() {
    this.load();
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Jurnal de activitate</h1>
        <p class="muted page-sub">
          Autentificări, descărcări, semnări și modificări. {{ total }} înregistrări<template v-if="oldest">, începând cu {{ fmtDateTime(oldest) }}</template><template v-if="total > rows.length"> (sunt afișate ultimele {{ rows.length }})</template>.
          Înregistrările mai vechi de {{ retention }} de zile se șterg automat.
        </p>
      </div>
      <div class="head-actions">
        <input v-model="q" type="search" placeholder="Filtrează după utilizator, acțiune, document…" class="search-sm" aria-label="Filtrează jurnalul" />
        <form class="prune" @submit.prevent="prune">
          <label class="prune-label" for="prune-until">Șterge până la</label>
          <input id="prune-until" v-model="until" type="date" :max="maxDate" required />
          <button class="btn danger" :disabled="busy || !until">{{ busy ? 'Se șterge…' : 'Curăță' }}</button>
        </form>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Data</th><th>Utilizator</th><th>Acțiune</th><th>Detalii</th><th>Adresă IP</th></tr></thead>
        <tbody>
          <tr v-for="r in shown" :key="r.id">
            <td class="nowrap">{{ fmtDateTime(r.at) }}</td>
            <td><b>{{ r.username || '—' }}</b></td>
            <td>{{ r.action }}</td>
            <td>{{ r.details }}</td>
            <td class="muted small">{{ r.ip }}</td>
          </tr>
          <tr v-if="loaded && !shown.length"><td colspan="5" class="empty-row">{{ rows.length ? 'Nicio înregistrare nu corespunde filtrului.' : 'Jurnalul este gol.' }}</td></tr>
        </tbody>
      </table>
    </div>`,
};

// ---------- setări ----------
const SettingsView = {
  components: { BackupView },
  data: () => ({ f: null, busy: false, testTo: '' }),
  async mounted() {
    await run(async () => this.fill(await api('/api/admin/settings')));
    this.testTo = store.me.email || '';
  },
  methods: {
    fill(s) {
      this.f = { ...s, smtp_pass: '', clear_password: false, office_secret: '', clear_office_secret: false };
      store.me.mailEnabled = !!s.smtp_host;
      store.me.office = !!(s.office_url && s.has_office_secret);
    },
    async save() {
      this.busy = true;
      await run(async () => this.fill(await api('/api/admin/settings', { method: 'PUT', body: this.f })), 'Setările au fost salvate.');
      this.busy = false;
    },
    async test() {
      this.busy = true;
      await run(() => api('/api/admin/settings/test', { method: 'POST', body: { to: this.testTo } }), 'E-mailul de test a fost trimis către ' + this.testTo + '.');
      this.busy = false;
    },
  },
  template: /*html*/ `
    <div class="settings-page">
      <div class="page-head">
        <div>
          <h1>Setări</h1>
          <p class="muted page-sub">E-mailul pentru notificări, editorul de documente și copia de rezervă a datelor.</p>
        </div>
      </div>
      <div class="settings-grid">
        <form v-if="f" class="card panel" @submit.prevent="save">
          <div class="panel-head">
            <h2>E-mail (SMTP)</h2>
            <span class="pill" :class="f.smtp_host ? 'green' : 'gray'">{{ f.smtp_host ? 'Activ' : 'Dezactivat' }}</span>
          </div>
          <p class="muted small">Setările sunt păstrate în baza de date și rămân la actualizarea aplicației. Lăsați serverul gol pentru a dezactiva e-mailurile.</p>
          <div class="row">
            <label class="field grow2"><span>Server SMTP</span><input v-model="f.smtp_host" maxlength="200" placeholder="ex. mail.ansc.md" /></label>
            <label class="field"><span>Port</span><input v-model="f.smtp_port" inputmode="numeric" maxlength="5" placeholder="587" /></label>
            <label class="field"><span>Securitate</span>
              <select v-model="f.smtp_secure"><option value="">STARTTLS / automat</option><option value="tls">TLS direct (465)</option></select>
            </label>
          </div>
          <div class="row">
            <label class="field"><span>Utilizator</span><input v-model="f.smtp_user" maxlength="200" autocomplete="off" /></label>
            <label class="field"><span>Parolă</span>
              <input v-model="f.smtp_pass" type="password" autocomplete="new-password" :disabled="f.clear_password" :placeholder="f.has_password ? '•••••••• (salvată)' : ''" />
            </label>
          </div>
          <label v-if="f.has_password" class="check pull-up"><input type="checkbox" v-model="f.clear_password" /> Șterge parola salvată</label>
          <div class="row">
            <label class="field"><span>Expeditor</span><input v-model="f.smtp_from" maxlength="200" placeholder="e-Management ANSC <notificari@ansc.md>" /></label>
            <label class="field"><span>Adresa aplicației (linkuri în e-mailuri)</span><input v-model="f.app_url" maxlength="200" placeholder="ex. https://documente.ansc.md" /></label>
          </div>
          <div class="panel-foot">
            <button class="btn primary" :disabled="busy">Salvează setările</button>
          </div>
          <div class="test-box">
            <div><b>Verificare</b> <span class="muted small">— salvați setările, apoi trimiteți un e-mail de test.</span></div>
            <div class="addrow">
              <input v-model="testTo" type="email" placeholder="adresa@exemplu.md" aria-label="Adresa pentru e-mailul de test" />
              <button type="button" class="btn" :disabled="busy || !testTo || !f.smtp_host" @click="test">Trimite test</button>
            </div>
          </div>
        </form>
        <div v-else class="card panel boot-panel"><span class="spinner"></span></div>
        <!-- coloana din mijloc: editorul de documente, cu asistenții AI dedesubt -->
        <div v-if="f" class="settings-col stack">
        <form class="card panel" @submit.prevent="save">
          <div class="panel-head">
            <h2>Editor de documente</h2>
            <span class="pill" :class="f.office_url && (f.has_office_secret || f.office_secret) ? 'green' : 'gray'">{{ f.office_url && f.has_office_secret ? 'Activ' : 'Dezactivat' }}</span>
          </div>
          <p class="muted small">Serverul ONLYOFFICE Docs din rețeaua internă, pentru deschiderea și modificarea fișierelor direct în pagină (avizare). Cheia secretă este aceeași cu JWT_SECRET al serverului de documente.</p>
          <label class="field"><span>Adresa serverului de documente</span><input v-model="f.office_url" maxlength="200" placeholder="ex. http://docs.ansc.local:8080" /></label>
          <label class="field"><span>Cheia secretă (JWT)</span>
            <input v-model="f.office_secret" type="password" autocomplete="new-password" :disabled="f.clear_office_secret" :placeholder="f.has_office_secret ? '•••••••• (salvată)' : ''" />
          </label>
          <label class="field"><span>Adresa aplicației pentru serverul de documente <span class="opt">(opțional)</span></span><input v-model="f.office_app_url" maxlength="200" placeholder="implicit: Adresa aplicației; ex. http://10.0.0.5:3080" /></label>
          <label v-if="f.has_office_secret" class="check pull-up"><input type="checkbox" v-model="f.clear_office_secret" /> Șterge cheia salvată (dezactivează editorul)</label>
          <div class="panel-foot">
            <button class="btn primary" :disabled="busy">Salvează setările</button>
          </div>
        </form>
        <form class="card panel" @submit.prevent="save">
          <div class="panel-head">
            <h2>Asistenți AI (MCP)</h2>
            <span class="pill" :class="f.mcp_enabled ? 'green' : 'gray'">{{ f.mcp_enabled ? 'Permis' : 'Oprit' }}</span>
          </div>
          <p class="muted small">
            Prin jetoane personale (butonul „Asistent AI”), un asistent precum Claude lucrează în numele angajatului, cu aceleași drepturi.
            Nu poate semna sau șterge; acțiunile apar în jurnal cu [AI]. Oprirea blochează imediat toate jetoanele.
          </p>
          <div class="panel-foot">
            <label class="check grow"><input type="checkbox" v-model="f.mcp_enabled" /> Permite accesul asistenților AI</label>
            <button class="btn primary" :disabled="busy">Salvează</button>
          </div>
        </form>
        </div>
        <div class="settings-col"><BackupView /></div>
      </div>
    </div>`,
};

// ---------- angajați ----------
// Lista angajaților: vizibilă tuturor (nume, funcție, subdiviziune, telefon, e-mail).
// Administratorii văd în plus conturile (utilizator, rol, stare), inclusiv pe cele dezactivate,
// și pot modifica datele, inclusiv telefonul, direct din listă.
const AbsenceForm = {
  components: { Modal, Icon },
  props: { user: Object },
  emits: ['close'],
  data() {
    return { busy: false, form: { kind: store.absenceKinds[0] || '', from_date: store.today || today(), to_date: store.today || today(), note: '', substitute_id: '' } };
  },
  computed: {
    store: () => store,
    list() {
      return store.absences.filter((a) => a.user_id === this.user.id);
    },
    // înlocuitorul: orice alt angajat activ, cei din aceeași subdiviziune primii
    candidates() {
      const same = (u) => (u.unit_id && u.unit_id === this.user.unit_id ? 0 : 1);
      return store.users.filter((u) => u.id !== this.user.id).sort((a, b) => same(a) - same(b) || a.full_name.localeCompare(b.full_name));
    },
  },
  methods: {
    fmtDay,
    userName,
    current: (a) => a.from_date <= (store.today || today()),
    async submit() {
      this.busy = true;
      let r;
      const ok = await run(async () => {
        r = await api('/api/absences', { method: 'POST', body: { ...this.form, substitute_id: this.form.substitute_id || null, user_id: this.user.id } });
        await loadShared();
      });
      this.busy = false;
      if (!ok) return;
      toast(r.movedDocs ? 'Absența a fost adăugată. ' + plural(r.movedDocs, 'document a trecut', 'documente au trecut') + ' la următorul semnatar.' : 'Absența a fost adăugată.');
      this.form.note = '';
      this.form.substitute_id = '';
      if (store.docsLoaded) loadDocs().catch(() => {});
    },
    async remove(a) {
      const yes = await ask({ title: 'Anulați absența?', message: this.user.full_name + ': ' + absenceText(a) + '. Persoana își reia locul în ordinea de semnare.', okLabel: 'Anulează absența', danger: true });
      if (!yes) return;
      const ok = await run(async () => {
        await api('/api/absences/' + a.id, { method: 'DELETE' });
        await loadShared();
      }, 'Absența a fost anulată.');
      if (ok && store.docsLoaded) loadDocs().catch(() => {});
    },
  },
  template: /*html*/ `
    <Modal :title="'Absențe: ' + user.full_name" :busy="busy" ok-label="Adaugă absența" busy-label="Se adaugă…" cancel-label="Închide" @close="$emit('close')" @submit="submit">
      <ul v-if="list.length" class="abs-list">
        <li v-for="a in list" :key="a.id" :class="{ now: current(a) }">
          <Icon name="calendar" />
          <span class="abs-txt"><b>{{ a.kind }}</b><span class="small">{{ fmtDay(a.from_date) }} – {{ fmtDay(a.to_date) }}{{ current(a) ? ' · în curs' : ' · programată' }}</span><span v-if="a.substitute_id" class="small sub-line"><Icon name="swap" />înlocuit de {{ userName(a.substitute_id) || '—' }}</span><span v-if="a.note" class="muted small">{{ a.note }}</span></span>
          <button type="button" class="icon-btn danger" title="Anulează absența" aria-label="Anulează absența" @click="remove(a)"><Icon name="trash" /></button>
        </li>
      </ul>
      <p v-else class="muted small">Nu are absențe în curs sau programate.</p>
      <h3 class="abs-head">Absență nouă</h3>
      <label class="field"><span>Tipul absenței *</span>
        <select v-model="form.kind" required>
          <option v-for="k in store.absenceKinds" :key="k" :value="k">{{ k }}</option>
        </select>
      </label>
      <div class="row">
        <label class="field"><span>De la *</span><input v-model="form.from_date" type="date" required /></label>
        <label class="field"><span>Până la (inclusiv) *</span><input v-model="form.to_date" type="date" :min="form.from_date" required /></label>
      </div>
      <label class="field"><span>Înlocuitor <span class="opt">(opțional)</span></span>
        <select v-model="form.substitute_id">
          <option value="">Fără înlocuitor: semnează la întoarcere</option>
          <option v-for="u in candidates" :key="u.id" :value="u.id">{{ u.full_name }}{{ u.position ? ' · ' + u.position : '' }}</option>
        </select>
      </label>
      <label class="field"><span>Observație <span class="opt">(o vede doar administratorul)</span></span><input v-model="form.note" maxlength="300" placeholder="de ex. ordinul de concediu nr. …" /></label>
      <p class="muted small hint">{{ form.substitute_id ? 'Pe durata absenței, ' + userName(Number(form.substitute_id)) + ' vede documentele pe care ' + user.full_name + ' le are de semnat și le semnează în locul acestuia; ordinea de semnare nu se schimbă.' : 'Fără înlocuitor, persoana trece la finalul ordinii de semnare, iar ceilalți semnatari nu o mai așteaptă.' }} Colegii văd în listă că este absentă.</p>
    </Modal>`,
};

const PeopleView = {
  components: { UserForm, ImportPeople, AbsenceForm, Icon },
  data: () => ({ accounts: [], editing: undefined, q: '', unit: '', loaded: false, importing: false, absenceOf: null, onlyAway: false }),
  computed: {
    store: () => store,
    admin: () => isAdmin(),
    units: () => flatUnits(),
    people() {
      return this.admin ? this.accounts : store.users;
    },
    shown() {
      const q = fold(this.q);
      const inUnit = this.unit === '' ? null : subtreeIds(Number(this.unit));
      return this.people.filter((u) => {
        if (inUnit && !inUnit.has(u.unit_id)) return false;
        if (this.onlyAway && !absenceNow(u.id)) return false;
        if (!q) return true;
        return fold([u.full_name, u.username, u.position, u.email, u.phone, u.unit_id ? unitName(u.unit_id) : ''].join(' ')).includes(q);
      });
    },
    summary() {
      const n = this.people.length;
      const away = this.awayCount ? ' · ' + plural(this.awayCount, 'absent azi', 'absenți azi') : '';
      if (!this.admin) return plural(n, 'angajat', 'angajați') + away;
      return plural(n, 'cont', 'conturi') + ', dintre care ' + this.people.filter((u) => u.active).length + ' active' + away;
    },
    awayCount() {
      return this.people.filter((u) => absenceNow(u.id)).length;
    },
  },
  methods: {
    unitName,
    initials,
    avatarStyle,
    role: (r) => ROLES[r],
    absenceNow,
    absenceNext,
    userName,
    fmtDay,
    tel: (p) => 'tel:' + String(p).replace(/[^0-9+]/g, ''),
    async load() {
      if (this.admin) await run(async () => (this.accounts = await api('/api/users')));
      this.loaded = true;
    },
    async saved() {
      this.editing = undefined;
      await this.load();
    },
    async setPhone(u) {
      const phone = await ask({ title: 'Telefon: ' + u.full_name, input: true, label: 'Numărul de telefon', value: u.phone || '', maxlength: 40, okLabel: 'Salvează' });
      if (phone === null) return;
      const ok = await run(async () => {
        await api('/api/users/' + u.id, { method: 'PUT', body: { ...u, phone, active: !!u.active } });
        await loadShared();
      }, 'Telefonul a fost salvat.');
      if (ok) this.load();
    },
    async remove(u) {
      const ok = await ask({
        title: 'Ștergeți contul?',
        message: 'Contul „' + u.full_name + '” va fi șters definitiv. Documentele adăugate de această persoană rămân în sistem. Dacă persoana doar a plecat din instituție, puteți dezactiva contul în loc să îl ștergeți.',
        okLabel: 'Șterge contul',
        danger: true,
      });
      if (!ok) return;
      const done = await run(async () => {
        await api('/api/users/' + u.id, { method: 'DELETE' });
        await loadShared();
      }, 'Contul a fost șters.');
      if (done) this.load();
    },
  },
  mounted() {
    this.load();
  },
  template: /*html*/ `
    <div class="page-head">
      <div>
        <h1>Angajați</h1>
        <p class="muted page-sub">{{ summary }}</p>
      </div>
      <div v-if="admin" class="head-actions">
        <button class="btn" @click="importing = true">Importă din CSV…</button>
        <button class="btn primary" @click="editing = null">+ Adaugă angajat</button>
      </div>
    </div>
    <div class="toolbar">
      <input v-model="q" type="search" placeholder="Caută după nume, funcție, telefon, e-mail…" aria-label="Caută angajați" />
      <select v-model="unit" class="unit-filter" aria-label="Subdiviziunea">
        <option value="">Toate subdiviziunile</option>
        <option v-for="x in units" :key="x.id" :value="String(x.id)">{{ x.label }}</option>
      </select>
      <label v-if="awayCount || onlyAway" class="check away-filter"><input type="checkbox" v-model="onlyAway" /> Doar absenții azi</label>
    </div>
    <div class="card table-wrap">
      <table class="people-table">
        <thead>
          <tr>
            <th>Angajat</th><th>Subdiviziunea</th><th>Telefon</th><th>E-mail</th>
            <template v-if="admin"><th>Cont</th><th>Rol</th><th></th></template>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in shown" :key="u.id" :class="{ off: admin && !u.active }" :title="admin && !u.active ? 'Cont dezactivat' : null">
            <td>
              <span class="who">
                <span class="avatar sm" :style="avatarStyle(u.full_name)">{{ initials(u.full_name) }}</span>
                <span class="who-txt"><b>{{ u.full_name }}</b><span class="muted small">{{ u.position || '—' }}</span>
                  <span v-if="absenceNow(u.id)" class="away-badge" :title="absenceNow(u.id).kind + ', ' + fmtDay(absenceNow(u.id).from_date) + ' – ' + fmtDay(absenceNow(u.id).to_date) + (absenceNow(u.id).substitute_id ? ' · înlocuit de ' + userName(absenceNow(u.id).substitute_id) : '')"><Icon name="calendar" />Absent până la {{ fmtDay(absenceNow(u.id).to_date) }}</span>
                  <span v-else-if="absenceNext(u.id)" class="away-badge next"><Icon name="calendar" />{{ absenceNext(u.id).kind }} din {{ fmtDay(absenceNext(u.id).from_date) }}</span>
                </span>
              </span>
            </td>
            <td class="small">{{ u.unit_id ? unitName(u.unit_id) : '—' }}</td>
            <td class="nowrap">
              <a v-if="u.phone" class="plain" :href="tel(u.phone)">{{ u.phone }}</a>
              <button v-else-if="admin" class="btn link sm" @click="setPhone(u)">+ Adaugă</button>
              <span v-else class="muted">—</span>
            </td>
            <td><a v-if="u.email" class="plain" :href="'mailto:' + u.email">{{ u.email }}</a><span v-else class="muted">—</span></td>
            <template v-if="admin">
              <td><code class="uname">{{ u.username }}</code></td>
              <td><span class="badge" :class="{ gray: u.role === 'user', dark: u.role === 'admin' }">{{ role(u.role) }}</span></td>
              <td class="row-actions">
                <button class="icon-btn" title="Absențe (concediu, deplasare)" aria-label="Absențe" @click="absenceOf = u"><Icon name="calendar" /></button>
                <button class="icon-btn" title="Modifică" aria-label="Modifică" @click="editing = u"><Icon name="edit" /></button>
                <button v-if="u.id !== store.me.id" class="icon-btn danger" title="Șterge contul" aria-label="Șterge contul" @click="remove(u)"><Icon name="trash" /></button>
              </td>
            </template>
          </tr>
          <tr v-if="loaded && !shown.length"><td :colspan="admin ? 7 : 4" class="empty-row">{{ people.length ? 'Niciun angajat nu corespunde căutării.' : 'Nu există angajați.' }}</td></tr>
        </tbody>
      </table>
    </div>
    <UserForm v-if="editing !== undefined" :user="editing" @close="editing = undefined" @saved="saved" />
    <ImportPeople v-if="importing" @close="importing = false" @done="(importing = false), load()" />
    <AbsenceForm v-if="absenceOf" :user="absenceOf" @close="absenceOf = null" />`,
};

// ---------- asistenți AI (MCP) ----------
// Jetoanele personale cu care un asistent AI (Claude sau alt client MCP) lucrează în numele utilizatorului.
// Jetonul se vede o singură dată, la creare; administratorul vede și poate revoca jetoanele tuturor.
const AiTokens = {
  components: { Modal },
  emits: ['close'],
  data: () => ({ info: null, form: { name: '', days: 90, can_write: false }, created: null, busy: false }),
  computed: {
    store: () => store,
    canWriteDocs: () => store.me.role !== 'user',
    // configurația pentru Claude Code / clienții MCP care acceptă antete HTTP
    snippet() {
      if (!this.created) return '';
      return JSON.stringify({ mcpServers: { 'e-management-ansc': { type: 'http', url: this.created.url, headers: { Authorization: 'Bearer ' + this.created.token } } } }, null, 2);
    },
    others() {
      return (this.info && this.info.all ? this.info.all : []).filter((t) => !this.info.tokens.some((m) => m.id === t.id));
    },
  },
  async mounted() {
    await this.load();
  },
  methods: {
    fmtDateTime,
    fmtDay,
    async load() {
      await run(async () => (this.info = await api('/api/tokens')));
    },
    async create() {
      if (this.created) return this.$emit('close');
      this.busy = true;
      await run(async () => {
        this.created = await api('/api/tokens', { method: 'POST', body: { name: this.form.name, days: Number(this.form.days), can_write: this.form.can_write } });
        this.form.name = '';
        await this.load();
      });
      this.busy = false;
    },
    async revoke(t) {
      const ok = await ask({ title: 'Revocă jetonul', message: `Asistentul care folosește „${t.name}” nu va mai avea acces. Continuați?`, okLabel: 'Revocă', danger: true });
      if (ok) await run(async () => (await api('/api/tokens/' + t.id, { method: 'DELETE' }), await this.load()), 'Jetonul a fost revocat.');
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copiat.');
      } catch {
        toast('Copierea nu este permisă de browser; selectați textul și copiați-l manual.', true);
      }
    },
  },
  template: /*html*/ `
    <Modal title="Asistent AI (MCP)" wide :busy="busy" :ok-label="created ? 'Gata' : 'Creează jetonul'" busy-label="Se creează…" :cancel-label="created ? '' : 'Închide'" @close="$emit('close')" @submit="create">
      <div v-if="!info" class="boot-panel"><span class="spinner"></span></div>
      <template v-else>
        <p class="muted small">
          Un asistent AI compatibil MCP (de ex. Claude) poate căuta și citi documentele dvs.<template v-if="canWriteDocs">, adăuga sau modifica documente</template>
          în numele dvs., cu exact aceleași drepturi. Nu poate semna, șterge documente sau schimba setări. Fiecare acțiune apare în jurnal.
          Schimbarea parolei revocă toate jetoanele.
        </p>
        <p v-if="!info.enabled" class="warn">Accesul asistenților AI este oprit. Administratorul îl poate porni în pagina „Setări”.</p>
        <template v-if="created">
          <p><b>Jetonul a fost creat.</b> Copiați-l acum: nu va mai fi afișat.</p>
          <div class="addrow"><input :value="created.token" readonly aria-label="Jetonul" spellcheck="false" @focus="$event.target.select()" /><button type="button" class="btn" @click="copy(created.token)">Copiază</button></div>
          <p class="muted small mt10">Adresa serverului MCP: <code class="uname">{{ created.url }}</code>. Pentru Claude Code (fișierul <code class="uname">.mcp.json</code>) sau alt client care acceptă antete:</p>
          <textarea class="mono-box" rows="11" readonly :value="snippet" @focus="$event.target.select()"></textarea>
          <button type="button" class="btn sm mt4" @click="copy(snippet)">Copiază configurația</button>
        </template>
        <template v-else-if="info.enabled">
          <div class="row">
            <label class="field grow2"><span>Numele jetonului</span><input v-model="form.name" maxlength="80" placeholder="ex. Claude pe laptopul de serviciu" required /></label>
            <label class="field"><span>Valabil</span>
              <select v-model="form.days"><option :value="7">7 zile</option><option :value="30">30 de zile</option><option :value="90">90 de zile</option><option :value="365">un an</option></select>
            </label>
          </div>
          <label class="check pull-up"><input type="checkbox" v-model="form.can_write" />
            {{ canWriteDocs ? 'Permite modificări (adăugare și modificare de documente, notificări)' : 'Permite marcarea documentelor ca văzute' }}</label>
        </template>
        <h3 class="section-title spaced">Jetoanele mele</h3>
        <table>
          <thead><tr><th>Nume</th><th>Drepturi</th><th>Folosit ultima dată</th><th>Expiră</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in info.tokens" :key="t.id">
              <td><b>{{ t.name }}</b></td>
              <td><span class="pill" :class="t.can_write ? 'amber' : 'gray'">{{ t.can_write ? 'citire și modificare' : 'doar citire' }}</span></td>
              <td class="muted small">{{ t.last_used_at ? fmtDateTime(t.last_used_at) : 'niciodată' }}</td>
              <td class="muted small nowrap">{{ fmtDay(t.expires_at.slice(0, 10)) }}</td>
              <td class="row-actions"><button type="button" class="btn sm" @click="revoke(t)">Revocă</button></td>
            </tr>
            <tr v-if="!info.tokens.length"><td colspan="5" class="empty-row">Nu aveți jetoane active.</td></tr>
          </tbody>
        </table>
        <template v-if="others.length">
          <h3 class="section-title spaced">Jetoanele celorlalți angajați</h3>
          <table>
            <thead><tr><th>Angajat</th><th>Nume</th><th>Drepturi</th><th>Folosit ultima dată</th><th></th></tr></thead>
            <tbody>
              <tr v-for="t in others" :key="t.id">
                <td>{{ t.full_name }}</td>
                <td><b>{{ t.name }}</b></td>
                <td><span class="pill" :class="t.can_write ? 'amber' : 'gray'">{{ t.can_write ? 'citire și modificare' : 'doar citire' }}</span></td>
                <td class="muted small">{{ t.last_used_at ? fmtDateTime(t.last_used_at) : 'niciodată' }}</td>
                <td class="row-actions"><button type="button" class="btn sm" @click="revoke(t)">Revocă</button></td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </Modal>`,
};

// ---------- filigran ----------
// Numele, utilizatorul și momentul, repetate discret pe tot ecranul (inclusiv peste ferestre și editor):
// o captură de ecran sau o fotografie a monitorului arată cine a văzut documentul și când.
// Stratul nu primește clicuri și nu este citit de cititoarele de ecran.
const Watermark = {
  data: () => ({ now: new Date() }),
  mounted() {
    this.timer = setInterval(() => (this.now = new Date()), 60000);
  },
  unmounted() {
    clearInterval(this.timer);
  },
  computed: {
    style() {
      const me = store.me;
      const n = this.now;
      const when = String(n.getDate()).padStart(2, '0') + '.' + String(n.getMonth() + 1).padStart(2, '0') + '.' + n.getFullYear() + ' ' + String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      const label = esc(`${me.full_name} · ${me.username} · ${when}`);
      // două rânduri decalate pe fiecare „țiglă”, ca textul să nu formeze coloane
      const text = (x, y) => `<text x="${x}" y="${y}" text-anchor="middle" transform="rotate(-24 ${x} ${y})">${label}</text>`;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="300">` +
        `<g fill="#1b2430" fill-opacity="0.06" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="600">${text(140, 80)}${text(420, 230)}</g></svg>`;
      return { backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` };
    },
  },
  template: /*html*/ `<div class="watermark" aria-hidden="true" :style="style"></div>`,
};

// ---------- aplicația ----------
const App = {
  components: { Login, ForcedPassword, Brand, Modal, DialogHost, PasswordFields, HomeView, DocsView, InboxView, OrgView, PeopleView, CategoriesView, SettingsView, AuditView, OfficeEditor, AiTokens, Watermark, Icon },
  data: () => ({ pass: null, passBusy: false, bump: false, ai: false, menu: false }),
  // meniul contului se închide la un clic în afara lui sau cu Escape
  mounted() {
    this.closeMenu = (e) => {
      if (this.menu && (e.type !== 'keydown' || e.key === 'Escape') && !(e.target.closest && e.target.closest('.usermenu'))) this.menu = false;
    };
    document.addEventListener('mousedown', this.closeMenu);
    document.addEventListener('keydown', this.closeMenu);
  },
  unmounted() {
    document.removeEventListener('mousedown', this.closeMenu);
    document.removeEventListener('keydown', this.closeMenu);
  },
  computed: {
    store: () => store,
    inbox: inboxCount,
    roleName: () => ROLES[store.me.role] || '',
    // [adresă, denumire, componentă]; notificările au propriul buton (cutia poștală) în dreapta barei
    routes() {
      const items = [['acasa', 'Acasă', 'HomeView'], ['documente', 'Documente', 'DocsView'], ['angajati', 'Angajați', 'PeopleView'], ['organigrama', 'Organigramă', 'OrgView'], ['notificari', 'Notificări', 'InboxView']];
      if (isAdmin()) items.push(['categorii', 'Categorii', 'CategoriesView'], ['setari', 'Setări', 'SettingsView'], ['jurnal', 'Jurnal', 'AuditView']);
      return items;
    },
    nav() {
      return this.routes.filter((n) => n[0] !== 'notificari');
    },
    view() {
      // adresele vechi: „#backup” duce la Setări (unde se află și copia de rezervă), „#utilizatori” la Angajați
      const route = { backup: 'setari', utilizatori: 'angajati' }[store.route] || store.route;
      const item = this.routes.find((n) => n[0] === route);
      return item ? item[2] : 'HomeView';
    },
    pageClass() {
      return { wide: this.view === 'CategoriesView', full: this.view === 'OrgView', fit: this.view === 'SettingsView' };
    },
    inboxLabel() {
      return this.inbox ? 'Notificări: ' + this.inbox + (this.inbox === 1 ? ' nouă' : ' noi') : 'Notificări: nicio notificare nouă';
    },
    title() {
      const item = store.me && !store.me.must_change && this.routes.find((n) => n[2] === this.view);
      return (item && this.inbox ? '(' + this.inbox + ') ' : '') + (item ? item[1] + ' · ' : '') + 'e-Management ANSC';
    },
  },
  methods: {
    initials,
    avatarStyle,
    pick(action) {
      this.menu = false;
      if (action === 'ai') this.ai = true;
      else if (action === 'pass') this.pass = { current: '', next: '', again: '' };
      else this.logout();
    },
    async logout() {
      // chiar dacă serverul nu răspunde, pagina nu mai afișează datele contului
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      clearSession();
      this.pass = null;
    },
    async savePass() {
      this.passBusy = true;
      if (await changePassword(this.pass)) this.pass = null;
      this.passBusy = false;
    },
  },
  watch: {
    // titlul ferestrei arată pagina curentă și numărul de notificări
    title: {
      handler(t) {
        document.title = t;
      },
      immediate: true,
    },
    // o notificare nouă face cutia poștală să „sară” o dată, pe lângă animația continuă
    inbox(n, old) {
      if (n > old) {
        this.bump = false;
        requestAnimationFrame(() => (this.bump = true));
        setTimeout(() => (this.bump = false), 900);
      }
    },
  },
  template: /*html*/ `
    <template v-if="store.ready">
      <Login v-if="!store.me" />
      <ForcedPassword v-else-if="store.me.must_change" />
      <template v-else>
        <header class="topbar">
          <div class="topbar-in">
            <Brand />
            <nav class="nav">
              <a v-for="n in nav" :key="n[0]" :href="'#' + n[0]" :class="{ on: view === n[2], sep: n[0] === 'categorii' }">{{ n[1] }}</a>
            </nav>
            <div class="userbox">
              <a href="#notificari" class="mailbox" :class="{ on: view === 'InboxView', has: inbox, bump }" :title="inboxLabel" :aria-label="inboxLabel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 8.5 12 14l9-5.5"/><rect x="3" y="5" width="18" height="14" rx="2.5"/>
                </svg>
                <span v-if="inbox" class="mailbox-count">{{ inbox > 99 ? '99+' : inbox }}</span>
              </a>
              <div class="usermenu" :class="{ open: menu }">
                <button type="button" class="um-btn" :aria-expanded="menu ? 'true' : 'false'" aria-haspopup="menu" @click="menu = !menu">
                  <span class="avatar" :style="avatarStyle(store.me.full_name)">{{ initials(store.me.full_name) }}</span>
                  <span class="um-who"><b>{{ store.me.full_name }}</b><span>{{ roleName }}</span></span>
                  <Icon name="chevron" />
                </button>
                <div v-if="menu" class="um-pop" role="menu">
                  <div class="um-head"><b>{{ store.me.full_name }}</b><span>{{ store.me.position || roleName }}</span></div>
                  <button type="button" role="menuitem" @click="pick('ai')"><Icon name="review" />Asistent AI (MCP)</button>
                  <button type="button" role="menuitem" @click="pick('pass')"><Icon name="lock" />Schimbă parola</button>
                  <button type="button" role="menuitem" class="um-out" @click="pick('out')"><Icon name="left" />Ieșire</button>
                </div>
              </div>
            </div>
          </div>
        </header>
        <main class="page" :class="pageClass"><component :is="view" /></main>
        <AiTokens v-if="ai" @close="ai = false" />
        <Modal v-if="pass" title="Schimbă parola" :busy="passBusy" @close="pass = null" @submit="savePass"><PasswordFields v-model="pass" /></Modal>
        <OfficeEditor v-if="store.editor" :key="store.editor.fileId" :file-id="store.editor.fileId" @close="store.editor = null" />
        <Watermark />
      </template>
    </template>
    <div v-else class="boot" aria-live="polite"><span class="spinner"></span>Se încarcă…</div>
    <DialogHost />
    <div v-if="store.toast" class="toast" :class="{ err: store.toast.err }" :role="store.toast.err ? 'alert' : 'status'" @click="store.toast = null">{{ store.toast.msg }}</div>`,
};

createApp(App).mount('#app');
loadSession();
