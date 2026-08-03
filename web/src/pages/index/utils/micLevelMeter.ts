/**
 * Drive `#top-bar-mic-level-fill` from a live MediaStream.
 * Stops when `isActive()` returns false or when the returned disposer runs.
 */
export function runMicLevelMeter(
  stream: MediaStream,
  isActive: () => boolean,
  fillId = 'top-bar-mic-level-fill',
): () => void {
  let raf: number | null = null;
  let ctx: AudioContext | null = null;

  const resetFill = () => {
    const fill = document.getElementById(fillId);
    if (fill) fill.style.width = '0%';
  };

  const stop = () => {
    if (raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    const c = ctx;
    ctx = null;
    if (c) void c.close().catch(() => {});
    resetFill();
  };

  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
    void ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!isActive()) {
        raf = null;
        return;
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Map quiet speech into a readable bar; clamp to 0–1.
      const level = Math.min(1, rms * 3.2);
      const fill = document.getElementById(fillId);
      if (fill) fill.style.width = `${(level * 100).toFixed(1)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  } catch {
    stop();
  }

  return stop;
}
