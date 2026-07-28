import loadingVideoSrc from '../../assets/video/AutoLogger_Small.webm';

export const AUTOLOGGER_LOADING_VIDEO_SRC = loadingVideoSrc;

function applyFreezeAtFirstFrame(v: HTMLVideoElement | null | undefined): void {
  if (v?.tagName !== 'VIDEO') return;
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
