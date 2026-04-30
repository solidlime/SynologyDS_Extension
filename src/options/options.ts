import { SynologyAPI } from '../api/synology.js';
import { loadSettings, saveSettings } from '../storage/settings.js';

const nasUrlInput   = document.getElementById('nas-url')     as HTMLInputElement;
const usernameInput = document.getElementById('username')    as HTMLInputElement;
const passwordInput = document.getElementById('password')    as HTMLInputElement;
const destInput     = document.getElementById('destination') as HTMLInputElement;
const testBtn       = document.getElementById('test-btn')    as HTMLButtonElement;
const saveBtn       = document.getElementById('save-btn')    as HTMLButtonElement;
const statusEl      = document.getElementById('status')      as HTMLDivElement;
const form          = document.getElementById('form')        as HTMLFormElement;

// ── Status banner ──────────────────────────────────────────────────────────────

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(msg: string, type: 'success' | 'error' | 'info'): void {
  if (statusTimer) clearTimeout(statusTimer);
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  statusTimer = setTimeout(() => {
    statusEl.className = 'status hidden';
  }, type === 'error' ? 15000 : 5000);
}

// ── Load saved settings ────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const s = await loadSettings();
  nasUrlInput.value   = s.nasUrl;
  usernameInput.value = s.username;
  passwordInput.value = s.password;
  destInput.value     = s.defaultDestination;
}

// ── Test connection ────────────────────────────────────────────────────────────

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testBtn.textContent = 'Testing…';
  setStatus('Connecting…', 'info');
  const api = new SynologyAPI();
  try {
    await api.login({
      url:      nasUrlInput.value.trim(),
      username: usernameInput.value.trim(),
      password: passwordInput.value,
    });
    const resolved = api.resolvedUrl;
    const note = resolved !== nasUrlInput.value.trim() ? ` (resolved: ${resolved})` : '';
    await api.logout();
    setStatus(`✓ Connection successful!${note}`, 'success');
  } catch (e) {
    setStatus(`✗ ${(e as Error).message}`, 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
  }
});

// ── Save settings ──────────────────────────────────────────────────────────────

form.addEventListener('submit', async e => {
  e.preventDefault();
  saveBtn.disabled = true;
  try {
    await saveSettings({
      nasUrl:             nasUrlInput.value.trim(),
      username:           usernameInput.value.trim(),
      password:           passwordInput.value,
      defaultDestination: destInput.value.trim(),
    });
    setStatus('✓ Settings saved!', 'success');
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

init();
