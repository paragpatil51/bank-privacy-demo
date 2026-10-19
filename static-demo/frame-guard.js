/*
 * Clickjacking defence for the static GitHub Pages build. GitHub Pages cannot
 * send X-Frame-Options or CSP frame-ancestors headers, so the page refuses to
 * render when it is loaded inside another site's frame.
 */
(function () {
  'use strict';
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed) return;
  document.documentElement.hidden = true;
  try { window.top.location.replace(window.self.location.href); } catch (e) { /* cross-origin parent: blocked */ }
  document.addEventListener('DOMContentLoaded', function () {
    document.body.textContent = 'For your security, this page cannot be displayed inside another website.';
    document.documentElement.hidden = false;
  });
})();
