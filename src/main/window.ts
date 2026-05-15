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

const APP_VERSION  = 'WCPOS Custom 2.0';
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

	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [WP_SITE_URL + '/*'] },
		(details, callback) => {
			const headers = { ...details.responseHeaders };
			headers['Access-Control-Allow-Origin']  = ['wcpos://-'];
			headers['Access-Control-Allow-Credentials'] = ['true'];
			headers['Access-Control-Allow-Headers'] = ['Content-Type, X-WCPOS-Secret'];
			callback({ responseHeaders: headers });
		}
	);

	loadURL(mainWindow);

	mainWindow.on('page-title-updated', (event) => {
		event.preventDefault();
		mainWindow?.setTitle(APP_VERSION);
	});

	/* ── Anti-pub (bloc indépendant, toujours injecté) ── */
	function runAntiPro(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const js = '(function(){'
			+ 'var H=["upgrade-notice-banner","upgrade-title","upgrade-to-pro-button","view-demo-button","add-fee","add-shipping"];'
			+ 'function css(){if(document.getElementById("wcpos-ap"))return;var s=document.createElement("style");s.id="wcpos-ap";'
			+ 's.textContent=H.map(function(t){return\'[data-testid="\'+t+\'"]\';}).join(",")+"{ display:none!important }";'
			+ '(document.head||document.documentElement).appendChild(s);}'
			+ 'function hide(){css();H.forEach(function(t){document.querySelectorAll(\'[data-testid="\'+t+\'"]\').forEach(function(el){el.style.setProperty("display","none","important");});});}'
			+ 'hide();'
			+ 'if(!window.__ap){'
			+ '  window.__ap=true;'
			+ '  [100,300,700,1500,3000].forEach(function(ms){setTimeout(hide,ms);});'
			+ '  setInterval(hide,500);'
			+ '  new MutationObserver(hide).observe(document.documentElement,{childList:true,subtree:true});'
			+ '}'
			+ '})();';
		mainWindow.webContents.executeJavaScript(js).catch((err: Error) => {
			log.error('Anti-pro: ' + err.message);
		});
	}

	/* ── Injection principale (panneaux + caisse) ────── */
	function runMain(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const restBase = WP_REST_BASE;
		const js = '(function(){'
			+ 'if(window.__mi)return;'
			+ 'if(!document.getElementById("titlebar"))return;'
			+ 'window.__mi=true;'
			+ 'var REST="' + restBase + '";'
			+ 'var PT={'
			+ '  products:"Ajustez les prix et quantit\u00e9s",'
			+ '  orders:"Rouvrez et imprimez les re\u00e7us",'
			+ '  customers:"Ajoutez de nouveaux clients",'
			+ '  reports:"D\u00e9bloquez les rapports"'
			+ '};'
			/* Récupère le secret via /bootstrap (requiert session WP) */
			/* Si échec, on retente toutes les 5s jusqu'à avoir le secret */
			+ 'function fetchSecret(cb){'
			+ '  if(window.__secret){cb(window.__secret);return;}'
			+ '  fetch(REST+"/bootstrap",{credentials:"include"})'
			+ '  .then(function(r){return r.json();})'
			+ '  .then(function(d){if(d&&d.secret){window.__secret=d.secret;cb(d.secret);}else{setTimeout(function(){fetchSecret(cb);},5000);}})'
			+ '  .catch(function(){setTimeout(function(){fetchSecret(cb);},5000);});'
			+ '}'
			/* Helper REST avec secret */
			+ 'function restPost(ep,data,cb){'
			+ '  fetchSecret(function(secret){'
			+ '    var body=Object.assign({secret:secret},data);'
			+ '    fetch(REST+ep,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),credentials:"include"})'
			+ '    .then(function(r){return r.json();})'
			+ '    .then(cb)'
			+ '    .catch(function(e){cb({error:e.message});});'
			+ '  });'
			+ '}'
			+ 'function findPanel(){'
			+ '  var best=null,bestH=Infinity;'
			+ '  document.querySelectorAll("*").forEach(function(el){'
			+ '    var r=el.getBoundingClientRect();'
			+ '    if(r.width<400||r.height<100||r.x>200||r.width<window.innerWidth*0.4)return;'
			+ '    for(var pid in PT){'
			+ '      if((el.textContent||"").indexOf(PT[pid])!==-1&&r.height<bestH){'
			+ '        bestH=r.height;best={el:el,pid:pid};'
			+ '      }'
			+ '    }'
			+ '  });'
			+ '  return best;'
			+ '}'
			+ 'function loadPanel(pid,wrap,cview){'
			+ '  wrap.innerHTML="<p style=\'padding:20px;color:#646970\'>Chargement...</p>";'
			+ '  var body={panel_id:pid};if(cview)body.caisse_view=cview;'
			+ '  restPost("/panel",body,function(d){'
			+ '    if(!d||!d.html){wrap.innerHTML="<p style=\'padding:20px;color:#c00\'>"+(d&&d.error?d.error:"Erreur")+"</p>";return;}'
			+ '    wrap.innerHTML=d.html;'
			+ '    wrap.querySelectorAll("script").forEach(function(s){var ns=document.createElement("script");ns.textContent=s.textContent;s.parentNode.replaceChild(ns,s);});'
			+ '    bind(wrap);'
			+ '  });'
			+ '}'
			+ 'function bind(root){'
			+ '  root.querySelectorAll("[data-caisse-nav]:not([data-bound])").forEach(function(b){'
			+ '    b.setAttribute("data-bound","1");'
			+ '    b.addEventListener("click",function(){window.__ca={type:"nav",view:b.getAttribute("data-caisse-nav")||""};});'
			+ '  });'
			+ '  root.querySelectorAll("[data-caisse-form]:not([data-bound])").forEach(function(f){'
			+ '    f.setAttribute("data-bound","1");'
			+ '    f.addEventListener("submit",function(e){'
			+ '      e.preventDefault();var ft=f.getAttribute("data-caisse-form");'
			+ '      var fd={};new FormData(f).forEach(function(v,k){fd[k]=v;});'
			+ '      window.__ca={type:"submit",action:ft,data:fd};'
			+ '    });'
			+ '  });'
			+ '}'
			+ 'var inj=false,curPid=null,curWrap=null;'
			+ 'function injectPanel(){'
			+ '  if(inj)return;'
			+ '  var found=findPanel();if(!found)return;'
			+ '  var el=found.el,pid=found.pid;'
			+ '  var ex=el.querySelector("#wpp");'
			+ '  if(ex&&ex.getAttribute("data-pid")===pid)return;'
			+ '  if(ex){ex.setAttribute("data-pid",pid);curPid=pid;curWrap=ex;loadPanel(pid,ex);return;}'
			+ '  inj=true;el.innerHTML="";'
			+ '  el.style.cssText="display:flex;flex-direction:column;flex:1;padding:0;overflow:hidden;";'
			+ '  var w=document.createElement("div");w.id="wpp";w.setAttribute("data-pid",pid);'
			+ '  el.appendChild(w);curPid=pid;curWrap=w;loadPanel(pid,w);'
			+ '  setTimeout(function(){inj=false;},500);'
			+ '}'
			+ 'window.__ca=null;'
			+ 'function submitCaisse(action,data){'
			+ '  var body=Object.assign({wcpos_caisse_action:action},data);'
			+ '  restPost("/caisse/submit",body,function(){'
			+ '    if(curWrap&&curPid)loadPanel(curPid,curWrap,"dashboard");'
			+ '    setTimeout(chkCaisse,400);'
			+ '  });'
			+ '}'
			+ 'setInterval(function(){'
			+ '  if(!window.__ca)return;'
			+ '  var a=window.__ca;window.__ca=null;'
			+ '  if(a.type==="nav"&&curWrap&&curPid)loadPanel(curPid,curWrap,a.view);'
			+ '  if(a.type==="submit")submitCaisse(a.action,a.data);'
			+ '},100);'
			+ 'new MutationObserver(function(){bind(document.body);}).observe(document.body,{childList:true,subtree:true});'
			/* Overlay caisse */
			+ 'var pws=false;'
			+ 'function hasPP(){return !!document.getElementById("wpp");}'
			+ 'function showOv(msg){'
			+ '  if(document.getElementById("wco"))return;'
			+ '  var ov=document.createElement("div");ov.id="wco";'
			+ '  ov.style.cssText="position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:sans-serif;color:#fff";'
			+ '  ov.innerHTML="<div style=\'font-size:3em;margin-bottom:14px\'>\uD83D\uDD12</div>"'
			+ '    +"<h2 style=\'font-size:1.2em;font-weight:700;margin:0 0 10px\'>Caisse ferm\u00e9e</h2>"'
			+ '    +"<p style=\'font-size:.9em;opacity:.8;max-width:360px;line-height:1.5;margin:0 0 20px\'>"+(msg||"Ouvrez la caisse avant d\'utiliser le POS.")+"</p>"'
			+ '    +"<button id=\'wcb\' style=\'background:#00a32a;color:#fff;border:none;padding:10px 22px;border-radius:6px;font-size:.95em;cursor:pointer\'>\uD83D\uDD13 Aller \u00e0 l\'onglet Caisse</button>";'
			+ '  document.body.appendChild(ov);'
			+ '  var btn=document.getElementById("wcb");'
			+ '  if(btn){btn.addEventListener("click",function(){'
			+ '    ov.style.display="none";'
			+ '    var btns=Array.from(document.querySelectorAll(\'button[role="button"]\')).filter(function(b){var r=b.getBoundingClientRect();return r.left<10&&r.top>0&&r.width>0;});'
			+ '    if(btns[2])btns[2].click();'
			+ '  });}'
			+ '}'
			+ 'function hideOv(){var ov=document.getElementById("wco");if(ov)ov.style.setProperty("display","none","important");}'
			+ 'function chkCaisse(){'
			+ '  restPost("/caisse/status",{},function(d){'
			/* Ne montre l'overlay QUE si on a une réponse claire "fermée" */
			+ '    if(!d||d.error)return;'
			+ '    if(d.open){hideOv();}'
			+ '    else if(!hasPP()){showOv(d.message);var ov=document.getElementById("wco");if(ov)ov.style.setProperty("display","flex","important");}'
			+ '  });'
			+ '}'
			+ 'setInterval(function(){'
			+ '  if(hasPP()){hideOv();pws=true;}else if(pws){pws=false;chkCaisse();}'
			+ '},300);'
			+ 'new MutationObserver(function(){injectPanel();}).observe(document.body,{childList:true,subtree:true});'
			/* Démarre la caisse après avoir le secret */
			+ 'fetchSecret(function(){chkCaisse();});'
			+ 'setInterval(chkCaisse,60000);'
			+ 'console.log("wcpos 2.0 OK");'
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
