import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { hideToast, showToast } from '../../../shared/components/Toast';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import styles from './AudioSaveOverlay.module.css';

type Visibility = 'hidden' | 'showing' | 'leaving';

interface Props {
  isUploading: boolean;
}

const FADE_MS = 350;
const MIN_PRESENTATION_MS = 1000;

export function AudioSaveOverlay({ isUploading }: Props) {
  const [visibility, setVisibility] = useState<Visibility>('hidden');
  const shownAtRef = useRef<number>(0);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (isUploading) {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
      setVisibility('showing');
      shownAtRef.current = performance.now();
      showToast('Saving Audio...', false, { persistent: true });
      return;
    }

    if (visibility === 'hidden') return;

    const elapsed = performance.now() - shownAtRef.current;
    const wait = Math.max(0, MIN_PRESENTATION_MS - elapsed);
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      setVisibility('leaving');
      fadeTimerRef.current = setTimeout(() => {
        fadeTimerRef.current = null;
        setVisibility('hidden');
        hideToast();
      }, FADE_MS);
    }, wait);
  }, [isUploading, visibility]);

  useEffect(
    () => () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    document.body.classList.toggle('autologger-audio-saving', visibility !== 'hidden');
    if (visibility !== 'hidden') document.body.setAttribute('aria-busy', 'true');
    else document.body.removeAttribute('aria-busy');
  }, [visibility]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (visibility === 'showing') {
      v.loop = true;
      v.muted = true;
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [visibility]);

  if (visibility === 'hidden') return null;

  return (
    <div
      id="autologger-audio-save-overlay"
      className={clsx(
        styles.audioSaveOverlay,
        visibility === 'leaving' && styles.audioSaveOverlayLeaving,
      )}
      tabIndex={-1}
      role="dialog"
      aria-modal={true}
      aria-labelledby="autologger-audio-save-title"
    >
      <div className={styles.audioSaveOverlayInner}>
        <video
          ref={videoRef}
          className={styles.audioSaveOverlayVideo}
          src={AUTOLOGGER_LOADING_VIDEO_SRC}
          preload="auto"
          muted
          playsInline
          disablePictureInPicture
        />
        <p id="autologger-audio-save-title" className={styles.audioSaveOverlayLabel}>
          Saving Audio...
        </p>
      </div>
    </div>
  );
}
