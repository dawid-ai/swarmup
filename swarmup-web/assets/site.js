/* global document, window, setInterval, IntersectionObserver */
// The home page schematic: its four steps light up one stage at a time, on their own until the
// reader clicks one.
(function () {
  var svg = document.querySelector('[data-net] svg.net');
  var tabs = document.querySelectorAll('[data-tab]');
  if (!svg || tabs.length === 0) return;
  var stage = 0;
  var manual = false;
  function show(i) {
    stage = i;
    svg.setAttribute('data-stage', String(i));
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].setAttribute('aria-pressed', k === i ? 'true' : 'false');
    }
  }
  for (var k = 0; k < tabs.length; k++) {
    tabs[k].addEventListener(
      'click',
      (function (i) {
        return function () {
          manual = true;
          show(i);
        };
      })(k),
    );
  }
  show(0);
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (svg.pauseAnimations) svg.pauseAnimations();
    return;
  }
  setInterval(function () {
    if (!manual && !document.hidden) show((stage + 1) % tabs.length);
  }, 3400);
})();

// Blocks marked data-reveal fade up when they scroll into view. The class on <html> turns the
// hidden state on, so a browser that never runs this shows everything.
(function () {
  var blocks = document.querySelectorAll('[data-reveal]');
  if (blocks.length === 0 || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('reveal-on');
  var seen = new IntersectionObserver(
    function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        entries[i].target.classList.add('in');
        seen.unobserve(entries[i].target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (var k = 0; k < blocks.length; k++) seen.observe(blocks[k]);
})();
