/* global document, window, setInterval */
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
