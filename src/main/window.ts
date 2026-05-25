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

const APP_VERSION  = 'WCPOS Custom 5.0.1';
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
		if (message.startsWith('[wcpos-nav-to] ')) {
			const target = message.replace('[wcpos-nav-to] ', '').trim();
			log.info(`[nav-to] → ${target}`);
			if (!mainWindow || mainWindow.isDestroyed()) return;
			try {
				const cur = mainWindow.webContents.getURL();
				const parsed = new URL(cur);
				const segs = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
				if (segs.length > 0) segs[segs.length - 1] = target;
				else segs.push(target);
				const newUrl = parsed.origin + '/' + segs.join('/');
				log.info(`[nav-to] ${cur} → ${newUrl}`);
				lastTab = null;
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
		              'view-demo-button','add-fee','add-shipping','add-misc-product'];
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
	   BLOC 2 — Setup caisse
	   v5.0.0 : Overlay caissier masqué sur onglets non-POS
	   v5.0.1 : Appel immédiat de chkCaisse après navigation (fix persistance overlay)
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
				console.log('[setup] v5.0.1');

				var REST=${JSON.stringify(WP_REST_BASE)};
				var isAdmin = false;
				var POS_TABS = ['products', 'orders'];

				function rp(ep,data,cb){
					fetch(REST+ep,{method:'POST',headers:{'Content-Type':'application/json'},
						body:JSON.stringify(data),credentials:'include'})
						.then(function(r){return r.json();}).then(cb)
						.catch(function(e){console.error('[rp]',ep,e.message);cb({error:e.message});});
				}

				function showAdminToast(msg, type){
					var old = document.getElementById('wct');
					if(old) old.remove();
					var toast = document.createElement('div');
					toast.id = 'wct';
					var bgColor = type==='admin_open' ? '#00a32a' : '#d63638';
					toast.style.cssText = 'position:fixed;bottom:20px;right:20px;left:20px;max-width:320px;margin-left:auto;'
						+ 'background:'+bgColor+';color:#fff;padding:12px 20px;border-radius:6px;'
						+ 'font-size:13px;font-weight:600;z-index:999999;'
						+ 'box-shadow:0 4px 12px rgba(0,0,0,.15);font-family:sans-serif;';
					toast.textContent = msg;
					document.body.appendChild(toast);
					console.log('[toast] admin: ' + (type==='admin_open'?'ouverte':'fermee'));
					setTimeout(function(){ if(toast&&toast.remove) toast.remove(); }, 10000);
				}

				function hideAdminToast(){ var old = document.getElementById('wct'); if(old) old.remove(); }

				function showCaissierOverlay(msg){
					var old = document.getElementById('wco');
					if(old) old.remove();
					var navLeft = 56;
					var sel = ['[class*="TabBar"]','[class*="Sidebar"]','[class*="sidebar"]','nav[class]'];
					for(var i=0; i<sel.length; i++){
						var e = document.querySelector(sel[i]);
						if(e){ var r = e.getBoundingClientRect(); if(r.left===0 && r.width>0 && r.width<200){ navLeft = Math.round(r.right); break; } }
					}
					var ov = document.createElement('div');
					ov.id = 'wco';
					ov.style.cssText = 'position:fixed;top:0;left:'+navLeft+'px;right:0;bottom:0;z-index:40;'
						+'background:rgba(20,42,65,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;'
						+'text-align:center;padding:24px;font-family:sans-serif;color:#fff;';
					ov.innerHTML = '<div style="font-size:3em;margin-bottom:14px">&#128274;</div>'
						+'<h2 style="font-size:1.2em;font-weight:700;margin:0 0 8px">Caisse fermée</h2>'
						+'<p style="font-size:.9em;opacity:.8;max-width:340px;line-height:1.5;margin:0 0 20px">'
						+(msg||'La caisse est fermée. Veuillez l\\'ouvrir avant de continuer.')+'</p>';
					document.body.appendChild(ov);
					console.log('[overlay] caissier');
				}

				function hideCaissierOverlay(){ var ov = document.getElementById('wco'); if(ov) ov.remove(); }

				var KNOWN_LABELS = ['pos','produits','commandes','clients','rapports','journaux','support',
					'en stock','en vedette','en solde','catégorie','étiquette','marque',
					'usmm','voir la démo','passer à pro','wcpos',
					'pos - usm malakoff tir sportif','version 1.8.11'];

				function getUserFromDOM(){
					var els = document.querySelectorAll('[class*="whitespace-nowrap"]');
					for(var i=0; i<els.length; i++){
						var el = els[i], txt = (el.textContent||'').trim();
						var cls = el.className || '';
						var isLeaf = el.children.length===0;
						var hasTextBase = cls.indexOf('text-base') > -1;
						var matchesPattern = txt.length>=2 && txt.length<=40 && /^[a-zA-ZÀ-ÿ]/.test(txt);
						if(isLeaf && matchesPattern && hasTextBase && KNOWN_LABELS.indexOf(txt.toLowerCase())===-1){
							return txt.toLowerCase();
						}
					}
					for(var i=0; i<els.length; i++){
						var el = els[i], txt = (el.textContent||'').trim();
						var isLeaf = el.children.length===0;
						var matchesPattern = txt.length>=2 && txt.length<=40 && /^[a-zA-ZÀ-ÿ]/.test(txt);
						if(isLeaf && matchesPattern && KNOWN_LABELS.indexOf(txt.toLowerCase())===-1){
							return txt.toLowerCase();
						}
					}
					return '';
				}

				function initAuth(callback){
					var cached = sessionStorage.getItem('wcpos_can_edit');
					if(cached === 'true'){ console.log('[auth] sessionStorage can_edit=true'); callback(true); return; }
					var domLogin = getUserFromDOM();
					if(domLogin){
						console.log('[auth] domLogin =', domLogin);
						rp('/whoami', {client_login: domLogin}, function(usr){
							if(usr && usr.can_edit===true){ sessionStorage.setItem('wcpos_can_edit', 'true'); callback(true); }
							else { startPolling(callback); }
						});
					} else { startPolling(callback); }
				}

				function startPolling(callback){
					var tries = 0, maxTries = 20;
					console.log('[auth] polling DOM...');
					var poll = setInterval(function(){
						tries++;
						var dl = getUserFromDOM();
						if(dl){
							console.log('[auth] polling trouvé =', dl, '(tentative '+tries+')');
							rp('/whoami', {client_login: dl}, function(usr){
								if(usr && usr.can_edit===true){ clearInterval(poll); sessionStorage.setItem('wcpos_can_edit', 'true'); callback(true); }
							});
						}
						if(tries >= maxTries){ clearInterval(poll); console.log('[auth] timeout, can_edit=false'); callback(false); }
					}, 500);
				}

				window.__loadPanel=function(pid,wrap,cv,force){
					if(window.__loadingPanel&&!force)return;
					window.__loadingPanel=true;
					wrap.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement\\u2026</p>';
					rp('/panel',cv?{panel_id:pid,caisse_view:cv}:{panel_id:pid},function(d){
						window.__loadingPanel=false;
						if(!d||!d.html){ wrap.innerHTML='<p style="padding:20px;color:#c00">'+(d&&d.error?d.error:'Erreur')+'</p>'; return; }
						wrap.innerHTML=d.html;
						wrap.querySelectorAll('script').forEach(function(s){ var ns=document.createElement('script');ns.textContent=s.textContent;s.parentNode.replaceChild(ns,s); });
					});
				};

				function navToClients(){ console.log('[wcpos-nav-to] customers'); }
				function inPOS(){ return !!document.querySelector('[data-testid="search-products"]'); }
				function currentTab(){ var u=window.location.href.toLowerCase(); var tabs=['products','orders','customers','reports']; for(var i=0;i<tabs.length;i++){if(u.indexOf(tabs[i])!==-1)return tabs[i];} return null; }

				/* v5.0.1 : chkCaisse exposée globalement + guard anti-empilement */
				window.chkCaisse = function chkCaisse(){
					if(window._chkBusy) return;
					if(!inPOS()) return;
					window._chkBusy = true;

					var currentUser = getUserFromDOM();
					var storedUser = sessionStorage.getItem('wcpos_user');
					if(currentUser && storedUser && currentUser !== storedUser){
						console.log('[auth] utilisateur changé :', storedUser, '→', currentUser);
						sessionStorage.removeItem('wcpos_can_edit');
						sessionStorage.setItem('wcpos_user', currentUser);
						hideAdminToast();
						hideCaissierOverlay();
						isAdmin = false;
						initAuth(function(result){ isAdmin = result; console.log('[auth] nouvelle auth: isAdmin=' + isAdmin); window._chkBusy = false; });
						return;
					}
					if(currentUser && !storedUser){ sessionStorage.setItem('wcpos_user', currentUser); }

					rp('/caisse/status',{},function(d){
						if(!d||d.error){ window._chkBusy = false; return; }
						var tab = currentTab();
						var isPosTab = (POS_TABS.indexOf(tab) !== -1 || tab===null);
						console.log('[caisse] open='+d.open+' tab='+tab+' isAdmin='+isAdmin);

						if(isAdmin){
							hideCaissierOverlay();
							if(!d.open) showAdminToast('\\uD83D\\uDD12 Caisse ferm\\u00e9e \\u2013 mode administrateur', 'admin_closed');
							else showAdminToast('\\uD83D\\uDD13 Caisse ouverte \\u2013 mode administrateur', 'admin_open');
						} else if(isPosTab){
							hideAdminToast();
							if(!d.open) showCaissierOverlay(d.message);
							else hideCaissierOverlay();
						} else {
							// v5.0.0 : masquer l'overlay sur les onglets non-POS
							hideCaissierOverlay();
						}
						window._chkBusy = false;
					});
				};

				initAuth(function(result){ isAdmin = result; console.log('[auth] résultat final: isAdmin=' + isAdmin); window.chkCaisse(); });
				setInterval(function(){ window.chkCaisse(); }, 30000);
				console.log('[setup] OK');
			}catch(e){console.error('[setup] EXCEPTION',e.message,e.stack);}
		})();`).catch((e: Error) => log.error('[setup] '+e.message));
	}

	/**
	 * v5.0.1 : Demande au renderer d'exécuter chkCaisse() immédiatement.
	 * Appelé après chaque navigation pour éviter la persistance de l'overlay
	 * jusqu'au prochain cycle setInterval de 30s.
	 */
	function triggerChkCaisse(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.executeJavaScript(`
			(function(){
				if(window.chkCaisse) window.chkCaisse();
			})();
		`).catch(() => {});
	}

	/* ════════════════════════════════════════════════════════════════════════
	   BLOC 3 — Panel
	   ════════════════════════════════════════════════════════════════════════ */
	function runPanelForTab(tab: string | null): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (!tab) {
			mainWindow.webContents.executeJavaScript(`(function(){
				document.querySelectorAll('[id^="wpp-"]').forEach(function(el){ el.style.display = 'none'; });
				console.log('[panel] tous cachés');
			})();`).catch(() => {});
			return;
		}
		log.info(`[panel] → ${tab}`);
		mainWindow.webContents.executeJavaScript(`(function(){
			try{
				var tab=${JSON.stringify(tab)};
				if(!document.querySelector('[data-testid="search-products"]')){ console.log('[panel] hors POS'); return; }
				if(!window.__setup){ console.log('[panel] setup absent'); return; }
				var wppId='wpp-'+tab, wpp=document.getElementById(wppId);
				if(wpp && wpp.innerHTML.length > 100){
					document.querySelectorAll('[id^="wpp-"]').forEach(function(el){ el.style.display = 'none'; });
					wpp.style.display = ''; console.log('[panel] affiche '+tab+' (cache)'); return;
				}
				var proContainer=null;
				var allLeafs=document.querySelectorAll('*');
				for(var i=0; i<allLeafs.length; i++){
					var el=allLeafs[i];
					if(el.children.length===0 && (el.textContent||'').trim().indexOf('WooCommerce POS Pro') > -1){
						var c=el.parentElement?.parentElement?.parentElement;
						var cr=c?.getBoundingClientRect();
						if(cr && cr.width > 0){ proContainer=c; break; }
					}
				}
				if(!proContainer){ console.log('[panel] conteneur Pro introuvable'); return; }
				var r=proContainer.getBoundingClientRect();
				console.log('[panel] conteneur flex-1 '+tab+': '+Math.round(r.width)+'x'+Math.round(r.height));
				for(var j=0; j<proContainer.children.length; j++){
					if(!proContainer.children[j].id.startsWith('wpp-')){ proContainer.children[j].style.display = 'none'; }
				}
				proContainer.style.minHeight='400px'; proContainer.style.overflow='visible'; proContainer.style.position='relative';
				var p=proContainer.parentElement;
				while(p && p!==document.body){
					if(window.getComputedStyle(p).overflow==='hidden'){ p.style.overflow='visible'; }
					p=p.parentElement;
				}
				document.querySelectorAll('[id^="wpp-"]').forEach(function(el){ el.style.display = 'none'; });
				if(!wpp){ wpp=document.createElement('div'); wpp.id=wppId; proContainer.appendChild(wpp); }
				wpp.style.cssText='position:absolute;top:0;left:0;right:0;bottom:0;min-height:400px;background:#f0f0f1;overflow-y:auto;box-sizing:border-box;z-index:10;';
				window.__loadPanel(tab, wpp, null, true);
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
		runAntiPro(); runSetup();
		// v5.0.1 : mise à jour immédiate de l'overlay après navigation
		triggerChkCaisse();
		if (tab !== lastTab) { lastTab = tab; setTimeout(() => runPanelForTab(tab), 400); }
	}
	mainWindow.webContents.on('dom-ready', () => { mainWindow?.setTitle(APP_VERSION); log.info('[dom-ready]'); onNavigate('dom-ready'); });
	mainWindow.webContents.on('did-navigate', (_e, url) => { log.info(`[did-navigate] ${url}`); lastTab = null; onNavigate('did-navigate', url); });
	mainWindow.webContents.on('did-navigate-in-page', (_e, url) => { log.info(`[did-navigate-in-page] ${url}`); onNavigate('did-navigate-in-page', url); });
	let pollCount = 0;
	const pollTimer = setInterval(() => {
		if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
		const url = mainWindow.webContents.getURL(); const tab = tabFromUrl(url);
		log.info(`[poll ${pollCount+1}/10] url=${url} tab=${tab}`);
		runAntiPro(); runSetup();
		// v5.0.1 : mise à jour immédiate de l'overlay pendant la phase de polling
		triggerChkCaisse();
		if (tab && tab !== lastTab) { lastTab = tab; setTimeout(() => runPanelForTab(tab), 400); }
		if (++pollCount >= 10) clearInterval(pollTimer);
	}, 2000);
	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) throw new Error('"mainWindow" is not defined');
		if (process.env.START_MINIMIZED) { mainWindow.minimize(); mainWindow.show(); }
		else { mainWindow.maximize(); mainWindow.show(); setTimeout(() => { lastTab = null; onNavigate('ready-maximized'); }, 800); }
	});
	mainWindow.on('closed', () => { mainWindow = null; });
	mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
	let retryCount = 0;
	mainWindow.webContents.on('did-fail-load', async (_e, _code, desc) => {
		log.error(`[did-fail-load] ${desc}`);
		if (desc === 'ERR_CONNECTION_REFUSED') { if (retryCount >= 30) return; retryCount++; setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000); }
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
