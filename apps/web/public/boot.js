// Runs before the first paint, from index.html. A file, not an inline script: the CSP allows
// scripts from 'self' only (apps/api/src/app.ts), so an inline one would be blocked in production.
(function () {
  var root = document.documentElement;
  // Apply the saved theme (no flash). Without a saved choice the device decides.
  try {
    var t = localStorage.getItem('barakah.theme');
    if (t === 'light' || t === 'dark') root.dataset.theme = t;
  } catch (e) {}
  // The phone's status bar (meta theme-color, above in index.html) in the dark background before the
  // first paint; src/lib/theme.ts keeps it in step from then on.
  try {
    var dark = root.dataset.theme === 'dark' ||
      (root.dataset.theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.querySelector('meta[name="theme-color"]').setAttribute('content', '#0b100d');
  } catch (e) {}
  // The animated splash (#splash, public/splash.css) only when opened from the app icon: the
  // installed PWA or the Android app. `?splash` previews it in a browser tab, and the tab keeps
  // showing it on every reload (the app drops the query when it moves on); `?splash=0` stops that.
  var installed =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true ||
    !!window.Capacitor;
  var asked = /[?&]splash(?!=0)\b/.test(location.search);
  var preview = asked;
  try {
    if (/[?&]splash=0\b/.test(location.search)) sessionStorage.removeItem('barakah.splash');
    else if (asked) sessionStorage.setItem('barakah.splash', '1');
    preview = sessionStorage.getItem('barakah.splash') === '1';
  } catch (e) {}
  if (installed || preview) root.classList.add('splash-on');
})();
