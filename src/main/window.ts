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
	loadURL = serve({ directory: pathToDist, scheme: 'wcpos' });
}

let mainWindow: BrowserWindow | null;

const APP_VERSION  = 'WCPOS Custom 3.4';
const WP_SITE_URL  = 'https://usmm-tir.fr';
const WP_REST_BASE = 'https://usmm-tir.fr/wp-json/wcpos-custom/v1';

export const createWindow = (): void => {
	mainWindow = new BrowserWindow({
		show: false, width: 1024, height: 728, title: APP_VERSION,
		icon: path.join(__dirname, '../../icons/icon.ico'),
		webPreferences: {
			preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
			sandbox: false, nodeIntegration: false, contextIsolation: true,
		},
		backgroundColor: '#fff',
	});

	if (isDevelopment) mainWindow.webContents.openDevTools();

	/* ── Blocage connexions externes ────────────────────────────────────── */
	mainWindow.webContents.session.webRequest.onBeforeRequest(
		{ urls: ['*://*.novu.co/*','*://novu.co/*','*://updates.wcpos.com/*',
		         '*://wcpos.com/*','*://*.wcpos.com/*','*://api.github.com/repos/wcpos/*'] },
		(_d, cb) => cb({ cancel: true })
	);
	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => cb({ requestHeaders: { ...d.requestHeaders } })
	);
	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => {
			const h: Record<string, string[]> = {};
			for (const [k, v] of Object.entries(d.responseHeaders ?? {})) {
				if (!['access-control-allow-origin','access-control-allow-credentials',
				      'access-control-allow-methods','access-control-allow-headers']
				    .includes(k.toLowerCase())) h[k] = v as string[];
			}
			h['Access-Control-Allow-Origin']      = ['wcpos://-'];
			h['Access-Control-Allow-Credentials'] = ['true'];
			h['Access-Control-Allow-Methods']     = ['GET, POST, OPTIONS'];
			h['Access-Control-Allow-Headers']     = ['Content-Type, Authorization'];
			cb({ responseHeaders: h });
		}
	);

	loadURL(mainWindow);
	mainWindow.on('page-title-updated', e => { e.preventDefault(); mainWindow?.setTitle(APP_VERSION); });

	/* ═══════════════════════════════════════════════════════════════════════
	   BLOC 1 — Anti-pub
	   ═══════════════════════════════════════════════════════════════════════ */
	function runAntiPro(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const HIDE = ['upgrade-notice-banner','upgrade-title','upgrade-to-pro-button',
		              'view-demo-button','add-fee','add-shipping'];
		const hideCss = HIDE.map(t => `[data-testid='${t}']`).join(',')
			+ `,[aria-label='Notifications'],[aria-label='Open notification center']{display:none!important}`;
		const js = `(function(){
			var H=${JSON.stringify(HIDE)};
			function css(){
				if(document.getElementById('wcpos-ap'))return;
				var s=document.createElement('style');s.id='wcpos-ap';
				s.textContent=${JSON.stringify(hideCss)};
				(document.head||document.documentElement).appendChild(s);
			}
			function hide(){
				css();
				H.forEach(function(t){
					document.querySelectorAll('[data-testid="'+t+'"]').forEach(function(el){
						el.style.setProperty('display','none','important');
					});
				});
				['Notifications','Open notification center'].forEach(function(label){
					document.querySelectorAll('[aria-label="'+label+'"]').forEach(function(el){
						el.style.setProperty('display','none','important');
					});
				});
			}
			hide();
			if(!window.__ap){
				window.__ap=true;
				[100,300,700,1500,3000].forEach(function(ms){setTimeout(hide,ms);});
				setInterval(hide,500);
				new MutationObserver(hide).observe(document.documentElement,{childList:true,subtree:true});
			}
		})();`;
		mainWindow.webContents.executeJavaScript(js).catch((e: Error) => log.error('Anti-pro: '+e.message));
	}

	/* ═══════════════════════════════════════════════════════════════════════
	   BLOC 2 — Panneaux custom + caisse
	   Principe : #wpp est injecté dans document.body (hors portée React).
	   Le MutationObserver est déboncé à 150ms pour ne pas saturer le thread.
	   ═══════════════════════════════════════════════════════════════════════ */
	function runMain(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const js = `(function(){
			var inPos=!!document.querySelector('[data-testid="search-products"]');
			if(!inPos){if(window.__mi)window.__mi=false;return;}
			if(window.__mi)return;
			window.__mi=true;

			var REST=${JSON.stringify(WP_REST_BASE)};
			var PT={
				products:'ajustez les prix',
				orders:'imprimez les',
				customers:'ajoutez de nouveaux clients',
				reports:'bloquez les rapports'
			};

			function rp(ep,data,cb){
				fetch(REST+ep,{method:'POST',headers:{'Content-Type':'application/json'},
					body:JSON.stringify(data),credentials:'include'})
					.then(function(r){return r.json();}).then(cb)
					.catch(function(e){cb({error:e.message});});
			}

			var loadingPanel=false;
			function loadPanel(pid,wrap,cv,force){
				if(loadingPanel&&!force)return;
				loadingPanel=true;
				wrap.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement...</p>';
				var body={panel_id:pid};if(cv)body.caisse_view=cv;
				rp('/panel',body,function(d){
					loadingPanel=false;
					if(!d||!d.html){
						wrap.innerHTML='<p style="padding:20px;color:#c00">'+(d&&d.error?d.error:'Erreur')+'</p>';
						return;
					}
					wrap.innerHTML=d.html;
					wrap.querySelectorAll('script').forEach(function(s){
						var ns=document.createElement('script');ns.textContent=s.textContent;
						s.parentNode.replaceChild(ns,s);
					});
				});
			}

			function findPanel(){
				var W=window.innerWidth,H=window.innerHeight,best=null,bestScore=0;
				document.querySelectorAll('div,section,aside').forEach(function(el){
					var r=el.getBoundingClientRect();
					if(r.width<W*0.15||r.height<H*0.05)return;
					if(r.x===0&&r.width>W*0.85)return;
					if(r.x>W*0.75||r.width<W*0.20)return;
					if(el.id==='wpp')return;
					var txt=(el.textContent||'').toLowerCase();
					for(var pid in PT){
						if(txt.indexOf(PT[pid])!==-1){
							var score=r.width*r.height;
							if(score>bestScore){bestScore=score;best={el:el,pid:pid,r:r};}
						}
					}
				});
				return best;
			}

			var injecting=false,cPid=null,cWrap=null;

			function injectPanel(){
				if(injecting||loadingPanel)return;
				if(!document.querySelector('[data-testid="search-products"]'))return;

				var wpp=document.getElementById('wpp');
				var found=findPanel();

				/* Mauvais onglet — cacher le panel sans le supprimer */
				if(!found){
					if(wpp)wpp.style.setProperty('display','none','important');
					return;
				}

				var el=found.el,pid=found.pid,r=found.r;

				/* Panel déjà chargé pour ce pid — juste le rendre visible */
				if(wpp&&wpp.getAttribute('data-pid')===pid&&wpp.innerHTML.length>100){
					wpp.style.removeProperty('display');
					el.style.setProperty('visibility','hidden','important');
					return;
				}

				/* Création du panel dans document.body (hors React) */
				injecting=true;
				if(wpp)wpp.remove();

				var w=document.createElement('div');
				w.id='wpp';
				w.setAttribute('data-pid',pid);
				/* Couvre la zone de contenu depuis la position du Pro upsell */
				w.style.cssText='position:fixed'
					+';top:'+r.top+'px;left:'+r.left+'px;right:0;bottom:0'
					+';z-index:500;background:#f0f0f1;overflow-y:auto;box-sizing:border-box';
				document.body.appendChild(w);

				/* Masque le Pro upsell (visibility:hidden préserve le layout) */
				el.style.setProperty('visibility','hidden','important');
				el.setAttribute('data-wcpos-off','1');

				cPid=pid;cWrap=w;
				loadPanel(pid,w,null,true);
				setTimeout(function(){injecting=false;},600);
			}

			window._wcpos_action=null;

			function submitCaisse(action,data){
				var fd={};
				if(data&&typeof data.entries==='function'){
					for(var pair of data.entries()){fd[pair[0]]=pair[1];}
				}else if(data&&typeof data==='object'){fd=Object.assign({},data);}
				rp('/caisse/submit',Object.assign({wcpos_caisse_action:action},fd),function(d){
					hideOverlay();
					if(cWrap&&cPid)loadPanel(cPid,cWrap,'dashboard',true);
					setTimeout(chkCaisse,400);
				});
			}

			setInterval(function(){
				if(!window._wcpos_action)return;
				var a=window._wcpos_action;window._wcpos_action=null;
				if(a.type==='nav'&&cWrap&&cPid){loadingPanel=false;loadPanel(cPid,cWrap,a.view,true);}
				if(a.type==='submit')submitCaisse(a.action,a.data);
			},100);

			/* MutationObserver déboncé 150ms — évite la saturation React */
			var moTimer=null;
			new MutationObserver(function(){
				clearTimeout(moTimer);
				moTimer=setTimeout(injectPanel,150);
			}).observe(document.body,{childList:true,subtree:true});

			function hasPP(){
				var w=document.getElementById('wpp');
				return !!(w&&w.style.display!=='none'&&w.innerHTML.length>100);
			}
			function inPOS(){return !!document.querySelector('[data-testid="search-products"]');}

			function showOverlay(msg){
				if(document.getElementById('wco'))return;
				var ov=document.createElement('div');ov.id='wco';
				ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);'
					+'display:flex;flex-direction:column;align-items:center;justify-content:center;'
					+'text-align:center;padding:24px;font-family:sans-serif;color:#fff';
				ov.innerHTML='<div style="font-size:3em;margin-bottom:14px">&#128274;</div>'
					+'<h2 style="font-size:1.2em;font-weight:700;margin:0 0 8px">Caisse fermee</h2>'
					+'<p style="font-size:.9em;opacity:.8;max-width:340px;line-height:1.5;margin:0 0 20px">'
					+(msg||'La caisse est fermee.')+'</p>'
					+'<button id="wcb" style="background:#00a32a;color:#fff;border:none;'
					+'padding:10px 22px;border-radius:6px;font-size:.95em;cursor:pointer">OK, compris</button>';
				document.body.appendChild(ov);
				var btn=document.getElementById('wcb');
				if(btn)btn.addEventListener('click',function(){ov.remove();});
			}

			function hideOverlay(){
				var ov=document.getElementById('wco');
				if(ov)ov.style.setProperty('display','none','important');
			}

			function chkCaisse(){
				if(!inPOS())return;
				rp('/caisse/status',{},function(d){
					if(!d||d.error)return;
					if(d.open){hideOverlay();}
					else if(!hasPP()){
						showOverlay(d.message);
						var ov=document.getElementById('wco');
						if(ov)ov.style.setProperty('display','flex','important');
					}
				});
			}

			var pws=false;
			setInterval(function(){
				if(!inPOS())return;
				if(hasPP()){hideOverlay();pws=true;}
				else if(pws){pws=false;chkCaisse();}
			},300);

			chkCaisse();setInterval(chkCaisse,60000);
			console.log('wcpos 3.4 OK');
		})();`;
		mainWindow.webContents.executeJavaScript(js).catch((e: Error) => log.error('Main inject: '+e.message));
	}

	mainWindow.webContents.on('dom-ready', () => { mainWindow?.setTitle(APP_VERSION); runAntiPro(); runMain(); });
	mainWindow.webContents.on('did-navigate', () => { runAntiPro(); runMain(); });
	mainWindow.webContents.on('did-navigate-in-page', () => { runAntiPro(); runMain(); });

	let pollCount = 0;
	const pollTimer = setInterval(() => {
		if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
		runAntiPro(); runMain();
		if (++pollCount >= 30) clearInterval(pollTimer);
	}, 2000);

	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) throw new Error('"mainWindow" is not defined');
		if (process.env.START_MINIMIZED) mainWindow.minimize(); else mainWindow.show();
	});
	mainWindow.on('closed', () => { mainWindow = null; });
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url); return { action: 'deny' };
	});

	let retryCount = 0;
	mainWindow.webContents.on('did-fail-load', async (_e, _code, desc) => {
		if (desc === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= 30) return;
			retryCount++;
			setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
