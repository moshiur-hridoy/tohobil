/** How long the launch splash stays at least, counted from the page starting to load: its animation (public/splash.css) has played by then. */
const MIN_MS = 1700;

let gone = false;
const waiting = new Set<() => void>();

function markGone(): void {
  gone = true;
  waiting.forEach((fn) => fn());
  waiting.clear();
}

/** Runs `fn` once the launch splash starts fading (at once when there is none); returns a cancel. */
export function onSplashGone(fn: () => void): () => void {
  if (gone) {
    fn();
    return () => {};
  }
  waiting.add(fn);
  return () => waiting.delete(fn);
}

/** Fades out the launch splash (#splash in index.html) once the app has started, then removes it. */
export function hideSplash(): void {
  const el = document.getElementById('splash');
  if (!el) {
    markGone();
    return;
  }
  if (!document.documentElement.classList.contains('splash-on')) {
    el.remove();
    markGone();
    return;
  }
  window.setTimeout(() => {
    el.classList.add('splash-out');
    markGone();
    window.setTimeout(() => el.remove(), 400);
  }, Math.max(0, MIN_MS - performance.now()));
}
