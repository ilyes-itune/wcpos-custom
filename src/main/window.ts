import * as path from 'path';

import { BrowserWindow, shell } from 'electron';
import serve from 'electron-serve';

import { logger as log } from './log';
import { isDevelopment } from './util';

let loadURL: (window: BrowserWindow) => void;

if (isDevelopment) {
	const expoPort = process.env.EXPO_PORT || '8088';
	loadURL = (window: BrowserWindow) => window.loadURL(`http://localhost:${expoPort}`);
} else {
	const pathToDist = path.join(process.resourcesPath, 'dist');
	loadURL = serve({
		directory: pathToDist,
		scheme: 'wcpos',
	});
}

let mainWindow: BrowserWindow | null;

const APP_VERSION = 'WCPOS Custom 1.7';
const WP_AJAX_URL = 'https://usmm-tir.fr/wp-admin/admin-ajax.php';
const WP_SITE_URL = 'https://usmm-tir.fr';

/* ═══════════════════════════════════════════════════════════════════════════
   JS UNIQUE — anti-pub + panneaux custom + overlay caisse
   Injecté via le polling (seul mécanisme fiable sur wcpos://)
   window.__wcposActive empêche la double initialisation
   ═══════════════════════════════════════════════════════════════════════════ */
const INJECT_JS = `
(function () {

  /* ── Anti-pub (toujours actif, même avant React) ─── */
  var HIDE = [
    'upgrade-notice-banner','upgrade-title','upgrade-to-pro-button',
    'view-demo-button','add-fee','add-shipping'
  ];

  function injectCSS() {
    if (document.getElementById('wcpos-anti-pro')) return;
    var s = document.createElement('style');
    s.id = 'wcpos-anti-pro';
    s.textContent = HIDE.map(function(t){ return '[data-testid="'+t+'"]'; }).join(',')
      + '{display:none!important;visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(s);
  }

  function hide() {
    injectCSS();
    HIDE.forEach(function(t) {
      document.querySelectorAll('[data-testid="'+t+'"]').forEach(function(el) {
        el.style.setProperty('display','none','important');
      });
    });
  }

  hide();

  if (!window.__wcposAntiProActive) {
    window.__wcposAntiProActive = true;
    [100,300,700,1500,3000].forEach(function(ms){ setTimeout(hide,ms); });
    setInterval(hide, 500);
    new MutationObserver(hide).observe(document.documentElement,{childList:true,subtree:true});
  }

  /* ── Partie principale — ne s'initialise qu'une fois ── */
  if (window.__wcposMainInjected) return;

  /* Attend que le body React soit monté (titlebar = app chargée) */
  if (!document.getElementById('titlebar')) return;

  window.__wcposMainInjected = true;

  var AJAX_URL = '${WP_AJAX_URL}';

  var PANEL_TEXTS = {
    products:  'Ajustez les prix et quantités',
    orders:    'Rouvrez et imprimez les reçus',
    customers: 'Ajoutez de nouveaux clients',
    reports:   'Débloquez les rapports'
  };

  function ajax(action, data) {
    var fd = new FormData();
    fd.append('action', action);
    if (data) Object.keys(data).forEach(function(k){ fd.append(k, data[k]); });
    return fetch(AJAX_URL,{method:'POST',body:fd,credentials:'include'})
      .then(function(r){ return r.json(); })
      .then(function(r){ return r.data||r; });
  }

  /* ── Panneaux custom ─────────────────────────────── */
  function findProPanel() {
    var candidates = [];
    ['r-13awgt0','r-1p0dtai','r-6koalj','r-14lw9ot'].forEach(function(cls){
      document.querySelectorAll('.'+cls).forEach(function(el){ candidates.push(el); });
    });
    candidates = candidates.filter(function(el,i,a){ return a.indexOf(el)===i; });
    var best=null, bestH=Infinity;
    candidates.forEach(function(el){
      var r=el.getBoundingClientRect();
      if (r.width<400||r.height<100||r.x>200||r.width<window.innerWidth*0.4) return;
      for (var pid in PANEL_TEXTS) {
        if ((el.textContent||'').indexOf(PANEL_TEXTS[pid])!==-1&&r.height<bestH){
          bestH=r.height; best={el:el,panelId:pid};
        }
      }
    });
    if (!best) {
      for (var pid in PANEL_TEXTS) {
        if (best) break;
        document.querySelectorAll('*').forEach(function(el){
          if (best) return;
          var r=el.getBoundingClientRect();
          if (r.width<400||r.height<100||r.x>200) return;
          if ((el.textContent||'').indexOf(PANEL_TEXTS[pid])!==-1&&r.height<bestH){
            bestH=r.height; best={el:el,panelId:pid};
          }
        });
      }
    }
    return best;
  }

  function loadPanel(panelId, wrapper) {
    wrapper.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement\u2026</p>';
    ajax('wcpos_panel',{panel_id:panelId}).then(function(data){
      if (!data||!data.html){
        wrapper.innerHTML='<div style="padding:20px;background:#fce8e8;border-radius:6px;color:#8a1010;font-family:sans-serif">\uD83D\uDD12 Connectez-vous \u00e0 WordPress.</div>';
        return;
      }
      wrapper.innerHTML=data.html;
      wrapper.querySelectorAll('script').forEach(function(s){
        var ns=document.createElement('script'); ns.textContent=s.textContent; s.parentNode.replaceChild(ns,s);
      });
      wrapper.querySelectorAll('form').forEach(function(form){
        if ((form.method||'get').toLowerCase()==='get') return;
        form.addEventListener('submit',function(e){
          e.preventDefault();
          var url=form.action||'';
          if (!url) return;
          url+=(url.indexOf('?')!==-1?'&':'?')+'context=overlay';
          fetch(url,{method:'POST',body:new FormData(form),credentials:'include'})
          .then(function(){ loadPanel(panelId,wrapper); setTimeout(checkCaisse,400); });
        });
      });
      bindCaisseElements(wrapper);
    }).catch(function(err){
      wrapper.innerHTML='<p style="color:#d63638;padding:20px;font-family:sans-serif">Erreur : '+err.message+'</p>';
    });
  }

  function bindCaisseElements(root){
    root.querySelectorAll('[data-caisse-nav]:not([data-bound])').forEach(function(btn){
      btn.setAttribute('data-bound','1');
      btn.addEventListener('click',function(){ window._wcpos_action={type:'nav',view:btn.getAttribute('data-caisse-nav')||''}; });
    });
    root.querySelectorAll('[data-caisse-form]:not([data-bound])').forEach(function(form){
      form.setAttribute('data-bound','1');
      form.addEventListener('submit',function(e){
        e.preventDefault();
        var ft=form.getAttribute('data-caisse-form');
        window._wcpos_action=ft==='ponction'
          ?{type:'ponction',data:new FormData(form)}
          :{type:'submit',action:ft,data:new FormData(form)};
      });
    });
  }

  var injecting=false;
  function injectPanel(){
    if (injecting) return;
    var found=findProPanel(); if (!found) return;
    var el=found.el, pid=found.panelId;
    var existing=el.querySelector('#wcpos-panel-content');
    if (existing&&existing.getAttribute('data-panel')===pid) return;
    if (existing){ existing.setAttribute('data-panel',pid); loadPanel(pid,existing); return; }
    injecting=true;
    el.innerHTML='';
    el.style.cssText='display:flex;flex-direction:column;flex:1;padding:0;overflow:hidden;';
    var wrapper=document.createElement('div');
    wrapper.id='wcpos-panel-content'; wrapper.setAttribute('data-panel',pid);
    el.appendChild(wrapper); loadPanel(pid,wrapper);
    setTimeout(function(){ injecting=false; },500);
  }

  /* ── Navigation caisse ───────────────────────────── */
  window._wcpos_action=null;

  function reloadCaissePanel(view){
    var w=document.getElementById('wcpos-panel-content'); if(!w) return;
    ajax('wcpos_panel',{panel_id:'customers',caisse_view:view||''}).then(function(data){
      if(!data||!data.html) return;
      w.innerHTML=data.html;
      w.querySelectorAll('script').forEach(function(s){
        var ns=document.createElement('script'); ns.textContent=s.textContent; s.parentNode.replaceChild(ns,s);
      });
    });
  }

  function submitCaisseForm(action,formData){
    var w=document.getElementById('wcpos-panel-content'); if(!w) return;
    formData.append('action','wcpos_caisse_submit');
    formData.append('wcpos_caisse_action',action);
    fetch(AJAX_URL,{method:'POST',body:formData,credentials:'include'})
    .then(function(){ reloadCaissePanel('dashboard'); setTimeout(checkCaisse,400); });
  }

  setInterval(function(){
    if (!window._wcpos_action) return;
    var a=window._wcpos_action; window._wcpos_action=null;
    if (a.type==='nav')      reloadCaissePanel(a.view);
    if (a.type==='submit')   submitCaisseForm(a.action,a.data);
    if (a.type==='ponction') submitCaisseForm('ponction',a.data);
  },100);

  new MutationObserver(function(){ bindCaisseElements(document.body); })
    .observe(document.body,{childList:true,subtree:true});

  /* ── Overlay caisse fermée ───────────────────────── */
  var PANEL_WAS_SHOWN=false;
  function isCustomPanelVisible(){ return !!document.getElementById('wcpos-panel-content'); }

  function showCaisseOverlay(message){
    if (document.getElementById('wcpos-caisse-overlay')) return;
    var ov=document.createElement('div');
    ov.id='wcpos-caisse-overlay';
    ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:sans-serif;color:#fff';
    ov.innerHTML='<div style="font-size:3em;margin-bottom:14px">\uD83D\uDD12</div>'
      +'<h2 style="font-size:1.2em;font-weight:700;margin:0 0 10px">Caisse ferm\u00e9e</h2>'
      +'<p style="font-size:.9em;color:rgba(255,255,255,.8);max-width:360px;line-height:1.5;margin:0 0 20px">'
      +(message||'Ouvrez la caisse avant d\'utiliser le POS.')+'</p>'
      +'<button id="wcpos-open-caisse-btn" style="background:#00a32a;color:#fff;border:none;padding:10px 22px;border-radius:6px;font-size:.95em;font-weight:600;cursor:pointer">\uD83D\uDD13 Aller \u00e0 l\'onglet Caisse</button>';
    document.body.appendChild(ov);
    document.getElementById('wcpos-open-caisse-btn').addEventListener('click',function(){
      ov.style.display='none';
      Array.from(document.querySelectorAll('button[role="button"]'))
        .filter(function(b){ var r=b.getBoundingClientRect(); return r.left<10&&r.top>0&&r.width>0; })
        [2]?.click();
    });
  }

  function hideCaisseOverlay(){
    var ov=document.getElementById('wcpos-caisse-overlay');
    if (ov) ov.style.setProperty('display','none','important');
  }

  function checkCaisse(){
    ajax('wcpos_caisse_status').then(function(data){
      if (!!(data&&data.open)){ hideCaisseOverlay(); }
      else {
        showCaisseOverlay(data?data.message:'');
        if (!isCustomPanelVisible()){
          var ov=document.getElementById('wcpos-caisse-overlay');
          if (ov) ov.style.setProperty('display','flex','important');
        }
      }
    }).catch(function(){});
  }

  setInterval(function(){
    if (isCustomPanelVisible()){ hideCaisseOverlay(); PANEL_WAS_SHOWN=true; }
    else if (PANEL_WAS_SHOWN){ PANEL_WAS_SHOWN=false; checkCaisse(); }
  },300);

  new MutationObserver(function(){
    injectPanel();
  }).observe(document.body,{childList:true,subtree:true});

  checkCaisse();
  setInterval(checkCaisse,60000);

  log('wcpos main injected OK');

})();
`;

export const createWindow = (): void => {
	mainWindow = new BrowserWindow({
		show: false,
		width: 1024,
		height: 728,
		title: APP_VERSION,
		icon: path.join(__dirname, '../../icons/icon.ico'),
		webPreferences: {
			preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
			sandbox: false,
			nodeIntegration: false,
			contextIsolation: true,
		},
		backgroundColor: '#fff',
	});

	if (isDevelopment) {
		mainWindow.webContents.openDevTools();
	}

	/* Autorise les cookies WordPress depuis le schéma wcpos:// */
	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [`${WP_SITE_URL}/*`] },
		(details, callback) => {
			const headers = { ...details.requestHeaders };
			callback({ requestHeaders: headers });
		}
	);

	/* Autorise les requêtes cross-origin vers WordPress */
	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [`${WP_SITE_URL}/*`] },
		(details, callback) => {
			const headers = { ...details.responseHeaders };
			headers['Access-Control-Allow-Origin']      = ['wcpos://-'];
			headers['Access-Control-Allow-Credentials'] = ['true'];
			callback({ responseHeaders: headers });
		}
	);

	loadURL(mainWindow);

	mainWindow.on('page-title-updated', (event) => {
		event.preventDefault();
		mainWindow?.setTitle(APP_VERSION);
	});

	/* ── Injection via polling — seul mécanisme fiable sur wcpos:// ── */
	function runInject() {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.executeJavaScript(INJECT_JS).catch((err) => {
			log.error('Injection failed:', err);
		});
	}

	/* Événements natifs (backup) */
	mainWindow.webContents.on('dom-ready', () => {
		mainWindow?.setTitle(APP_VERSION);
		runInject();
	});
	mainWindow.webContents.on('did-finish-load', () => {
		mainWindow?.setTitle(APP_VERSION);
		runInject();
	});
	mainWindow.webContents.on('did-navigate', () => runInject());
	mainWindow.webContents.on('did-navigate-in-page', () => runInject());

	/* Polling toutes les 2s pendant 60s — garantit l'injection même si
	   aucun événement ne se déclenche, et rattrape les re-renders tardifs */
	let pollCount = 0;
	const pollTimer = setInterval(() => {
		if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
		runInject();
		if (++pollCount >= 30) clearInterval(pollTimer);
	}, 2000);

	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) throw new Error('"mainWindow" is not defined');
		if (process.env.START_MINIMIZED) mainWindow.minimize();
		else mainWindow.show();
	});

	mainWindow.on('closed', () => { mainWindow = null; });

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		log.info(`Opening in external browser: ${url}`);
		shell.openExternal(url);
		return { action: 'deny' };
	});

	let retryCount = 0;
	const MAX_RETRIES = 30;

	mainWindow.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
		log.error(`did fail load with code ${errorCode}: ${errorDescription}`);
		if (errorDescription === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= MAX_RETRIES) { log.error('Max retries reached'); return; }
			retryCount++;
			setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
