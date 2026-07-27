// Panel/fab chrome lives in tailwind.css (@layer components, consolidated
// perf-debug section) — these plain class strings target those named rules.
const STORAGE_KEY = 'autologger:perfDebugV1';

export const DEBUG_SESSION_TRANSPORT_KEY = 'autologger:debugSessionTransport';
export const DEBUG_SESSION_TRANSPORT_EVENT = 'autologger:debug-session-transport';

export type DebugSessionTransport = 'stop' | 'play' | 'rolling' | 'audio-recording';

export function getDebugSessionTransportOverride(): DebugSessionTransport | null {
  try {
    const v = localStorage.getItem(DEBUG_SESSION_TRANSPORT_KEY);
    if (v === 'stop' || v === 'play' || v === 'rolling' || v === 'audio-recording') return v;
  } catch {
    /* ignore */
  }
  return null;
}

export const PERF_DEBUG_FORCE: Record<string, boolean | undefined> = {
  noV5PageFx: false,
  noTimelineWaveform: false,
  noPlayheadGlow: false,
  noDecorativeVideos: false,
  noPanelShadows: false,
  noTimelineMarkerFx: false,
  noV5WaveformGradients: false,
};

interface FlagDef {
  id: string;
  className: string;
  label: string;
  hint?: string;
}

const FLAGS: FlagDef[] = [
  {
    id: 'noV5PageFx',
    className: 'perf-dbg--no-v5-page-fx',
    label: 'Hide V5 page grid / glow (::before/::after)',
  },
  {
    id: 'noTimelineWaveform',
    className: 'perf-dbg--no-timeline-waveform',
    label: 'Hide merged waveform layer',
  },
  {
    id: 'noPlayheadGlow',
    className: 'perf-dbg--no-playhead-glow',
    label: 'Hide playhead proximity glow layer',
  },
  {
    id: 'noDecorativeVideos',
    className: 'perf-dbg--no-decorative-videos',
    label: 'Hide loading WebM loops (+ pause)',
  },
  {
    id: 'noPanelShadows',
    className: 'perf-dbg--no-panel-shadows',
    label: 'Strip panel box-shadows',
  },
  {
    id: 'noTimelineMarkerFx',
    className: 'perf-dbg--no-timeline-marker-fx',
    label: 'Simplify marker / playhead / clip shadows (V5)',
  },
  {
    id: 'noV5WaveformGradients',
    className: 'perf-dbg--no-v5-waveform-gradients',
    label: 'Flat waveform fills (no SVG gradients)',
  },
];

type FlagState = Record<string, boolean>;

function loadState(): FlagState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as FlagState) : {};
  } catch {
    return {};
  }
}

function saveState(state: FlagState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function mergeState(): FlagState {
  const saved = loadState();
  const out: FlagState = { ...saved };
  for (const { id } of FLAGS) {
    if (PERF_DEBUG_FORCE[id] === true) out[id] = true;
  }
  return out;
}

let currentState: FlagState = {};

function applyBodyClasses(): void {
  const body = document.body;
  if (!body) return;
  body.classList.remove('v5-glass-native-backdrop', 'perf-dbg--no-backdrop');
  for (const { className } of FLAGS) {
    body.classList.remove(className);
  }
  for (const { id, className } of FLAGS) {
    if (currentState[id]) body.classList.add(className);
  }
}

function setDecorativeVideosPaused(pause: boolean): void {
  for (const v of document.querySelectorAll<HTMLVideoElement>(
    'video.autologger-loading-video__media',
  )) {
    try {
      if (pause) void v.pause();
      else void v.play().catch(() => null);
    } catch {
      /* ignore */
    }
  }
}

function syncVideoPauseWithState(): void {
  setDecorativeVideosPaused(Boolean(currentState.noDecorativeVideos));
}

export interface InitPerfDebugUIOptions {
  mount?: HTMLElement | null;
}

export function initPerfDebugUI(opts: InitPerfDebugUIOptions = {}): void {
  const mount = opts.mount ?? null;

  currentState = mergeState();
  applyBodyClasses();
  syncVideoPauseWithState();

  if (document.getElementById('perf-debug-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'perf-debug-panel';
  panel.className = 'perf-debug-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Performance debug');

  if (mount) {
    panel.classList.add('perf-debug-panel--embedded');
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }

  const title = document.createElement('p');
  title.className = 'perf-debug-panel__title';
  title.textContent = 'Lag culprits (saved locally)';

  panel.appendChild(title);

  function bindFlagRow(f: FlagDef): void {
    const row = document.createElement('div');
    row.className = 'perf-debug-panel__row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `perf-dbg-cb-${f.id}`;
    cb.checked = Boolean(currentState[f.id]);
    const lab = document.createElement('label');
    lab.htmlFor = cb.id;
    lab.textContent = f.label;
    row.appendChild(cb);
    row.appendChild(lab);
    panel.appendChild(row);

    cb.addEventListener('change', () => {
      currentState[f.id] = cb.checked;
      saveState(currentState);
      applyBodyClasses();
      syncVideoPauseWithState();
    });
  }

  for (const f of FLAGS) bindFlagRow(f);

  const sessionTitle = document.createElement('p');
  sessionTitle.className = 'perf-debug-panel__title';
  sessionTitle.style.marginTop = '0.75rem';
  sessionTitle.textContent = 'Session transport (dev)';
  panel.appendChild(sessionTitle);

  const sessionHint = document.createElement('p');
  sessionHint.className = 'perf-debug-panel__hint';
  sessionHint.style.marginBottom = '0.35rem';
  sessionHint.textContent =
    'Overrides button layout and timeline / log panel. Does not start or stop real timecode or recording.';
  panel.appendChild(sessionHint);

  const sessionFieldset = document.createElement('fieldset');
  sessionFieldset.className = 'perf-debug-panel__fieldset';
  const sessionLegend = document.createElement('legend');
  sessionLegend.className = 'perf-debug-panel__legend';
  sessionLegend.textContent = 'Forced state';
  sessionFieldset.appendChild(sessionLegend);

  const SESSION_OPTS: { value: '' | DebugSessionTransport; label: string }[] = [
    { value: '', label: 'Auto (server)' },
    { value: 'stop', label: 'Stop' },
    { value: 'play', label: 'Play' },
    { value: 'rolling', label: 'Rolling' },
    { value: 'audio-recording', label: 'Recording audio' },
  ];

  const sessionGroupName = 'perf-dbg-session-transport';

  function readSessionOverrideFromStorage(): '' | DebugSessionTransport {
    try {
      const v = localStorage.getItem(DEBUG_SESSION_TRANSPORT_KEY);
      return v === 'stop' || v === 'play' || v === 'rolling' || v === 'audio-recording' ? v : '';
    } catch {
      return '';
    }
  }

  const initialSession = readSessionOverrideFromStorage();

  for (const opt of SESSION_OPTS) {
    const row = document.createElement('div');
    row.className = 'perf-debug-panel__row perf-debug-panel__row--radio';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = sessionGroupName;
    radio.value = opt.value;
    radio.id = `perf-dbg-session-${opt.value || 'auto'}`;
    radio.checked = opt.value === initialSession || (opt.value === '' && initialSession === '');
    const lab = document.createElement('label');
    lab.htmlFor = radio.id;
    lab.textContent = opt.label;
    row.appendChild(radio);
    row.appendChild(lab);
    sessionFieldset.appendChild(row);
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      try {
        if (opt.value === '') {
          localStorage.removeItem(DEBUG_SESSION_TRANSPORT_KEY);
        } else {
          localStorage.setItem(DEBUG_SESSION_TRANSPORT_KEY, opt.value);
        }
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent(DEBUG_SESSION_TRANSPORT_EVENT));
    });
  }

  panel.appendChild(sessionFieldset);

  const hint = document.createElement('p');
  hint.className = 'perf-debug-panel__hint';
  hint.textContent = `Edit PERF_DEBUG_FORCE in perfDebug.ts to default-on. Storage key: ${STORAGE_KEY}`;

  const actions = document.createElement('div');
  actions.className = 'perf-debug-panel__actions';

  const btnAllOff = document.createElement('button');
  btnAllOff.type = 'button';
  btnAllOff.textContent = 'All off';
  btnAllOff.addEventListener('click', () => {
    for (const { id } of FLAGS) {
      currentState[id] = false;
      const el = document.getElementById(`perf-dbg-cb-${id}`) as HTMLInputElement | null;
      if (el) el.checked = false;
    }
    try {
      localStorage.removeItem(DEBUG_SESSION_TRANSPORT_KEY);
    } catch {
      /* ignore */
    }
    const autoRadio = document.getElementById('perf-dbg-session-auto') as HTMLInputElement | null;
    if (autoRadio) autoRadio.checked = true;
    window.dispatchEvent(new CustomEvent(DEBUG_SESSION_TRANSPORT_EVENT));
    saveState(currentState);
    applyBodyClasses();
    syncVideoPauseWithState();
  });

  actions.appendChild(btnAllOff);
  panel.appendChild(hint);
  panel.appendChild(actions);

  if (mount) {
    mount.appendChild(panel);
    return;
  }

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'perf-debug-fab';
  fab.className = 'perf-debug-fab';
  fab.textContent = 'Perf';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'perf-debug-panel');
  fab.title = 'Toggle performance debug options';

  function setPanelOpen(open: boolean): void {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    fab.textContent = open ? 'Hide' : 'Perf';
  }

  fab.addEventListener('click', () => {
    setPanelOpen(Boolean(panel.hidden));
  });

  // Escape closes the panel and returns focus to the toggle (the panel has no
  // other dismiss affordance, so without this it can feel "stuck" open).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      setPanelOpen(false);
      fab.focus();
    }
  });

  document.body.appendChild(fab);
  document.body.appendChild(panel);
}
