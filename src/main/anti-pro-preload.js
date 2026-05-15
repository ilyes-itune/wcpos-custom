/**
 * anti-pro-preload.js
 * Injecté via webPreferences.preload AVANT React — fonctionne sur tous les schémas.
 * Placer dans : src/main/anti-pro-preload.js
 */
const { contextBridge, ipcRenderer } = require('electron');

/* Lance l'injection dès que le DOM est disponible */
function waitForBody(fn) {
  if (document.body) { fn(); return; }
  new MutationObserver(function(_, obs) {
    if (document.body) { obs.disconnect(); fn(); }
  }).observe(document.documentElement, { childList: true });
}

waitForBody(function() {

  var HIDE_TESTIDS = [
    'upgrade-notice-banner',
    'upgrade-title',
    'upgrade-to-pro-button',
    'view-demo-button',
    'add-fee',
    'add-shipping'
  ];

  /* Injecte le CSS dans <head> dès qu'il existe */
  function injectCSS() {
    var head = document.head || document.documentElement;
    if (document.getElementById('wcpos-anti-pro')) return;
    var s = document.createElement('style');
    s.id = 'wcpos-anti-pro';
    s.textContent = HIDE_TESTIDS.map(function(t) {
      return '[data-testid="' + t + '"]';
    }).join(',') + '{display:none!important;visibility:hidden!important}';
    head.appendChild(s);
  }

  function hide() {
    injectCSS();
    HIDE_TESTIDS.forEach(function(t) {
      document.querySelectorAll('[data-testid="' + t + '"]').forEach(function(el) {
        el.style.setProperty('display', 'none', 'important');
      });
    });
  }

  hide();
  [100, 300, 700, 1500, 3000].forEach(function(ms) { setTimeout(hide, ms); });
  setInterval(hide, 500);

  new MutationObserver(hide).observe(document.body, {
    childList: true,
    subtree: true
  });

});
