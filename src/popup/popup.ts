import { synoAPI, DSTask, TaskStatus } from '../api/synology.js';
import { loadSettings, isConfigured } from '../storage/settings.js';

type Tab = 'active' | 'finished' | 'error';

const ACTIVE: TaskStatus[] = ['waiting', 'downloading', 'hash_checking', 'extracting', 'filehosting_waiting', 'finishing', 'paused'];
const FINISHED: TaskStatus[] = ['finished', 'seeding'];
const ERROR: TaskStatus[] = ['error'];

const POLL_MS = 5_000;

let currentTab: Tab = 'active';
let allTasks: DSTask[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── DOM helpers ────────────────────────────────────────────────────────────────

const views = {
  unconfigured: document.getElementById('view-unconfigured')!,
  loading:      document.getElementById('view-loading')!,
  error:        document.getElementById('view-error')!,
  main:         document.getElementById('view-main')!,
};

function show(name: keyof typeof views): void {
  for (const v of Object.values(views)) v.classList.add('hidden');
  views[name].classList.remove('hidden');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  waiting:              'Waiting',
  downloading:          'Downloading',
  paused:               'Paused',
  finishing:            'Finishing',
  finished:             'Finished',
  hash_checking:        'Checking',
  seeding:              'Seeding',
  filehosting_waiting:  'Waiting',
  extracting:           'Extracting',
  error:                'Error',
};

function progress(task: DSTask): number {
  if (task.status === 'finished' || task.status === 'seeding') return 100;
  const t = task.additional?.transfer;
  if (!t || task.size === 0) return 0;
  return Math.min(100, Math.round((t.size_downloaded / task.size) * 100));
}

// ── Task rendering ─────────────────────────────────────────────────────────────

function renderTask(task: DSTask): HTMLElement {
  const pct   = progress(task);
  const t     = task.additional?.transfer;
  const done  = task.status === 'finished' || task.status === 'seeding';
  const canResume = task.status === 'paused';
  const canPause  = task.status === 'downloading' || task.status === 'seeding';

  let meta = '';
  if (t) {
    meta = `${fmtBytes(t.size_downloaded)} / ${task.size ? fmtBytes(task.size) : '?'}`;
    if (task.status === 'downloading' && t.speed_download > 0)
      meta += ` · ↓ ${fmtBytes(t.speed_download)}/s`;
  }

  const el = document.createElement('div');
  el.className = 'task-item';
  el.innerHTML = `
    <div class="task-header">
      <span class="task-name" title="${esc(task.title)}">${esc(task.title)}</span>
      <span class="task-status s-${task.status}">${STATUS_LABEL[task.status] ?? task.status}</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill ${done ? 'done' : ''}" style="width:${pct}%"></div>
    </div>
    <div class="task-footer">
      <span class="task-meta">${esc(meta)}</span>
      <div class="task-actions">
        ${canResume ? `<button class="action-btn act-resume" data-id="${esc(task.id)}" title="Resume">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>` : ''}
        ${canPause ? `<button class="action-btn act-pause" data-id="${esc(task.id)}" title="Pause">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>` : ''}
        <button class="action-btn danger act-delete" data-id="${esc(task.id)}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  return el;
}

// ── List update ────────────────────────────────────────────────────────────────

function filterTasks(tab: Tab): DSTask[] {
  if (tab === 'active')   return allTasks.filter(t => ACTIVE.includes(t.status));
  if (tab === 'finished') return allTasks.filter(t => FINISHED.includes(t.status));
  return allTasks.filter(t => ERROR.includes(t.status));
}

function redraw(): void {
  const list   = document.getElementById('task-list')!;
  const empty  = document.getElementById('empty-msg')!;
  const tasks  = filterTasks(currentTab);

  list.querySelectorAll('.task-item').forEach(e => e.remove());
  empty.style.display = tasks.length ? 'none' : '';
  tasks.forEach(t => list.appendChild(renderTask(t)));

  // Badges
  setBadge('badge-active',   allTasks.filter(t => ACTIVE.includes(t.status)).length);
  setBadge('badge-finished', allTasks.filter(t => FINISHED.includes(t.status)).length);
  setBadge('badge-error',    allTasks.filter(t => ERROR.includes(t.status)).length);

  // Stats
  const dl    = allTasks.filter(t => t.status === 'downloading');
  const speed = dl.reduce((s, t) => s + (t.additional?.transfer?.speed_download ?? 0), 0);
  const stats = document.getElementById('stats-text')!;
  stats.textContent = dl.length
    ? `${dl.length} downloading · ↓ ${fmtBytes(speed)}/s`
    : `${allTasks.length} task${allTasks.length !== 1 ? 's' : ''} total`;
}

function setBadge(id: string, n: number): void {
  document.getElementById(id)!.textContent = n > 0 ? String(n) : '';
}

// ── Data fetching ──────────────────────────────────────────────────────────────

async function fetchTasks(): Promise<void> {
  try {
    const result = await synoAPI.listTasks();
    allTasks = result.tasks ?? [];
    redraw();
  } catch (e) {
    stopPoll();
    document.getElementById('error-msg')!.textContent = (e as Error).message;
    show('error');
  }
}

function startPoll(): void {
  stopPoll();
  fetchTasks();
  pollTimer = setInterval(fetchTasks, POLL_MS);
}

function stopPoll(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Initialisation ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (!(await isConfigured())) { show('unconfigured'); return; }

  show('loading');
  try {
    const settings = await loadSettings();
    await synoAPI.login({ url: settings.nasUrl, username: settings.username, password: settings.password });
    show('main');
    startPoll();
  } catch (e) {
    document.getElementById('error-msg')!.textContent = (e as Error).message;
    show('error');
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────

document.getElementById('open-settings-btn')!.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('settings-btn')!.addEventListener('click',      () => chrome.runtime.openOptionsPage());
document.getElementById('retry-btn')!.addEventListener('click',          () => init());

document.getElementById('refresh-btn')!.addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn')!;
  btn.classList.add('spinning');
  await fetchTasks();
  setTimeout(() => btn.classList.remove('spinning'), 600);
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = (tab as HTMLElement).dataset['tab'] as Tab;
    redraw();
  });
});

document.getElementById('task-list')!.addEventListener('click', async e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.action-btn');
  if (!btn) return;
  const id = btn.dataset['id'];
  if (!id) return;

  btn.disabled = true;
  try {
    if (btn.classList.contains('act-resume')) {
      await synoAPI.resumeTasks([id]);
    } else if (btn.classList.contains('act-pause')) {
      await synoAPI.pauseTasks([id]);
    } else if (btn.classList.contains('act-delete')) {
      if (!confirm('Delete this download task?')) { btn.disabled = false; return; }
      await synoAPI.deleteTasks([id]);
    }
    await fetchTasks();
  } catch (err) {
    console.error((err as Error).message);
    btn.disabled = false;
  }
});

window.addEventListener('pagehide', stopPoll);

init();
