const TOKEN_KEY = 'synx-token';
const USER_KEY = 'synx-user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setSession(data) {
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && token) {
    clearSession();
    if (!location.pathname.endsWith('/login.html')) location.href = 'login.html';
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export function requireSession() {
  if (!getToken()) {
    location.href = 'login.html';
    return false;
  }
  return true;
}

export function showStatus(element, message, kind = 'info') {
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = false;
}

async function handleAuthForm(form, endpoint) {
  const status = document.querySelector('[data-status]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    showStatus(status, '正在提交…');
    try {
      const body = Object.fromEntries(new FormData(form));
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      setSession(data);
      location.href = 'dashboard.html';
    } catch (error) {
      showStatus(status, error instanceof Error ? error.message : '请求失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') {
  const registerForm = document.querySelector('#register-form');
  if (registerForm) handleAuthForm(registerForm, '/api/auth/register');
  const loginForm = document.querySelector('#login-form');
  if (loginForm) handleAuthForm(loginForm, '/api/auth/login');
  const logout = document.querySelector('#logout');
  if (logout) logout.addEventListener('click', () => {
    clearSession();
    location.href = 'login.html';
  });
}
