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

const APP_VERSION  = 'WCPOS Custom 4.7';
const WP_SITE_URL  = 'https://usmm-tir.fr';
const WP_REST_BASE = 'https://usmm-tir.fr/wp-json/wcpos-custom/v1';

function tabFromUrl(url: string): string | null {
	try {
		const segments = new URL(url).pathname.replace(/\/+$/,'').split('/').filter(Boolean);
		const last = segments[segments.length - 1]?.toLowerCase() ?? '';
		return ['products','orders','customers','reports'].includes(last) ? last : null;
	} catch { return null; }
}

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

	/* ── Logging renderer ────────────────────────────────────────────────── */
	mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
		const short = (src ?? '').split('/').pop() ?? '';
		const tag   = `[R ${short}:${line}]`;
		if      (level === 3) log.error(`${tag} ${message}`);
		else if (level === 2) log.warn (`${tag} ${message}`);
		else                  log.info (`${tag} ${message}`);
		if (message.startsWith('[resize] recalcul pid=')) {
			const pid = message.replace('[resize] recalcul pid=', '').trim();
			setTimeout(() => runPanelForTab(pid || lastTab), 400);
		}
		/* Navigation demandée par le renderer (overlay bouton caisse) :
		   le renderer ne peut pas naviguer fiablement dans React Navigation,
		   donc il signale ici et le main process fait loadURL() directement. */
		if (message.startsWith('[wcpos-nav-to] ')) {
			const target = message.replace('[wcpos-nav-to] ', '').trim();
			log.info(`[nav-to] demande → ${target}`);
			if (!mainWindow || mainWindow.isDestroyed()) return;
			try {
				const cur = mainWindow.webContents.getURL();
				const parsed = new URL(cur);
				const segs = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
				if (segs.length > 0) segs[segs.length - 1] = target;
				else segs.push(target);
				const newUrl = parsed.origin + '/' + segs.join('/');
				log.info(`[nav-to] ${cur} → ${newUrl}`);
				lastTab = null; /* force re-injection panel après navigation */
				mainWindow.webContents.loadURL(newUrl);
			} catch (e) { log.error(`[nav-to] ${e}`); }
		}
	});
	mainWindow.webContents.on('render-process-gone', (_e, d) =>
		log.error(`[renderer-gone] reason=${d.reason} exit=${d.exitCode}`));
	mainWindow.webContents.on('unresponsive', () => log.error('[renderer] UNRESPONSIVE'));
	mainWindow.webContents.on('responsive',   () => log.info ('[renderer] responsive'));

	/* ── Blocage réseau ──────────────────────────────────────────────────── */
	mainWindow.webContents.session.webRequest.onBeforeRequest(
		{ urls: ['*://*.novu.co/*','*://novu.co/*','*://updates.wcpos.com/*',
		         '*://wcpos.com/*','*://*.wcpos.com/*','*://api.github.com/repos/wcpos/*'] },
		(_d, cb) => cb({ cancel: true })
	);
	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => cb({ requestHeaders: { ...d.requestHeaders, Origin: 'wcpos://-' } })
	);
	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => {
			const h: Record<string,string[]> = {};
			for (const [k,v] of Object.entries(d.responseHeaders ?? {})) {
				if (!['access-control-allow-origin','access-control-allow-credentials',
				      'access-control-allow-methods','access-control-allow-headers',
				      'x-content-type-options'].includes(k.toLowerCase()))
					h[k] = v as string[];
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

	/* ════════════════════════════════════════════════════════════════════════
	   BLOC 1 — Anti-pub
	   ════════════════════════════════════════════════════════════════════════ */
	function runAntiPro(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const HIDE = ['upgrade-notice-banner','upgrade-title','upgrade-to-pro-button',
		              'view-demo-button','add-fee','add-shipping'];
		const css = HIDE.map(t => `[data-testid='${t}']`).join(',')
			+ `,[aria-label='Notifications'],[aria-label='Open notification center']{display:none!important}`;
		mainWindow.webContents.executeJavaScript(`(function(){
			if(window.__ap||!document||!document.documentElement)return;
			try{
				window.__ap=true;
				var s=document.createElement('style');s.id='wcpos-ap';
				s.textContent=${JSON.stringify(css)};
				(document.head||document.documentElement).appendChild(s);
				console.log('[ap] OK');
			}catch(e){console.error('[ap]',e.message);}
		})();`).catch((e: Error) => log.error('[ap] '+e.message));
	}

	/* ════════════════════════════════════════════════════════════════════════
	   BLOC 2 — Setup caisse / overlay
	   ════════════════════════════════════════════════════════════════════════ */
	function runSetup(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.executeJavaScript(`(function(){
			if(window.__setup||!document||!document.body)return;
			try{
				if(!document.querySelector('[data-testid="search-products"]')){
					console.log('[setup] hors POS'); return;
				}
				window.__setup=true;
				console.log('[setup] v4.2');
				var REST=${JSON.stringify(WP_REST_BASE)};

				function rp(ep,data,cb){
					fetch(REST+ep,{method:'POST',headers:{'Content-Type':'application/json'},
						body:JSON.stringify(data),credentials:'include'})
						.then(function(r){return r.json();}).then(cb)
						.catch(function(e){console.error('[rp]',ep,e.message);cb({error:e.message});});
				}

				window.__loadPanel=function(pid,wrap,cv,force){
					if(window.__loadingPanel&&!force)return;
					window.__loadingPanel=true;
					wrap.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement\u2026</p>';
					rp('/panel',cv?{panel_id:pid,caisse_view:cv}:{panel_id:pid},function(d){
						window.__loadingPanel=false;
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
				};

				function navToClients(){
					/* Signale au main process de faire loadURL() — plus fiable
					   que toute manipulation DOM/React depuis le renderer. */
					console.log('[wcpos-nav-to] customers');
				}

				window.__showOverlay=function(msg){
					if(document.getElementById('wco'))return;
					var ov=document.createElement('div');ov.id='wco';
					ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);'
						+'display:flex;flex-direction:column;align-items:center;justify-content:center;'
						+'text-align:center;padding:24px;font-family:sans-serif;color:#fff';
					ov.innerHTML='<div style="font-size:3em;margin-bottom:14px">&#128274;</div>'
						+'<h2 style="font-size:1.2em;font-weight:700;margin:0 0 8px">Caisse ferm\u00e9e</h2>'
						+'<p style="font-size:.9em;opacity:.8;max-width:340px;line-height:1.5;margin:0 0 20px">'
						+(msg||'La caisse est ferm\u00e9e. Ouvrez-la avant de commencer.')+'</p>'
						+'<button id="wcb" style="background:#00a32a;color:#fff;border:none;'
						+'padding:12px 28px;border-radius:6px;font-size:1em;font-weight:600;cursor:pointer">'
						+'\uD83D\uDD13 Ouvrir la caisse</button>';
					document.body.appendChild(ov);
					document.getElementById('wcb').addEventListener('click',function(){
						ov.remove(); navToClients();
					});
					console.log('[overlay] show');
				};
				window.__hideOverlay=function(){
					var ov=document.getElementById('wco');
					if(ov){ov.remove();console.log('[overlay] hide');}
				};

				function hasPP(){
					var w=document.getElementById('wpp');
					return !!(w&&w.style.display!=='none'&&w.innerHTML.length>100);
				}
				function inPOS(){return !!document.querySelector('[data-testid="search-products"]');}
				function currentTab(){
					var u=window.location.href.toLowerCase();
					var tabs=['products','orders','customers','reports'];
					for(var i=0;i<tabs.length;i++){if(u.indexOf(tabs[i])!==-1)return tabs[i];}
					return null;
				}

				function chkCaisse(){
					if(!inPOS())return;
					var tab=currentTab();
					var isPosTab=(tab==='products'||tab==='orders'||tab===null);
					rp('/caisse/status',{},function(d){
						if(!d||d.error)return;
						console.log('[caisse] open='+d.open+' tab='+tab);
						if(d.open){window.__hideOverlay();}
						else if(isPosTab){window.__showOverlay(d.message);}
					});
				}

				window._wcpos_action=null;
				setInterval(function(){
					if(!window._wcpos_action)return;
					var a=window._wcpos_action;window._wcpos_action=null;
					var wpp=document.getElementById('wpp');
					if(a.type==='nav'&&wpp){
						window.__loadingPanel=false;
						window.__loadPanel(wpp.getAttribute('data-pid'),wpp,a.view,true);
					}
					if(a.type==='submit'){
						var fd={};
						if(a.data&&typeof a.data.entries==='function'){
							for(var p of a.data.entries()){fd[p[0]]=p[1];}
						}else if(a.data&&typeof a.data==='object'){fd=Object.assign({},a.data);}
						rp('/caisse/submit',Object.assign({wcpos_caisse_action:a.action},fd),function(d){
							window.__hideOverlay();
							var wpp2=document.getElementById('wpp');
							if(wpp2)window.__loadPanel(wpp2.getAttribute('data-pid'),wpp2,'dashboard',true);
							setTimeout(chkCaisse,400);
						});
					}
				},200);

				chkCaisse();
				setInterval(chkCaisse,60000);
				var _pws=false;
				setInterval(function(){
					if(!inPOS())return;
					if(hasPP()){window.__hideOverlay();_pws=true;}
					else if(_pws){_pws=false;chkCaisse();}
				},1000);

				if(!window.__wcpos_resize){
					window.__wcpos_resize=true;
					var _rt=null;
					window.addEventListener('resize',function(){
						clearTimeout(_rt);
						_rt=setTimeout(function(){
							var w=document.getElementById('wpp');
							if(w){w.remove();console.log('[resize] recalcul pid='+w.getAttribute('data-pid'));}
						},400);
					});
				}

				console.log('[setup] OK');
			}catch(e){console.error('[setup] EXCEPTION',e.message,e.stack);}
		})();`).catch((e: Error) => log.error('[setup] '+e.message));
	}

	/* ════════════════════════════════════════════════════════════════════════
	   BLOC 3 — Panel
	   ════════════════════════════════════════════════════════════════════════ */
	function runPanelForTab(tab: string | null): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;

		if (!tab) {
			mainWindow.webContents.executeJavaScript(`(function(){
				var w=document.getElementById('wpp');
				if(w){w.style.setProperty('display','none','important');console.log('[panel] cache');}
			})();`).catch(() => {});
			return;
		}

		const PT: Record<string,string> = {
			products:  'ajustez les prix',
			orders:    'imprimez les',
			customers: 'ajoutez de nouveaux clients',
			reports:   'bloquez les rapports',
		};
		const sig = PT[tab];
		if (!sig) return;
		log.info(`[panel] → ${tab}`);

		mainWindow.webContents.executeJavaScript(`(function(){
			try{
				var tab=${JSON.stringify(tab)};
				var sig=${JSON.stringify(sig)}.toLowerCase();
				if(!document.querySelector('[data-testid="search-products"]')){
					console.log('[panel] hors POS'); return;
				}
				if(!window.__setup){console.log('[panel] setup absent'); return;}

				var wpp=document.getElementById('wpp');
				if(wpp&&wpp.getAttribute('data-pid')===tab&&wpp.innerHTML.length>100){
					wpp.style.removeProperty('display');
					console.log('[panel] re-affiche tab='+tab);
					return;
				}

				var W=window.innerWidth, H=window.innerHeight;
				var best=null, bestScore=0, checked=0;

				document.querySelectorAll('div,section,aside').forEach(function(el){
					if(el.id==='wpp')return;
					if((el.textContent||'').toLowerCase().indexOf(sig)===-1)return;
					var childHas=false;
					for(var i=0;i<el.children.length;i++){
						if((el.children[i].textContent||'').toLowerCase().indexOf(sig)!==-1){
							childHas=true; break;
						}
					}
					if(childHas)return;
					checked++;
					var r=el.getBoundingClientRect();
					if(r.width<W*0.15||r.height<H*0.05)return;
					if(r.x===0&&r.width>W*0.85)return;
					if(r.x>W*0.75||r.width<W*0.20)return;
					var score=r.width*r.height;
					if(score>bestScore){
						bestScore=score; best={el:el,r:r};
						console.log('[panel] candidat tab='+tab
							+' x='+Math.round(r.x)+' w='+Math.round(r.width)+' h='+Math.round(r.height));
					}
				});

				console.log('[panel] checked='+checked+' found='+(best?'OUI':'NON'));

				if(!best){
					if(wpp)wpp.style.setProperty('display','none','important');
					return;
				}

				var navLeft=(function(){
					var sel=['[class*="TabBar"]','[class*="Sidebar"]','[class*="Navigation"]',
					         '[class*="sidebar"]','nav[class]'];
					for(var i=0;i<sel.length;i++){
						var e2=document.querySelector(sel[i]);
						if(e2){var r2=e2.getBoundingClientRect();
							if(r2.left===0&&r2.width>0&&r2.width<W*0.15)return Math.round(r2.right);}
					}
					return best.r.left<W*0.30?Math.round(best.r.left):55;
				})();

				var hdrBottom=(function(){
					var maxB=0;
					document.querySelectorAll('header,nav,[role="banner"],[role="navigation"],'
						+'[class*="Header"],[class*="TopBar"],[class*="AppBar"],'
						+'[class*="Toolbar"],[class*="header"],[class*="topbar"],[class*="NavBar"]')
					.forEach(function(e3){
						var r3=e3.getBoundingClientRect();
						if(r3.top<=5&&r3.width>W*0.5&&r3.height>10&&r3.height<200)
							if(Math.round(r3.bottom)>maxB)maxB=Math.round(r3.bottom);
					});
					return maxB>0?maxB:50;
				})();

				console.log('[panel] navLeft='+navLeft+' hdrBottom='+hdrBottom);

				if(wpp)wpp.remove();
				var w=document.createElement('div');
				w.id='wpp'; w.setAttribute('data-pid',tab);
				w.style.cssText='position:fixed'
					+';top:'+hdrBottom+'px;left:'+navLeft+'px;right:0;bottom:0'
					+';z-index:50;background:#f0f0f1;overflow-y:auto;box-sizing:border-box';
				document.body.appendChild(w);
				best.el.style.setProperty('visibility','hidden','important');
				window.__loadPanel(tab,w,null,true);
			}catch(e){console.error('[panel] EXCEPTION',e.message,e.stack);}
		})();`).catch((e: Error) => log.error(`[panel] ${e.message}`));
	}

	/* ── Orchestration ───────────────────────────────────────────────────── */
	let lastTab: string | null = null;

	function onNavigate(label: string, url?: string): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const currentUrl = url ?? mainWindow.webContents.getURL();
		const tab = tabFromUrl(currentUrl);
		log.info(`[${label}] url=${currentUrl} tab=${tab}`);
		runAntiPro();
		runSetup();
		if (tab !== lastTab) {
			lastTab = tab;
			setTimeout(() => runPanelForTab(tab), 400);
		}
	}

	mainWindow.webContents.on('dom-ready', () => {
		mainWindow?.setTitle(APP_VERSION);
		log.info('[dom-ready]');
		onNavigate('dom-ready');
	});
	mainWindow.webContents.on('did-navigate', (_e, url) => {
		log.info(`[did-navigate] ${url}`);
		lastTab = null;
		onNavigate('did-navigate', url);
	});
	mainWindow.webContents.on('did-navigate-in-page', (_e, url) => {
		log.info(`[did-navigate-in-page] ${url}`);
		onNavigate('did-navigate-in-page', url);
	});

	let pollCount = 0;
	const pollTimer = setInterval(() => {
		if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
		const url = mainWindow.webContents.getURL();
		const tab = tabFromUrl(url);
		log.info(`[poll ${pollCount+1}/10] url=${url} tab=${tab}`);
		runAntiPro(); runSetup();
		if (tab && tab !== lastTab) { lastTab = tab; setTimeout(() => runPanelForTab(tab), 400); }
		if (++pollCount >= 10) clearInterval(pollTimer);
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
		log.error(`[did-fail-load] ${desc}`);
		if (desc === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= 30) return;
			retryCount++;
			setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
