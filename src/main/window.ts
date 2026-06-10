import * as path from 'path';
import { BrowserWindow, shell, Menu } from 'electron';
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

const APP_VERSION  = 'POSTir 5.2.4';
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
		show: false,
		width: 1406,
		height: 974,
		resizable: false,
		maximizable: false,
		minimizable: true,
		fullscreenable: false,
		title: APP_VERSION,
		icon: path.join(__dirname, '../../icons/icon.ico'),
		autoHideMenuBar: true,
		webPreferences: {
			preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
			sandbox: false,
			nodeIntegration: false,
			contextIsolation: true,
			devTools: true,
			webSecurity: false, // v5.2.4 : autorise postMessage cross-origin wcpos://-→usmm-tir.fr (iframe paiement)
		},
		backgroundColor: '#fff',
	});

	mainWindow.setMenu(null);

	mainWindow.webContents.on('before-input-event', (event, input) => {
		if (input.control && input.shift && input.key.toLowerCase() === 'i') {
			mainWindow?.webContents.toggleDevTools();
			event.preventDefault();
		}
	});

	/* ── Logging renderer ────────────────────────────────────────────────── */
	mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
		const short = (src ?? '').split('/').pop() ?? '';
		const tag   = `[R ${short}:${line}]`;
		if (message.includes('Novu') || message.includes('novu') || message.includes('notifications.wcpos')) {
			return;
		}
		if      (level === 3) log.error(`${tag} ${message}`);
		else if (level === 2) log.warn (`${tag} ${message}`);
		else                  log.info (`${tag} ${message}`);
		if (message.startsWith('[resize] recalcul pid=')) {
			const pid = message.replace('[resize] recalcul pid=', '').trim();
			setTimeout(() => runPanelForTab(pid || lastTab), 400);
		}
		if (message.startsWith('[wcpos-nav-to] ')) {
			const target = message.replace('[wcpos-nav-to] ', '').trim();
			log.info(`[nav-to] \u2192 ${target}`);
			if (!mainWindow || mainWindow.isDestroyed()) return;
			try {
				const cur = mainWindow.webContents.getURL();
				const parsed = new URL(cur);
				const segs = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
				if (segs.length > 0) segs[segs.length - 1] = target;
				else segs.push(target);
				const newUrl = parsed.origin + '/' + segs.join('/');
				log.info(`[nav-to] ${cur} \u2192 ${newUrl}`);
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
		{ urls: [
			'*://*.novu.co/*','*://novu.co/*',
			'*://updates.wcpos.com/*',
			'*://wcpos.com/*','*://*.wcpos.com/*',
			'*://api.github.com/repos/wcpos/*',
			'*://*.widgetbot.io/*',
			'*://widgetbot.io/*',
			'*://via.placeholder.com/*',
			'*://api.notifications.wcpos.com/*',
		] },
		(_d, cb) => cb({ cancel: true })
	);

	/* ── v5.2.2 : onBeforeSendHeaders exclut wcpos-checkout ─────────────── *
	 * L'iframe de paiement charge wcpos-checkout/order-pay/* et attend un   *
	 * postMessage de l'app React. Injecter Origin:wcpos:/- sur ces requêtes *
	 * casse la communication cross-frame → No postMessage received → PY02001 */
	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => {
			// Ne pas modifier les requêtes vers wcpos-checkout (iframe paiement)
			if (d.url.includes('/wcpos-checkout/')) {
				cb({ requestHeaders: d.requestHeaders });
				return;
			}
			cb({ requestHeaders: { ...d.requestHeaders, Origin: 'wcpos://-' } });
		}
	);

	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => {
			/* v5.2.3 : wcpos-checkout a besoin de CORS pour que l'app React
			 * puisse accéder à contentWindow de l'iframe et envoyer postMessage */
			if (d.url.includes('/wcpos-checkout/')) {
				const hc: Record<string,string[]> = { ...(d.responseHeaders ?? {}) as Record<string,string[]> };
				hc['Access-Control-Allow-Origin']      = ['wcpos://-'];
				hc['Access-Control-Allow-Credentials'] = ['true'];
				cb({ responseHeaders: hc });
				return;
			}
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

	/* ═══════════════════════════════════════════════════════════════════════
	   BLOC 1 — Anti-pub + Masquages permanents
	   ═══════════════════════════════════════════════════════════════════════ */
	function runAntiPro(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const HIDE = ['upgrade-notice-banner','upgrade-title','upgrade-to-pro-button',
              'view-demo-button','add-fee','add-shipping','add-misc-product',
              'order-note-button','order-meta-button','save-to-server-button',
              'cart-customer-name'];
		const css = HIDE.map(t => `[data-testid='${t}']`).join(',')
			+ `,[aria-label='Notifications'],[aria-label='Open notification center']{display:none!important}`;
		mainWindow.webContents.executeJavaScript(`(function(){
			if(window.__ap||!document||!document.documentElement)return;
			try{
				window.__ap=true;
				var s=document.createElement('style');s.id='wcpos-ap';
				s.textContent=${JSON.stringify(css)};
				(document.head||document.documentElement).appendChild(s);

				var apObserver = new MutationObserver(function(mutations) {
					mutations.forEach(function(m) {
						m.addedNodes.forEach(function(node) {
							if (node.nodeType === 1) {
								var popovers = node.querySelectorAll ? node.querySelectorAll('[class*="text-popover-foreground"]') : [];
								popovers.forEach(function(el) {
									if (el.textContent === 'Clients') {
										el.textContent = 'Caisse';
									}
								});
								if (node.textContent === 'Clients' && node.className && node.className.indexOf('text-popover-foreground') > -1) {
									node.textContent = 'Caisse';
								}
							}
						});
					});
					document.querySelectorAll('[class*="text-sidebar-foreground"], [class*="text-sidebar"] *, [class*="Sidebar"] *').forEach(function(el) {
						if (el.children.length === 0 && el.textContent.includes('Clients')) {
							el.textContent = el.textContent.replace('Clients', 'Caisse');
						}
					});
				});
				apObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

				function hideClientHeader(){
					var all = document.querySelectorAll('.css-146c3p1');
					all.forEach(function(el){
						if(el.textContent.trim() === 'Client:'){
							var header = el.parentElement?.parentElement?.parentElement;
							if(header && header.style.display !== 'none'){
								header.style.setProperty('display', 'none', 'important');
							}
						}
					});
				}

				function hideFilterButton(){
					var filterPaths = document.querySelectorAll('svg path[d*="M0 416c0 17.7"]');
					filterPaths.forEach(function(path){
						var btn = path.closest('button');
						if(btn && btn.style.display !== 'none'){
							btn.style.setProperty('display', 'none', 'important');
						}
					});
				}

				function hideDemoButton(){
					var allButtons = document.querySelectorAll('button');
					allButtons.forEach(function(btn){
						if(btn.textContent.trim() === 'Entrer dans le magasin de d\u00e9monstration'){
							btn.style.setProperty('display', 'none', 'important');
						}
					});
				}

				hideClientHeader();
				hideFilterButton();
				hideDemoButton();

				var permanentObserver = new MutationObserver(function(){
					hideClientHeader();
					hideFilterButton();
					hideDemoButton();
				});
				permanentObserver.observe(document.body, { childList: true, subtree: true });

				setTimeout(hideClientHeader, 1000);
				setTimeout(hideClientHeader, 3000);
				setTimeout(hideFilterButton, 1000);
				setTimeout(hideFilterButton, 3000);
				setTimeout(hideDemoButton, 1000);
				setTimeout(hideDemoButton, 3000);
			}catch(e){console.error(e.message);}
		})();`).catch((e: Error) => log.error('[ap] '+e.message));
	}

	/* ═══════════════════════════════════════════════════════════════════════
	   BLOC 2 — Setup caisse v5.2.2
	   ═══════════════════════════════════════════════════════════════════════ */
	function runSetup(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.executeJavaScript(`(function(){
			if(window.__setup||!document||!document.body)return;
			try{
				if(!document.querySelector('[data-testid="search-products"]')){
					return;
				}
				window.__setup=true;

				var REST=${JSON.stringify(WP_REST_BASE)};
				var isAdmin = false;
				var CAISSE_TAB_INDEX = 3;

				function rp(ep,data,cb){
					fetch(REST+ep,{method:'POST',headers:{'Content-Type':'application/json'},
						body:JSON.stringify(data),credentials:'include'})
						.then(function(r){return r.json();}).then(cb)
						.catch(function(e){console.error(e.message);cb({error:e.message});});
				}

				function getNavLeft(){
					var navLeft = 50;
					var sel = ['[class*="TabBar"]','[class*="Sidebar"]','[class*="sidebar"]','nav[class]'];
					for(var i=0; i<sel.length; i++){
						var e = document.querySelector(sel[i]);
						if(e){ var r = e.getBoundingClientRect(); if(r.left===0 && r.width>0 && r.width<200){ navLeft = Math.round(r.right); break; } }
					}
					return navLeft;
				}

				function getCaisseTabRect(){
					var tabs = document.querySelectorAll('.css-g5y9jx.web\\\\:whitespace-nowrap.web\\\\:transition-colors.truncate.text-xl.web\\\\:pointer-events-none.inset-0.content-center.items-center');
					if (tabs.length >= 4) {
						var btn = tabs[3].closest('button, a');
						return btn ? btn.getBoundingClientRect() : null;
					}
					return null;
				}

				function createOverlay(){
					var ov = document.getElementById('wcpos-caisse-overlay');
					if (ov) return ov;

					var caisseRect = getCaisseTabRect();
					var arrowTop = caisseRect ? (caisseRect.top + caisseRect.height/2 - 8) : 147;
					var arrowLeft = caisseRect ? (caisseRect.right + 8) : 70;

					ov = document.createElement('div');
					ov.id = 'wcpos-caisse-overlay';
					ov.style.cssText = 'position:fixed;top:0;bottom:0;z-index:999999;background:linear-gradient(180deg, #0f1a2e 0%, #1a2d4a 100%);display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;font-family:-apple-system,sans-serif;color:#fff;';
					ov.innerHTML = ''
						+ '<div id="caisse-arrow" style="position:fixed;left:' + arrowLeft + 'px;top:' + arrowTop + 'px;display:flex;align-items:center;gap:6px;animation:caissePulse 1.5s ease-in-out infinite">'
						+ '<svg width="16" height="16" viewBox="0 0 16 16" fill="white" style="opacity:0.8;transform:rotate(180deg)"><path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06z"/></svg>'
						+ '<span style="background:rgba(255,255,255,.15);color:#fff;padding:4px 10px;border-radius:6px;font-size:.7em;font-weight:600;white-space:nowrap">Caisse</span>'
						+ '</div>'
						+ '<style>@keyframes caissePulse{0%,100%{opacity:1;transform:translateX(0)}50%{opacity:.4;transform:translateX(-4px)}}</style>'
						+ '<div style="margin-bottom:40px">'
						+ '<div style="width:80px;height:80px;background:rgba(255,255,255,.03);border:2px solid rgba(255,255,255,.08);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 28px;font-size:2em">\u{1F512}</div>'
						+ '<h2 style="font-size:1.6em;font-weight:300;letter-spacing:2px;margin:0 0 8px;text-transform:uppercase">Caisse ferm\u00e9e</h2>'
						+ '<p style="font-size:.85em;color:rgba(255,255,255,.35);max-width:320px;line-height:1.8;margin:0">S\u00e9lectionnez l\u2019onglet <span style="color:rgba(255,255,255,.6);font-weight:500">Caisse</span> pour ouvrir une session.</p>'
						+ '</div>'
						+ '<div style="position:absolute;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg, transparent, rgba(255,255,255,.1), transparent)"></div>';
					document.body.appendChild(ov);
					return ov;
				}

				var overlayEl = createOverlay();

				function showCaissierOverlay(){
					if (!overlayEl) overlayEl = createOverlay();
					if (!overlayEl) return;
					var navLeft = getNavLeft();
					overlayEl.style.left = navLeft + 'px';
					overlayEl.style.right = '0';
					overlayEl.style.display = 'flex';
				}

				function hideCaissierOverlay(){
					if (overlayEl) overlayEl.style.display = 'none';
				}

				function createAdminToast(){
					var toast = document.getElementById('wcpos-admin-toast');
					if (!toast) {
						toast = document.createElement('div');
						toast.id = 'wcpos-admin-toast';
						toast.style.cssText = 'position:fixed;top:80px;left:75%;transform:translateX(-50%);z-index:999999;display:none;font-family:-apple-system,sans-serif;';
						document.body.appendChild(toast);
					}
					return toast;
				}

				var adminToastEl = createAdminToast();

				function showAdminToast(msg, type){
					if (!adminToastEl) adminToastEl = createAdminToast();
					if (!adminToastEl) return;
					var bg = (type === 'admin_open') ? 'rgba(0,163,42,.85)' : 'rgba(214,54,56,.85)';
					var icon = (type === 'admin_open') ? '\u{1F513}' : '\u{1F512}';
					adminToastEl.innerHTML = ''
						+ '<div style="background:' + bg + ';border-radius:8px;padding:10px 18px;display:flex;align-items:center;gap:10px;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.4)">'
						+ '<span style="font-size:1.2em">' + icon + '</span>'
						+ '<span style="font-size:.8em;font-weight:600;white-space:nowrap">' + msg + '</span>'
						+ '</div>';
					adminToastEl.style.display = 'block';
				}

				function hideAdminToast(){
					if (adminToastEl) adminToastEl.style.display = 'none';
				}

				function getSidebarTabs(){
					return document.querySelectorAll('.css-g5y9jx.web\\\\:whitespace-nowrap.web\\\\:transition-colors.truncate.text-xl.web\\\\:pointer-events-none.inset-0.content-center.items-center');
				}

				function blockSidebarTabs(){
					var tabs = getSidebarTabs();
					tabs.forEach(function(icon, i) {
						var btn = icon.closest('button, a');
						if (!btn) return;
						if (i !== CAISSE_TAB_INDEX) {
							btn.style.pointerEvents = 'none';
							btn.style.opacity = '0.4';
						} else {
							btn.style.pointerEvents = '';
							btn.style.opacity = '';
						}
					});
				}

				function unblockAllTabs(){
					var tabs = getSidebarTabs();
					tabs.forEach(function(icon) {
						var btn = icon.closest('button, a');
						if (btn) { btn.style.pointerEvents = ''; btn.style.opacity = ''; }
					});
				}

				function updateCaisseUI(){
					var url = window.location.href.toLowerCase();
					var isCaisseTab = (url.indexOf('customers') !== -1);

					if (isAdmin) {
						hideCaissierOverlay();
						unblockAllTabs();
					} else {
						hideAdminToast();
						if (!window.CAISSE_OPEN) {
							blockSidebarTabs();
							if (isCaisseTab) {
								hideCaissierOverlay();
							} else {
								showCaissierOverlay();
							}
						} else {
							hideCaissierOverlay();
							unblockAllTabs();
						}
					}
				}

				var KNOWN_LABELS = ['pos','produits','commandes','clients','rapports','journaux','support',
					'en stock','en vedette','en solde','cat\u00e9gorie','\u00e9tiquette','marque',
					'usmm','voir la d\u00e9mo','passer \u00e0 pro','wcpos',
					'pos - usm malakoff tir sportif','version 1.8.11','version 1.8.14'];

				function getUserFromDOM(){
					var els = document.querySelectorAll('[class*="whitespace-nowrap"]');
					for(var i=0; i<els.length; i++){
						var el = els[i], txt = (el.textContent||'').trim();
						var cls = el.className || '';
						var isLeaf = el.children.length===0;
						var hasTextBase = cls.indexOf('text-base') > -1;
						var matchesPattern = txt.length>=2 && txt.length<=40 && /^[a-zA-Z\u00c0-\u00ff]/.test(txt);
						if(isLeaf && matchesPattern && hasTextBase && KNOWN_LABELS.indexOf(txt.toLowerCase())===-1){
							return txt.toLowerCase();
						}
					}
					for(var i=0; i<els.length; i++){
						var el = els[i], txt = (el.textContent||'').trim();
						var isLeaf = el.children.length===0;
						var matchesPattern = txt.length>=2 && txt.length<=40 && /^[a-zA-Z\u00c0-\u00ff]/.test(txt);
						if(isLeaf && matchesPattern && KNOWN_LABELS.indexOf(txt.toLowerCase())===-1){
							return txt.toLowerCase();
						}
					}
					return '';
				}

				function initAuth(callback){
					var cached = sessionStorage.getItem('wcpos_can_edit');
					if(cached === 'true'){ callback(true); return; }
					if(cached === 'false'){ callback(false); return; }
					var domLogin = getUserFromDOM();
					if(domLogin){
						rp('/whoami', {client_login: domLogin}, function(usr){
							if(usr && usr.can_edit===true){
								sessionStorage.setItem('wcpos_can_edit', 'true');
								callback(true);
							} else {
								sessionStorage.setItem('wcpos_can_edit', 'false');
								callback(false);
							}
						});
					} else {
						setTimeout(function(){
							var dl = getUserFromDOM();
							if(dl){
								rp('/whoami', {client_login: dl}, function(usr){
									if(usr && usr.can_edit===true){
										sessionStorage.setItem('wcpos_can_edit', 'true');
										callback(true);
									} else {
										sessionStorage.setItem('wcpos_can_edit', 'false');
										callback(false);
									}
								});
							} else {
								callback(false);
							}
						}, 1000);
					}
				}

				window.__loadPanel=function(pid,wrap,cv,force){
					if(window.__loadingPanel&&!force)return;
					window.__loadingPanel=true;
					wrap.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement\u2026</p>';
					rp('/panel',cv?{panel_id:pid,caisse_view:cv}:{panel_id:pid},function(d){
						window.__loadingPanel=false;
						if(!d||!d.html){ wrap.innerHTML='<p style="padding:20px;color:#c00">'+(d&&d.error?d.error:'Erreur')+'</p>'; return; }
						wrap.innerHTML=d.html;
						wrap.querySelectorAll('script').forEach(function(s){ var ns=document.createElement('script');ns.textContent=s.textContent;s.parentNode.replaceChild(ns,s); });
					});
				};

				function inPOS(){ return !!document.querySelector('[data-testid="search-products"]'); }
				window.inPOS = inPOS;

				function currentTab(){ var u=window.location.href.toLowerCase(); var tabs=['products','orders','customers','reports']; for(var i=0;i<tabs.length;i++){if(u.indexOf(tabs[i])!==-1)return tabs[i];} return null; }
				window.currentTab = currentTab;

				window.chkCaisse = function chkCaisse(){
					if(window._chkBusy) return;
					if(!inPOS()) return;
					window._chkBusy = true;

					var currentUser = getUserFromDOM();
					var storedUser = sessionStorage.getItem('wcpos_user');
					if(currentUser && storedUser && currentUser !== storedUser){
						sessionStorage.removeItem('wcpos_can_edit');
						sessionStorage.setItem('wcpos_user', currentUser);
						hideAdminToast();
						hideCaissierOverlay();
						unblockAllTabs();
						isAdmin = false;
						showCaissierOverlay();
						initAuth(function(result){
							isAdmin = result;
							window._chkBusy = false;
							window.chkCaisse();
						});
						return;
					}
					if(currentUser && !storedUser){ sessionStorage.setItem('wcpos_user', currentUser); }

					rp('/caisse/status',{},function(d){
						if(!d||d.error){ window._chkBusy = false; return; }
						window.CAISSE_OPEN = !!(d && d.open);

						if(isAdmin){
							if(!window.CAISSE_OPEN) showAdminToast('Caisse ferm\u00e9e \u2014 mode administrateur', 'admin_closed');
							else showAdminToast('Caisse ouverte \u2014 mode administrateur', 'admin_open');
						} else {
							hideAdminToast();
						}
						updateCaisseUI();
						window._chkBusy = false;
					});
				};

				showCaissierOverlay();
				blockSidebarTabs();

				initAuth(function(result){
					isAdmin = result;
					window.chkCaisse();
				});

				// ═══════════════════════════════════════════════════════════════
				// ADMIN CREDENTIALS CLEANUP
				// ═══════════════════════════════════════════════════════════════
				var ADMIN_CREDENTIALS_UUID = '3de16a8f-d876-4a95-8a63-421b302c354c';
				var CAISSIER_CREDENTIALS_UUID = '54d06a09-02d0-4515-9888-b1db9c09279a';

				function clearAdminCredentials() {
					try {
						var request = indexedDB.open('rxdbwcposusers_v2');
						request.onsuccess = function(e) {
							var db = e.target.result;
							if (!db.objectStoreNames.contains('wp_credentials-1')) {
								db.close(); return;
							}
							var tx = db.transaction('wp_credentials-1', 'readwrite');
							var store = tx.objectStore('wp_credentials-1');
							var deleteRequest = store.delete(ADMIN_CREDENTIALS_UUID);
							deleteRequest.onsuccess = function() {
								console.log('[admin-cleanup] Credentials admin supprimés');
							};
							tx.oncomplete = function() { db.close(); };
							tx.onerror = function() { db.close(); };
						};
						request.onerror = function() {};
					} catch(e) {}
				}

				function checkAndCleanAdmin(username) {
					var ADMIN_USERNAMES = ['ilyes'];
					if (ADMIN_USERNAMES.includes(username.toLowerCase())) {
						setTimeout(function() { clearAdminCredentials(); }, 500);
					}
				}

				var lastKnownUser = sessionStorage.getItem('wcpos_user');
				setInterval(function() {
					var currentUser = sessionStorage.getItem('wcpos_user');
					if (currentUser && currentUser !== lastKnownUser) {
						if (!currentUser) { checkAndCleanAdmin(lastKnownUser); }
						lastKnownUser = currentUser;
					}
				}, 1000);

				setInterval(function(){ window.chkCaisse(); }, 30000);

				document.addEventListener('click', function(e){
					var tabs = getSidebarTabs();
					var isNav = false;
					tabs.forEach(function(icon){ if(icon.closest('button, a') === e.target.closest('button, a')) isNav = true; });
					if (isNav) setTimeout(updateCaisseUI, 300);
				});

			}catch(e){console.error(e.message);}
		})();`).catch((e: Error) => log.error('[setup] '+e.message));
	}

	function triggerChkCaisse(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.executeJavaScript(`
			(function(){
				if(window.chkCaisse) window.chkCaisse();
			})();
		`).catch(() => {});
	}

	/* ═══════════════════════════════════════════════════════════════════════
	   BLOC 3 — Panel
	   ═══════════════════════════════════════════════════════════════════════ */
	function runPanelForTab(tab: string | null): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (!tab) {
			mainWindow.webContents.executeJavaScript(`(function(){
				document.querySelectorAll('[id^="wpp-"]').forEach(function(el){ el.style.display = 'none'; });
			})();`).catch(() => {});
			return;
		}
		log.info(`[panel] \u2192 ${tab}`);
		mainWindow.webContents.executeJavaScript(`(function(){
			try{
				var tab=${JSON.stringify(tab)};
				if(!document.querySelector('[data-testid="search-products"]')){ return; }
				if(!window.__setup){ return; }
				var wppId='wpp-'+tab, wpp=document.getElementById(wppId);
				if(wpp && wpp.innerHTML.length > 100){
					document.querySelectorAll('[id^="wpp-"]').forEach(function(el){ el.style.display = 'none'; });
					wpp.style.display = ''; return;
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
				if(!proContainer){ return; }
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
			}catch(e){}
		})();`).catch((e: Error) => log.error(`[panel] ${e.message}`));
	}

	/* ── Orchestration ─────────────────────────────────────────────────── */
	let lastTab: string | null = null;
	function onNavigate(label: string, url?: string): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const currentUrl = url ?? mainWindow.webContents.getURL();
		const tab = tabFromUrl(currentUrl);
		log.info(`[${label}] url=${currentUrl} tab=${tab}`);
		runAntiPro(); runSetup();
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
		triggerChkCaisse();
		if (tab && tab !== lastTab) { lastTab = tab; setTimeout(() => runPanelForTab(tab), 400); }
		if (++pollCount >= 10) clearInterval(pollTimer);
	}, 2000);
	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) throw new Error('"mainWindow" is not defined');
		if (process.env.START_MINIMIZED) {
			mainWindow.minimize();
			mainWindow.show();
		} else {
			mainWindow.maximize();
			mainWindow.show();
			setTimeout(() => { lastTab = null; onNavigate('ready-maximized'); }, 800);
		}
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
