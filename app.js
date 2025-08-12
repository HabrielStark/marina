/*
  Payroll Manager — UAH / EUR / USD with local persistence and OpenRouter chat
  Design goals:
  - Mobile-first, dark by default with light support
  - Clean architecture in a single file for simplicity (no build tooling)
*/

// ---------- Utilities

/** @param {unknown} v */
function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/** @param {number} n @param {number} d */
function round(n, d = 2) { const p = 10 ** d; return Math.round((n + Number.EPSILON) * p) / p; }

/**
 * Format money with currency.
 * @param {number} amount
 * @param {string} currency
 */
function formatMoney(amount, currency) {
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 });
  return formatter.format(amount || 0);
}

/** Simple id */
function uid(prefix = 'id') { return `${prefix}_${Math.random().toString(36).slice(2, 9)}`; }

// ---------- Storage

const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  del(key) { localStorage.removeItem(key); }
};

// ---------- Domain Models

/**
 * @typedef {Object} Money
 * @property {number} amount
 * @property {('UAH'|'USD'|'EUR')} currency
 */

/**
 * @typedef {Object} Item
 * @property {string} id
 * @property {('accrual'|'deduction')} type
 * @property {string} label
 * @property {Money} money
 */

/**
 * @typedef {Object} Employee
 * @property {string} id
 * @property {string} name
 * @property {Money} base
 * @property {Item[]} items
 */

/**
 * @typedef {Object} Settings
 * @property {('auto'|'light'|'dark')} theme
 * @property {('UAH'|'USD'|'EUR')} baseCurrency
 * @property {string} openRouterKey
 * @property {string} model
 */

/**
 * @typedef {Object} Rates
 * @property {number} UAH
 * @property {number} USD
 * @property {number} EUR
 * @property {number} timestamp
 */

/** @typedef {{ employees: Employee[], month: string, settings: Settings, rates: Rates | null }} AppState */

const DEFAULT_SETTINGS = /** @type {Settings} */ ({ theme: 'auto', baseCurrency: 'UAH', openRouterKey: '', model: 'openrouter/auto' });

const state = /** @type {AppState} */ ({
  employees: storage.get('employees', []),
  month: storage.get('month', new Date().toISOString().slice(0, 7)),
  settings: storage.get('settings', DEFAULT_SETTINGS),
  rates: storage.get('rates', null)
});

// ---------- Currency & Rates

/**
 * Convert money across currencies using latest rates relative to baseCurrency.
 * Rates format: 1 baseCurrency → x currency.
 * @param {number} amount
 * @param {string} from
 * @param {string} to
 */
function convert(amount, from, to) {
  if (!state.rates) return amount; // fallback, no conversion
  if (from === to) return amount;
  // Normalize to baseCurrency, then to target
  const base = state.settings.baseCurrency;
  const r = state.rates;
  // Map: currency -> rate vs base (1 base -> rate currency)
  const rateOf = (cur) => r[cur];
  let amountInBase;
  if (from === base) amountInBase = amount;
  else amountInBase = amount / rateOf(from);
  if (to === base) return amountInBase;
  return amountInBase * rateOf(to);
}

/** Fetch fresh rates with graceful fallback and caching */
async function fetchRates() {
  const indicator = document.getElementById('ratesIndicator');
  const setIndicator = (text, color) => {
    if (indicator) { indicator.textContent = text; indicator.style.color = color || 'inherit'; }
  };
  setIndicator('…', 'var(--muted)');
  const base = state.settings.baseCurrency;

  // Try multiple sources for robustness
  const sources = [
    // Frankfurter API (ECB) — free, CORS enabled
    `https://api.frankfurter.app/latest?from=${base}&to=USD,EUR,UAH`,
    // Fallback: exchangerate.host
    `https://api.exchangerate.host/latest?base=${base}&symbols=USD,EUR,UAH`
  ];
  let data = null;
  for (const url of sources) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && (j.rates || j.Rates || j.data || j.conversion_rates)) { data = j; break; }
    } catch {}
  }

  if (!data) {
    setIndicator('офлайн', 'var(--danger)');
    return;
  }

  /** @type {Partial<Rates>} */
  const r = { UAH: 1, USD: 1, EUR: 1 };
  if (data.rates) {
    r.USD = data.rates.USD ?? r.USD;
    r.EUR = data.rates.EUR ?? r.EUR;
    r.UAH = data.rates.UAH ?? r.UAH;
  } else if (data.result || data.base) {
    const rates = data.rates || data.result || data.conversion_rates || {};
    r.USD = rates.USD ?? r.USD;
    r.EUR = rates.EUR ?? r.EUR;
    r.UAH = rates.UAH ?? r.UAH;
  }
  r.timestamp = Date.now();
  state.rates = /** @type {Rates} */(r);
  storage.set('rates', state.rates);
  setIndicator(`${base}→$ ${round(r.USD, 3)} € ${round(r.EUR, 3)} ₴ ${round(r.UAH, 3)}`);
}

function ensureFreshRates() {
  const maxAgeMs = 1000 * 60 * 60; // 1h
  if (!state.rates || (Date.now() - (state.rates.timestamp || 0) > maxAgeMs)) {
    fetchRates();
  } else {
    const base = state.settings.baseCurrency;
    const r = state.rates;
    const indicator = document.getElementById('ratesIndicator');
    if (indicator) indicator.textContent = `${base}→$ ${round(r.USD,3)} € ${round(r.EUR,3)} ₴ ${round(r.UAH,3)}`;
  }
}

// ---------- Rendering

const employeesContainer = /** @type {HTMLElement} */(document.getElementById('employeesContainer'));

function render() {
  storage.set('employees', state.employees);
  storage.set('month', state.month);
  storage.set('settings', state.settings);
  renderEmployees();
}

function renderEmployees() {
  const q = (document.getElementById('searchInput'))?.value?.toLowerCase?.() || '';
  const frag = document.createDocumentFragment();
  const filtered = state.employees.filter(e => e.name.toLowerCase().includes(q));
  for (const e of filtered) frag.appendChild(renderEmployeeCard(e));
  employeesContainer.replaceChildren(frag);
}

/** @param {Employee} e */
function renderEmployeeCard(e) {
  const card = document.createElement('article');
  card.className = 'card employee-card';

  // Header
  const header = document.createElement('div');
  header.className = 'employee-header';
  const name = document.createElement('div');
  name.className = 'employee-name';
  name.textContent = e.name;
  const basePill = document.createElement('span');
  basePill.className = 'pill money';
  basePill.textContent = `${formatMoney(e.base.amount, e.base.currency)}`;
  const actions = document.createElement('div');
  actions.className = 'employee-actions';
  const editBtn = button('Изменить');
  editBtn.addEventListener('click', () => openEmployeeDialog(e));
  const delBtn = button('Удалить', 'danger');
  delBtn.addEventListener('click', () => { if (confirm('Удалить сотрудника?')) { delEmployee(e.id); }});
  const addItemBtn = button('+ позиция', 'accent');
  addItemBtn.addEventListener('click', () => openItemDialog(e.id));
  actions.append(editBtn, delBtn, addItemBtn);
  header.append(name, basePill, actions);

  // Items
  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'items';
  for (const it of e.items) itemsWrap.appendChild(renderItem(e.id, it));

  // Totals
  const totalsWrap = document.createElement('div');
  totalsWrap.className = 'totals';
  const totals = computeTotals(e);
  totalsWrap.append(
    kpi('Нетто (UAH)', formatMoney(totals.net.UAH, 'UAH')),
    kpi('Нетто (USD)', formatMoney(totals.net.USD, 'USD')),
    kpi('Нетто (EUR)', formatMoney(totals.net.EUR, 'EUR')),
    kpi('Начисления', formatMoney(totals.accrualsBase.amount, totals.accrualsBase.currency)),
    kpi('Удержания', formatMoney(totals.deductionsBase.amount, totals.deductionsBase.currency))
  );

  card.append(header, itemsWrap, totalsWrap);
  return card;
}

/** @param {string} label @param {string} value */
function kpi(label, value) {
  const d = document.createElement('div');
  d.className = 'kpi';
  const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'value money'; v.textContent = value;
  d.append(l, v); return d;
}

/** @param {string} text @param {'primary'|'accent'|'danger'|'ghost'} [variant]*/
function button(text, variant) {
  const b = document.createElement('button');
  b.className = 'btn' + (variant ? ` ${variant}` : '');
  b.textContent = text; return b;
}

/** @param {string} employeeId @param {Item} it */
function renderItem(employeeId, it) {
  const d = document.createElement('div');
  d.className = 'item';
  const type = document.createElement('div'); type.className = 'type'; type.textContent = it.type === 'accrual' ? 'Начисление' : 'Удержание';
  const label = document.createElement('div'); label.textContent = it.label;
  const amount = document.createElement('div'); amount.className = 'amount money'; amount.textContent = formatMoney(it.money.amount, it.money.currency);
  const actions = document.createElement('div'); actions.className = 'actions';
  const edit = button('Изменить'); edit.addEventListener('click', () => openItemDialog(employeeId, it));
  const del = button('Удалить', 'danger'); del.addEventListener('click', () => { if (confirm('Удалить позицию?')) { delItem(employeeId, it.id); }});
  actions.append(edit, del);
  d.append(type, label, amount, actions);
  return d;
}

/** @param {Employee} e */
function computeTotals(e) {
  const base = e.base;
  let accrualsBase = { ...base, amount: 0 };
  let deductionsBase = { ...base, amount: 0 };

  for (const it of e.items) {
    const amtInBase = convert(it.money.amount, it.money.currency, base.currency);
    if (it.type === 'accrual') accrualsBase.amount += amtInBase;
    else deductionsBase.amount += amtInBase;
  }
  const grossBase = base.amount + accrualsBase.amount;
  const netBaseAmount = grossBase - deductionsBase.amount;

  const net = {
    UAH: convert(netBaseAmount, base.currency, 'UAH'),
    USD: convert(netBaseAmount, base.currency, 'USD'),
    EUR: convert(netBaseAmount, base.currency, 'EUR')
  };
  return { accrualsBase, deductionsBase, net, grossBase };
}

// ---------- Mutations

function addEmployee(name, baseAmount, baseCurrency) {
  const e = /** @type {Employee} */ ({ id: uid('emp'), name, base: { amount: Number(baseAmount), currency: baseCurrency }, items: [] });
  state.employees.push(e); render(); toast('Сотрудник добавлен');
}

function updateEmployee(id, name, baseAmount, baseCurrency) {
  const e = state.employees.find(e => e.id === id); if (!e) return;
  e.name = name; e.base.amount = Number(baseAmount); e.base.currency = baseCurrency; render(); toast('Сотрудник обновлён');
}

function delEmployee(id) {
  state.employees = state.employees.filter(e => e.id !== id); render(); toast('Сотрудник удалён');
}

function addItem(employeeId, type, label, amount, currency) {
  const e = state.employees.find(e => e.id === employeeId); if (!e) return;
  e.items.push({ id: uid('it'), type, label, money: { amount: Number(amount), currency } });
  render(); toast('Позиция добавлена');
}

function updateItem(employeeId, itemId, type, label, amount, currency) {
  const e = state.employees.find(e => e.id === employeeId); if (!e) return;
  const it = e.items.find(i => i.id === itemId); if (!it) return;
  it.type = type; it.label = label; it.money.amount = Number(amount); it.money.currency = currency;
  render(); toast('Позиция обновлена');
}

function delItem(employeeId, itemId) {
  const e = state.employees.find(e => e.id === employeeId); if (!e) return;
  e.items = e.items.filter(i => i.id !== itemId); render(); toast('Позиция удалена');
}

// ---------- Dialogs

const employeeDialog = /** @type {HTMLDialogElement} */(document.getElementById('employeeDialog'));
const itemDialog = /** @type {HTMLDialogElement} */(document.getElementById('itemDialog'));
const settingsDialog = /** @type {HTMLDialogElement} */(document.getElementById('settingsDialog'));

function openEmployeeDialog(e) {
  const title = document.getElementById('employeeDialogTitle');
  const name = /** @type {HTMLInputElement} */(document.getElementById('employeeName'));
  const amount = /** @type {HTMLInputElement} */(document.getElementById('baseSalaryAmount'));
  const currency = /** @type {HTMLSelectElement} */(document.getElementById('baseSalaryCurrency'));
  const idInput = /** @type {HTMLInputElement} */(document.getElementById('employeeId'));
  if (e) {
    title.textContent = 'Редактировать сотрудника';
    name.value = e.name; amount.value = String(e.base.amount); currency.value = e.base.currency; idInput.value = e.id;
  } else {
    title.textContent = 'Новый сотрудник';
    name.value = ''; amount.value = ''; currency.value = 'UAH'; idInput.value = '';
  }
  employeeDialog.showModal();
}

function openItemDialog(employeeId, it) {
  const title = document.getElementById('itemDialogTitle');
  const type = /** @type {HTMLSelectElement} */(document.getElementById('itemType'));
  const label = /** @type {HTMLInputElement} */(document.getElementById('itemLabel'));
  const amount = /** @type {HTMLInputElement} */(document.getElementById('itemAmount'));
  const currency = /** @type {HTMLSelectElement} */(document.getElementById('itemCurrency'));
  const eId = /** @type {HTMLInputElement} */(document.getElementById('itemEmployeeId'));
  const itemId = /** @type {HTMLInputElement} */(document.getElementById('itemId'));
  if (it) {
    title.textContent = 'Редактировать позицию';
    type.value = it.type; label.value = it.label; amount.value = String(it.money.amount); currency.value = it.money.currency; eId.value = employeeId; itemId.value = it.id;
  } else {
    title.textContent = 'Добавить позицию';
    type.value = 'accrual'; label.value = ''; amount.value = ''; currency.value = 'UAH'; eId.value = employeeId; itemId.value = '';
  }
  itemDialog.showModal();
}

// ---------- Settings & Theme

function applyTheme() {
  const root = document.documentElement;
  const val = state.settings.theme;
  if (val === 'auto') {
    root.classList.remove('light');
    root.classList.remove('dark');
  } else if (val === 'light') {
    root.classList.add('light');
    root.classList.remove('dark');
  } else {
    root.classList.add('dark');
    root.classList.remove('light');
  }
}

// ---------- Toast

const toastEl = /** @type {HTMLElement} */(document.getElementById('toast'));
let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text; toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2000);
}

// ---------- Chat (OpenRouter)

const chatDrawer = /** @type {HTMLElement} */(document.getElementById('chatDrawer'));
const chatMessages = /** @type {HTMLElement} */(document.getElementById('chatMessages'));

/** @type {{ role: 'system'|'user'|'assistant', content: string }[]} */
const chatHistory = storage.get('chatHistory', [
  { role: 'system', content: 'Ты — полезный ассистент по вопросам зарплат. Отвечай кратко.' }
]);

function renderChat() {
  chatMessages.replaceChildren();
  for (const m of chatHistory) {
    if (m.role === 'system') continue;
    const d = document.createElement('div'); d.className = `msg ${m.role}`;
    const roleLabel = m.role === 'user' ? 'Пользователь' : 'Ассистент';
    d.innerHTML = `<div class="role">${roleLabel}</div><div>${escapeHtml(m.content)}</div>`;
    chatMessages.appendChild(d);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function openChat() { chatDrawer.classList.add('open'); renderChat(); }
function closeChat() { chatDrawer.classList.remove('open'); }

function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

async function sendChat(message) {
  if (!message.trim()) return;
  chatHistory.push({ role: 'user', content: message });
  storage.set('chatHistory', chatHistory);
  renderChat();
  try {
    const key = state.settings.openRouterKey.trim();
    if (!key) throw new Error('Отсутствует API‑ключ OpenRouter. Добавьте его в Настройках.');
    const model = state.settings.model || 'openrouter/auto';
    // Use text completion/chat compatible endpoint
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'Учет зарплат'
      },
      body: JSON.stringify({
        model,
        messages: chatHistory.map(m => ({ role: m.role, content: m.content })),
        temperature: 0.2,
        stream: false
      })
    });
    if (!resp.ok) throw new Error(`Ошибка OpenRouter ${resp.status}`);
    const data = await resp.json();
    const assistantText = data?.choices?.[0]?.message?.content || '(нет ответа)';
    chatHistory.push({ role: 'assistant', content: assistantText });
    storage.set('chatHistory', chatHistory);
    renderChat();
  } catch (err) {
    chatHistory.push({ role: 'assistant', content: `Ошибка: ${(/** @type {any} */(err)).message}` });
    renderChat();
  }
}

// ---------- Company totals dialog

function openCompanyTotals() {
  const all = state.employees.map(e => computeTotals(e));
  const sumNet = { UAH: 0, USD: 0, EUR: 0 };
  for (const t of all) { sumNet.UAH += t.net.UAH; sumNet.USD += t.net.USD; sumNet.EUR += t.net.EUR; }
  alert(`Итоговая зарплата компании:\nUAH: ${formatMoney(sumNet.UAH, 'UAH')}\nUSD: ${formatMoney(sumNet.USD, 'USD')}\nEUR: ${formatMoney(sumNet.EUR, 'EUR')}`);
}

// ---------- Event wiring

window.addEventListener('DOMContentLoaded', () => {
  // Theme
  applyTheme();

  // Month
  const monthPicker = /** @type {HTMLInputElement} */(document.getElementById('monthPicker'));
  monthPicker.value = state.month;
  monthPicker.addEventListener('change', () => { state.month = monthPicker.value; render(); });

  // Search
  const searchInput = /** @type {HTMLInputElement} */(document.getElementById('searchInput'));
  searchInput.addEventListener('input', () => renderEmployees());

  // Header
  document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
    const cur = state.settings.theme;
    state.settings.theme = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark';
    storage.set('settings', state.settings); applyTheme();
  });
  document.getElementById('refreshRatesBtn')?.addEventListener('click', () => fetchRates());
  document.getElementById('openSettingsBtn')?.addEventListener('click', () => settingsDialog.showModal());
  document.getElementById('openChatBtn')?.addEventListener('click', () => openChat());

  // Employees
  document.getElementById('addEmployeeBtn')?.addEventListener('click', () => openEmployeeDialog());
  document.getElementById('companyTotalsBtn')?.addEventListener('click', () => openCompanyTotals());

  // Employee form
  const employeeForm = /** @type {HTMLFormElement} */(document.getElementById('employeeForm'));
  employeeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = /** @type {HTMLInputElement} */(document.getElementById('employeeName')).value.trim();
    const amount = /** @type {HTMLInputElement} */(document.getElementById('baseSalaryAmount')).value;
    const currency = /** @type {HTMLSelectElement} */(document.getElementById('baseSalaryCurrency')).value;
    const id = /** @type {HTMLInputElement} */(document.getElementById('employeeId')).value;
    if (id) updateEmployee(id, name, Number(amount), currency); else addEmployee(name, Number(amount), currency);
    employeeDialog.close();
  });

  // Item form
  const itemForm = /** @type {HTMLFormElement} */(document.getElementById('itemForm'));
  itemForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const type = /** @type {HTMLSelectElement} */(document.getElementById('itemType')).value;
    const label = /** @type {HTMLInputElement} */(document.getElementById('itemLabel')).value.trim();
    const amount = /** @type {HTMLInputElement} */(document.getElementById('itemAmount')).value;
    const currency = /** @type {HTMLSelectElement} */(document.getElementById('itemCurrency')).value;
    const employeeId = /** @type {HTMLInputElement} */(document.getElementById('itemEmployeeId')).value;
    const itemId = /** @type {HTMLInputElement} */(document.getElementById('itemId')).value;
    if (itemId) updateItem(employeeId, itemId, /** @type any */(type), label, Number(amount), currency);
    else addItem(employeeId, /** @type any */(type), label, Number(amount), currency);
    itemDialog.close();
  });

  // Settings form
  const themeSelect = /** @type {HTMLSelectElement} */(document.getElementById('themeSelect'));
  const baseCurrencySelect = /** @type {HTMLSelectElement} */(document.getElementById('baseCurrencySelect'));
  const openRouterKey = /** @type {HTMLInputElement} */(document.getElementById('openRouterKey'));
  const modelSelect = /** @type {HTMLInputElement} */(document.getElementById('modelSelect'));
  themeSelect.value = state.settings.theme;
  baseCurrencySelect.value = state.settings.baseCurrency;
  openRouterKey.value = state.settings.openRouterKey || '';
  modelSelect.value = state.settings.model || 'openrouter/auto';
  document.getElementById('saveSettingsBtn')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    state.settings.theme = /** @type any */(themeSelect.value);
    state.settings.baseCurrency = /** @type any */(baseCurrencySelect.value);
    state.settings.openRouterKey = openRouterKey.value.trim();
    state.settings.model = modelSelect.value.trim() || 'openrouter/auto';
    storage.set('settings', state.settings);
    applyTheme(); ensureFreshRates(); settingsDialog.close(); toast('Настройки сохранены');
  });

  document.getElementById('exportBtn')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    const payload = { employees: state.employees, month: state.month, settings: state.settings, rates: state.rates };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `payroll_${state.month}.json`; a.click();
  });
  const importInput = /** @type {HTMLInputElement} */(document.getElementById('importInput'));
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]; if (!file) return;
    const text = await file.text();
    try {
      const obj = JSON.parse(text);
      if (!isRecord(obj)) throw new Error('Invalid JSON');
      state.employees = Array.isArray(obj.employees) ? obj.employees : state.employees;
      state.month = typeof obj.month === 'string' ? obj.month : state.month;
      if (isRecord(obj.settings)) state.settings = { ...DEFAULT_SETTINGS, ...obj.settings };
      if (isRecord(obj.rates)) state.rates = /** @type any */(obj.rates);
      render(); toast('Данные импортированы');
    } catch (e) { alert('Не удалось импортировать JSON'); }
  });
  document.getElementById('clearDataBtn')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (confirm('Очистить все локальные данные?')) { localStorage.clear(); location.reload(); }
  });

  // Chat
  document.getElementById('closeChatBtn')?.addEventListener('click', () => closeChat());
  const chatForm = /** @type {HTMLFormElement} */(document.getElementById('chatForm'));
  chatForm.addEventListener('submit', (ev) => { ev.preventDefault(); const text = /** @type {HTMLTextAreaElement} */(document.getElementById('chatText')); const v = text.value; text.value = ''; sendChat(v); });

  ensureFreshRates();
  render();
});


