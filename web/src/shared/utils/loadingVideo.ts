import loadingVideoSrc from '../../assets/video/AutoLogger_Small.webm';

export const AUTOLOGGER_LOADING_VIDEO_SRC = loadingVideoSrc;

export const AUTOLOGGER_ANIMATED_LOGO_SRC = AUTOLOGGER_LOADING_VIDEO_SRC;

export function autologgerLoadingVideoHTML(): string {
  return `<div class="autologger-loading-video"><video class="autologger-loading-video__media" src="${AUTOLOGGER_LOADING_VIDEO_SRC}" preload="auto" muted playsinline disablepictureinpicture></video></div>`;
}

function applyFreezeAtFirstFrame(v: HTMLVideoElement | null | undefined): void {
  if (!v || v.tagName !== 'VIDEO') return;
  v.defaultMuted = true;
  v.muted = true;
  v.playsInline = true;
  v.removeAttribute('autoplay');
  v.removeAttribute('loop');
  v.loop = false;
  const snap = (): void => {
    try {
      if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        v.currentTime = 0;
      }
      v.pause();
    } catch {
      /* ignore */
    }
  };
  if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) snap();
  else v.addEventListener('loadeddata', snap, { once: true });
}

function isAnimatedLogoLoopNode(v: Element): boolean {
  return Boolean(v.closest('[data-autologger-animated-logo-loop]'));
}

export function freezeAutologgerLoadingVideos(root: ParentNode = document): void {
  const el = root as ParentNode & { querySelectorAll: ParentNode['querySelectorAll'] };
  for (const v of el.querySelectorAll<HTMLVideoElement>('.autologger-loading-video__media')) {
    if (isAnimatedLogoLoopNode(v)) continue;
    applyFreezeAtFirstFrame(v);
  }
}

export function freezeBrandVideoAtFirstFrame(v: HTMLVideoElement | null | undefined): void {
  applyFreezeAtFirstFrame(v);
}

export function autologgerPlayBrandClipLoop(v: HTMLVideoElement | null | undefined): void {
  if (!v || v.tagName !== 'VIDEO') return;
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  const run = (): void => {
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };
  queueMicrotask(run);
}

export function autologgerStopBrandClipLoop(v: HTMLVideoElement | null | undefined): void {
  if (!v || v.tagName !== 'VIDEO') return;
  v.loop = false;
  try {
    v.pause();
  } catch {
    /* ignore */
  }
}

let prewarmLoadingVideoPromise: Promise<void> | null = null;

export function prewarmAutologgerLoadingVideo(): Promise<void> {
  if (!prewarmLoadingVideoPromise) {
    prewarmLoadingVideoPromise = new Promise<void>((resolve) => {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.src = AUTOLOGGER_LOADING_VIDEO_SRC;
      const done = (): void => resolve();
      v.addEventListener('canplaythrough', done, { once: true });
      v.addEventListener('error', done, { once: true });
      try {
        v.load();
      } catch {
        done();
      }
      setTimeout(done, 2500);
    });
  }
  return prewarmLoadingVideoPromise;
}
