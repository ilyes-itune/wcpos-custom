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

const APP_VERSION  = 'WCPOS Custom 2.6';
const WP_SITE_URL  = 'https://usmm-tir.fr';
const WP_REST_BASE = 'https://usmm-tir.fr/wp-json/wcpos-custom/v1';

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

	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [WP_SITE_URL + '/*'] },
		(details, callback) => {
			callback({ requestHeaders: { ...details.requestHeaders } });
		}
	);

	/* CORS — supprime les headers existants avant d'injecter un seul propre */
	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [WP_SITE_URL + '/*'] },
		(details, callback) => {
			const headers: Record<string, string[]> = {};
			for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
				if (!['access-control-allow-origin',
				      'access-control-allow-credentials',
				      'access-control-allow-methods',
				      'access-control-allow-headers'].includes(key.toLowerCase())) {
					headers[key] = value as string[];
				}
			}
			headers['Access-Control-Allow-Origin']      = ['wcpos://-'];
			headers['Access-Control-Allow-Credentials'] = ['true'];
			headers['Access-Control-Allow-Methods']     = ['GET, POST, OPTIONS'];
			headers['Access-Control-Allow-Headers']     = ['Content-Type'];
			callback({ responseHeaders: headers });
		}
	);


	/* ── Bloque toutes les connexions externes non essentielles ──────────────
	   Novu (notifications), updates.wcpos.com, wcpos.com, GitHub update checks
	   Seuls usmm-tir.fr et wcpos:// (assets locaux) sont autorisés ────────── */
	mainWindow.webContents.session.webRequest.onBeforeRequest(
		{
			urls: [
				'*://*.novu.co/*',          // Notifications Novu
				'*://novu.co/*',
				'*://updates.wcpos.com/*',  // Serveur de mises à jour WCPOS
				'*://wcpos.com/*',          // Site wcpos.com (extensions, analytics)
				'*://*.wcpos.com/*',
				'*://api.github.com/repos/wcpos/*', // GitHub releases WCPOS
			],
		},
		(_details, callback) => {
			callback({ cancel: true });
		}
	);

	loadURL(mainWindow);

	mainWindow.on('page-title-updated', (event) => {
		event.preventDefault();
		mainWindow?.setTitle(APP_VERSION);
	});

	/* ── Anti-pub ────────────────────────────────────────────────────────── */
	function runAntiPro(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const js = '(function(){'
			+ 'var H=["upgrade-notice-banner","upgrade-title","upgrade-to-pro-button","view-demo-button","add-fee","add-shipping"];'
			+ 'function css(){if(document.getElementById("wcpos-ap"))return;'
			+ 'var s=document.createElement("style");s.id="wcpos-ap";'
			+ 's.textContent=H.map(function(t){return\'[data-testid="\'+t+\'"]\';}).join(",")+"{ display:none!important }";'
			+ '(document.head||document.documentElement).appendChild(s);}'
			+ 'function hide(){css();H.forEach(function(t){'
			+ 'document.querySelectorAll(\'[data-testid="\'+t+\'"]\').forEach(function(el){'
			+ 'el.style.setProperty("display","none","important");});});}'
			+ 'hide();'
			+ 'if(!window.__ap){'
			+ 'window.__ap=true;'
			+ '[100,300,700,1500,3000].forEach(function(ms){setTimeout(hide,ms);});'
			+ 'setInterval(hide,500);'
			+ 'new MutationObserver(hide).observe(document.documentElement,{childList:true,subtree:true});'
			+ '}})();';
		mainWindow.webContents.executeJavaScript(js).catch((err: Error) => {
			log.error('Anti-pro: ' + err.message);
		});
	}

	/* ── Panneaux custom + caisse ────────────────────────────────────────
	   window._wcpos_action : même variable que le snippet WPCode caisse
	   Le snippet gère ses propres nav/form via wcpos_caisse_nav_js()
	   On intercepte le même flag pour soumettre via REST ──────────────── */
	function runMain(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const REST = WP_REST_BASE;
		const js = '(function(){'

			/* Guard : POS actif = search-products présent */
			+ 'var inPos=!!document.querySelector(\'[data-testid="search-products"]\');'
			+ 'if(!inPos){if(window.__mi){window.__mi=false;}return;}'
			+ 'if(window.__mi)return;'
			+ 'window.__mi=true;'
			+ 'var REST="' + REST + '";'

			/* Textes Pro des panneaux à remplacer
			   "customers" = onglet Clients qui affiche le snippet caisse */
			+ 'var PT={'
			+ '  "products":"Ajustez les prix",'
			+ '  "orders":"Rouvrez et imprimez",'
			+ '  "customers":"Ajoutez de nouveaux clients",'
			+ '  "reports":"Debloquez les rapports"'
			+ '};'

			/* REST helper */
			+ 'function rp(ep,data,cb){'
			+ '  fetch(REST+ep,{method:"POST",headers:{"Content-Type":"application/json"},'
			+ '  body:JSON.stringify(data),credentials:"include"})'
			+ '  .then(function(r){return r.json();})'
			+ '  .then(cb)'
			+ '  .catch(function(e){cb({error:e.message});});'
			+ '}'

			/* Trouve le conteneur Pro */
			+ 'function findPanel(){'
			+ '  var best=null,bestScore=0;'
			+ '  document.querySelectorAll("div,section,aside").forEach(function(el){'
			+ '    var r=el.getBoundingClientRect();'
			+ '    if(r.width<300||r.height<80||r.x>300)return;'
			+ '    if(r.width<window.innerWidth*0.3)return;'
			+ '    if(el.querySelector("#wpp"))return;'
			+ '    var txt=el.textContent||"";'
			+ '    for(var pid in PT){'
			+ '      if(txt.indexOf(PT[pid])!==-1){'
			+ '        var score=r.width*r.height;'
			+ '        if(score>bestScore){bestScore=score;best={el:el,pid:pid};}'
			+ '      }'
			+ '    }'
			+ '  });'
			+ '  return best;'
			+ '}'

			/* Charge le HTML du panneau — ré-exécute les scripts inline
			   (dont wcpos_caisse_nav_js du snippet qui gère data-caisse-nav) */
			+ 'var loadingPanel=false;'
			+ 'function loadPanel(pid,wrap,cv){'
			+ '  if(loadingPanel)return;'
			+ '  loadingPanel=true;'
			+ '  wrap.innerHTML="<p style=\'padding:20px;color:#646970;font-family:sans-serif\'>Chargement...</p>";'
			+ '  var body={panel_id:pid};if(cv)body.caisse_view=cv;'
			+ '  rp("/panel",body,function(d){'
			+ '    loadingPanel=false;'
			+ '    if(!d||!d.html){'
			+ '      wrap.innerHTML="<p style=\'padding:20px;color:#c00;font-family:sans-serif\'>"+(d&&d.error?d.error:"Erreur")+"</p>";'
			+ '      return;'
			+ '    }'
			+ '    loadingPanel=false;'
			+ '    wrap.innerHTML=d.html;'
			/* Ré-exécute les scripts (dont wcpos_caisse_nav_js du snippet) */
			+ '    wrap.querySelectorAll("script").forEach(function(s){'
			+ '      var ns=document.createElement("script");'
			+ '      ns.textContent=s.textContent;'
			+ '      s.parentNode.replaceChild(ns,s);'
			+ '    });'
			+ '  });'
			+ '}'

			/* Injection du panneau */
			+ 'var injecting=false,cPid=null,cWrap=null;'
			+ 'function injectPanel(){'
			+ '  if(injecting)return;'
			+ '  if(!document.querySelector(\'[data-testid="search-products"]\'))return;'
			+ '  var found=findPanel();if(!found)return;'
			+ '  var el=found.el,pid=found.pid;'
			+ '  var ex=el.querySelector("#wpp");'
			+ '  if(ex&&ex.getAttribute("data-pid")===pid)return;'
			+ '  if(ex){ex.setAttribute("data-pid",pid);cPid=pid;cWrap=ex;loadPanel(pid,ex);return;}'
			+ '  injecting=true;'
			+ '  el.innerHTML="";'
			+ '  el.style.cssText="display:flex;flex-direction:column;flex:1;padding:0;overflow:auto;";'
			+ '  var w=document.createElement("div");'
			+ '  w.id="wpp";w.setAttribute("data-pid",pid);'
			+ '  el.appendChild(w);cPid=pid;cWrap=w;loadPanel(pid,w);'
			+ '  setTimeout(function(){injecting=false;},600);'
			+ '}'

			/* Traitement des actions caisse via window._wcpos_action
			   Compatible avec le snippet WPCode qui utilise la même variable */
			+ 'window._wcpos_action=null;'

			+ 'function submitCaisse(action,data){'
			/* Convertit FormData en objet plat si nécessaire */
			+ '  var fd={};'
			+ '  if(data&&typeof data.forEach==="function"){'
			+ '    data.forEach(function(v,k){fd[k]=v;});'
			+ '  } else if(data&&typeof data==="object"){'
			+ '    fd=data;'
			+ '  }'
			+ '  var body=Object.assign({wcpos_caisse_action:action},fd);'
			+ '  rp("/caisse/submit",body,function(d){'
			+ '    hideOverlay();'
			+ '    if(cWrap&&cPid)loadPanel(cPid,cWrap,"dashboard");'
			+ '    setTimeout(chkCaisse,400);'
			+ '  });'
			+ '}'

			/* Polling : intercepte window._wcpos_action (snippet + notre JS) */
			+ 'setInterval(function(){'
			+ '  if(!window._wcpos_action)return;'
			+ '  var a=window._wcpos_action;window._wcpos_action=null;'
			+ '  if(a.type==="nav"&&cWrap&&cPid)loadPanel(cPid,cWrap,a.view);'
			+ '  if(a.type==="submit")submitCaisse(a.action,a.data);'
			+ '},100);'

			+ 'new MutationObserver(function(){injectPanel();}).observe(document.body,{childList:true,subtree:true});'

			/* Overlay caisse fermée */
			+ 'function hasPP(){return !!document.getElementById("wpp");}'
			+ 'function inPOS(){return !!document.querySelector(\'[data-testid="search-products"]\');}'

			+ 'function showOverlay(msg){'
			+ '  if(document.getElementById("wco"))return;'
			+ '  var ov=document.createElement("div");ov.id="wco";'
			+ '  ov.style.cssText="position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);'
			+                      'display:flex;flex-direction:column;align-items:center;justify-content:center;'
			+                      'text-align:center;padding:24px;font-family:sans-serif;color:#fff";'
			+ '  ov.innerHTML='
			+ '    "<div style=\'font-size:3em;margin-bottom:14px\'>&#128274;</div>"'
			+ '    +"<h2 style=\'font-size:1.2em;font-weight:700;margin:0 0 8px\'>Caisse fermee</h2>"'
			+ '    +"<p style=\'font-size:.9em;opacity:.8;max-width:340px;line-height:1.5;margin:0\'>"'
			+ '      +(msg||"Ouvrez la caisse avant d\'utiliser le POS.")+"</p>"'
			+ '    +"<button id=\'wcb\' style=\'background:#00a32a;color:#fff;border:none;padding:10px 22px;'
			+         'border-radius:6px;font-size:.95em;cursor:pointer;margin-top:16px\'>"'
			+ '    +"&#128275; Aller a l\'onglet Clients</button>";'
			+ '  document.body.appendChild(ov);'
			+ '  var btn=document.getElementById("wcb");'
			+ '  if(btn){btn.addEventListener("click",function(){'
			+ '    ov.remove();'
			/* Bouton Clients = sideBtns[2] — confirmé fonctionnel */
			+ '    var sb=Array.from(document.querySelectorAll(\'button[role="button"]\')).filter(function(b){var r=b.getBoundingClientRect();return r.left<10&&r.top>0&&r.width>0;});'
			+ '    if(sb[2])sb[2].click();'
			+ '  });}'
			+ '}'

			+ 'function hideOverlay(){'
			+ '  var ov=document.getElementById("wco");'
			+ '  if(ov)ov.style.setProperty("display","none","important");'
			+ '}'

			+ 'function chkCaisse(){'
			+ '  if(!inPOS())return;'
			+ '  rp("/caisse/status",{},function(d){'
			+ '    if(!d||d.error)return;'
			+ '    if(d.open){hideOverlay();}'
			+ '    else if(!hasPP()){showOverlay(d.message);'
			+ '      var ov=document.getElementById("wco");'
			+ '      if(ov)ov.style.setProperty("display","flex","important");}'
			+ '  });'
			+ '}'

			+ 'var pws=false;'
			+ 'setInterval(function(){'
			+ '  if(!inPOS())return;'
			+ '  if(hasPP()){hideOverlay();pws=true;}'
			+ '  else if(pws){pws=false;chkCaisse();}'
			+ '},300);'

			+ 'chkCaisse();setInterval(chkCaisse,60000);'
			+ 'console.log("wcpos 2.4 OK");'
			+ '})();';

		mainWindow.webContents.executeJavaScript(js).catch((err: Error) => {
			log.error('Main inject: ' + err.message);
		});
	}

	mainWindow.webContents.on('dom-ready', () => {
		mainWindow?.setTitle(APP_VERSION);
		runAntiPro();
		runMain();
	});
	mainWindow.webContents.on('did-finish-load', () => {
		mainWindow?.setTitle(APP_VERSION);
		runAntiPro();
		runMain();
	});
	mainWindow.webContents.on('did-navigate', () => { runAntiPro(); runMain(); });
	mainWindow.webContents.on('did-navigate-in-page', () => { runAntiPro(); runMain(); });

	let pollCount = 0;
	const pollTimer = setInterval(() => {
		if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
		runAntiPro();
		runMain();
		if (++pollCount >= 30) clearInterval(pollTimer);
	}, 2000);

	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) throw new Error('"mainWindow" is not defined');
		if (process.env.START_MINIMIZED) mainWindow.minimize();
		else mainWindow.show();
	});

	mainWindow.on('closed', () => { mainWindow = null; });

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		log.info('Opening in external browser: ' + url);
		shell.openExternal(url);
		return { action: 'deny' };
	});

	let retryCount = 0;
	const MAX_RETRIES = 30;

	mainWindow.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
		log.error('did-fail-load ' + errorCode + ': ' + errorDescription);
		if (errorDescription === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= MAX_RETRIES) { log.error('Max retries reached'); return; }
			retryCount++;
			setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
