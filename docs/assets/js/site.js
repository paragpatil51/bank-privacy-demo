(function () {
  'use strict';

  // Mobile navigation toggle.
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Mark the current page in the main navigation.
  // Compare resolved URLs so this also works when the site is hosted under a sub-path.
  var path = location.pathname.replace(/index\.html$/, '');
  document.querySelectorAll('.main-nav a').forEach(function (a) {
    if (a.getAttribute('href').indexOf('#') >= 0) return;
    if (a.pathname.replace(/index\.html$/, '') === path) a.setAttribute('aria-current', 'page');
  });
})();
