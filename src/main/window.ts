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

const APP_VERSION  = 'WCPOS Custom 4.1';
const WP_SITE_URL  = 'https://usmm-tir.fr';
const WP_REST_BASE = 'https://usmm-tir.fr/wp-json/wcpos-custom/v1';

/* ── Détection d'onglet depuis l'URL ──────────────────────────────────────
   WCPOS Electron : wcpos://-/pos/<registerId>/<tab>
   On extrait le dernier segment de chemin non vide.
   ────────────────────────────────────────────────────────────────────────  */
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

	/* ════════════════════════════════════════════════════════════════════════
	   LOGGING RENDERER → main.log
	   console-message capture TOUTE la console renderer sans modifier preload.
	   Niveaux Chromium : 0=verbose 1=info 2=warning 3=error
	   ════════════════════════════════════════════════════════════════════════ */
	mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
		const short = (src ?? '').split('/').pop() ?? '';
		const tag   = `[R ${short}:${line}]`;
		if      (level === 3) log.error(`${tag} ${message}`);
		else if (level === 2) log.warn (`${tag} ${message}`);
		else                  log.info (`${tag} ${message}`);
		/* Recalcul du panel après resize : le renderer log '[resize] recalcul pid=...'
		   → on récupère le pid et on re-injecte le panel (v3.9) */
		if (message.startsWith('[resize] recalcul pid=')) {
			const pid = message.replace('[resize] recalcul pid=', '').trim();
			log.info(`[resize] re-injection pour tab=${pid}`);
			setTimeout(() => runPanelForTab(pid || lastTab), 400);
		}
	});

	/* Santé renderer */
	mainWindow.webContents.on('render-process-gone', (_e, d) =>
		log.error(`[renderer-gone] reason=${d.reason} exit=${d.exitCode}`));
	mainWindow.webContents.on('unresponsive', () => log.error('[renderer] UNRESPONSIVE'));
	mainWindow.webContents.on('responsive',   () => log.info ('[renderer] responsive'));

	/* ── Blocage connexions externes ─────────────────────────────────────── */
	mainWindow.webContents.session.webRequest.onBeforeRequest(
		{ urls: ['*://*.novu.co/*','*://novu.co/*','*://updates.wcpos.com/*',
		         '*://wcpos.com/*','*://*.wcpos.com/*','*://api.github.com/repos/wcpos/*'] },
		(_d, cb) => cb({ cancel: true })
	);
	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => { cb({ requestHeaders: { ...d.requestHeaders, Origin: 'wcpos://-' } }); }
	);
	mainWindow.webContents.session.webRequest.onHeadersReceived(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => {
			const h: Record<string,string[]> = {};
			for (const [k,v] of Object.entries(d.responseHeaders ?? {})) {
				if (!['access-control-allow-origin','access-control-allow-credentials',
				      'access-control-allow-methods','access-control-allow-headers',
				      'x-content-type-options'].includes(k.toLowerCase())) h[k] = v as string[];
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
	   BLOC 1 — Anti-pub : CSS statique injecté une seule fois.
	   Aucun MO, aucun setInterval. La feuille CSS reste active en permanence.
	   ════════════════════════════════════════════════════════════════════════ */
	function runAntiPro(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const HIDE = ['upgrade-notice-banner','upgrade-title','upgrade-to-pro-button',
		              'view-demo-button','add-fee','add-shipping'];
		const css = HIDE.map(t => `[data-testid='${t}']`).join(',')
			+ `,[aria-label='Notifications'],[aria-label='Open notification center']`
			+ `{display:none!important}`;
		const js = `(function(){
			if(window.__ap||!document||!document.documentElement)return;
			try{
				window.__ap=true;
				var s=document.createElement('style');
				s.id='wcpos-ap';
				s.textContent=${JSON.stringify(css)};
				(document.head||document.documentElement).appendChild(s);
				console.log('[ap] injecte');
			}catch(e){ console.error('[ap]',e.message); }
		})();`;
		mainWindow.webContents.executeJavaScript(js)
			.catch((e: Error) => log.error('[ap] executeJS: '+e.message));
	}

	/* ════════════════════════════════════════════════════════════════════════
	   BLOC 2 — Setup caisse/overlay (une seule fois par chargement de page)
	   Expose les fonctions globales __showOverlay, __hideOverlay, __loadPanel
	   et démarre les intervalles de vérification caisse.
	   Aucun MO. Aucune détection d'onglet ici.
	   ════════════════════════════════════════════════════════════════════════ */
	function runSetup(): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const js = `(function(){
			if(window.__setup||!document||!document.body)return;
			try{
				if(!document.querySelector('[data-testid="search-products"]')){
					console.log('[setup] hors POS');
					return;
				}
				window.__setup=true;
				console.log('[setup] debut v4.1');
				var REST=${JSON.stringify(WP_REST_BASE)};

				function rp(ep,data,cb){
					console.log('[rp] POST '+ep);
					fetch(REST+ep,{method:'POST',headers:{'Content-Type':'application/json'},
						body:JSON.stringify(data),credentials:'include'})
						.then(function(r){return r.json();}).then(function(d){
							console.log('[rp] reponse '+ep+' ok='+!!d);
							cb(d);
						}).catch(function(e){
							console.error('[rp] erreur '+ep+':',e.message);
							cb({error:e.message});
						});
				}

				window.__loadPanel=function(pid,wrap,cv,force){
					if(window.__loadingPanel&&!force)return;
					window.__loadingPanel=true;
					console.log('[loadPanel] pid='+pid+(cv?' cv='+cv:''));
					wrap.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement...</p>';
					var body={panel_id:pid};if(cv)body.caisse_view=cv;
					rp('/panel',body,function(d){
						window.__loadingPanel=false;
						if(!d||!d.html){
							console.error('[loadPanel] pas de html:',JSON.stringify(d));
							wrap.innerHTML='<p style="padding:20px;color:#c00">'+(d&&d.error?d.error:'Erreur')+'</p>';
							return;
						}
						console.log('[loadPanel] html recu len='+d.html.length);
						wrap.innerHTML=d.html;
						wrap.querySelectorAll('script').forEach(function(s){
							var ns=document.createElement('script');ns.textContent=s.textContent;
							s.parentNode.replaceChild(ns,s);
						});
					});
				};

				/* ── Navigation vers l'onglet clients (caisse) ───────────────── */
				function navToClients(){
					console.log('[nav] → clients');
					/* Méthode 1 : cliquer le lien nav WCPOS dont le href contient 'customers' */
					var found=false;
					document.querySelectorAll('a[href]').forEach(function(el){
						if(found)return;
						if((el.getAttribute('href')||'').indexOf('customers')!==-1){
							el.click(); found=true;
							console.log('[nav] click href customers OK');
						}
					});
					if(found)return;
					/* Méthode 2 : pushState sur l'URL courante */
					var url=window.location.href;
					var newUrl=url.replace(/(products|orders|reports)/, 'customers');
					if(newUrl!==url){
						window.history.pushState({},'',newUrl);
						window.dispatchEvent(new PopStateEvent('popstate',{state:{}}));
						console.log('[nav] pushState customers OK: '+newUrl);
					}
				}

				/* ── Overlay caisse fermée ────────────────────────────────────── */
				window.__showOverlay=function(msg){
					if(document.getElementById('wco'))return;
					console.log('[overlay] show');
					var ov=document.createElement('div');ov.id='wco';
					ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);'
						+'display:flex;flex-direction:column;align-items:center;justify-content:center;'
						+'text-align:center;padding:24px;font-family:sans-serif;color:#fff';
					ov.innerHTML='<div style="font-size:3em;margin-bottom:14px">&#128274;</div>'
						+'<h2 style="font-size:1.2em;font-weight:700;margin:0 0 8px">Caisse fermée</h2>'
						+'<p style="font-size:.9em;opacity:.8;max-width:340px;line-height:1.5;margin:0 0 20px">'
						+(msg||'La caisse est fermée. Ouvrez-la avant de commencer.')+'</p>'
						+'<button id="wcb" style="background:#00a32a;color:#fff;border:none;'
						+'padding:12px 28px;border-radius:6px;font-size:1em;font-weight:600;'
						+'cursor:pointer;letter-spacing:.3px">🔓 Ouvrir la caisse</button>';
					document.body.appendChild(ov);
					document.getElementById('wcb').addEventListener('click',function(){
						console.log('[overlay] → caisse');
						ov.remove();
						navToClients();
					});
				};
				window.__hideOverlay=function(){
					var ov=document.getElementById('wco');
					if(ov){ ov.remove(); console.log('[overlay] hide'); }
				};

				function hasPP(){
					var w=document.getElementById('wpp');
					return !!(w&&w.style.display!=='none'&&w.innerHTML.length>100);
				}
				function inPOS(){ return !!document.querySelector('[data-testid="search-products"]'); }

				/* Détecte l'onglet actuel depuis l'URL */
				function currentTab(){
					var u=window.location.href.toLowerCase();
					var tabs=['products','orders','customers','reports'];
					for(var i=0;i<tabs.length;i++){if(u.indexOf(tabs[i])!==-1)return tabs[i];}
					return null;
				}

				function chkCaisse(){
					if(!inPOS())return;
					var tab=currentTab();
					/* Overlay uniquement sur l'onglet POS (products/orders).
					   Sur customers : le panel caisse gère lui-même l'affichage.
					   Sur reports : pas d'overlay. */
					var isPosTab=(tab==='products'||tab==='orders'||tab===null);
					rp('/caisse/status',{},function(d){
						if(!d||d.error){console.warn('[caisse] status err:',d&&d.error);return;}
						console.log('[caisse] open='+d.open+' tab='+tab);
						if(d.open){
							window.__hideOverlay();
						}else if(isPosTab){
							window.__showOverlay(d.message);
						}
					});
				}

				/* Action poller (caisse submit / nav) */
				window._wcpos_action=null;
				setInterval(function(){
					if(!window._wcpos_action)return;
					var a=window._wcpos_action; window._wcpos_action=null;
					console.log('[action] type='+a.type);
					var wpp=document.getElementById('wpp');
					if(a.type==='nav'&&wpp){
						window.__loadingPanel=false;
						window.__loadPanel(wpp.getAttribute('data-pid'),wpp,a.view,true);
					}
					if(a.type==='submit'){
						var fd={};
						if(a.data&&typeof a.data.entries==='function'){
							for(var pair of a.data.entries()){fd[pair[0]]=pair[1];}
						}else if(a.data&&typeof a.data==='object'){fd=Object.assign({},a.data);}
						rp('/caisse/submit',Object.assign({wcpos_caisse_action:a.action},fd),function(d){
							console.log('[submit] reponse:',JSON.stringify(d));
							window.__hideOverlay();
							var wpp2=document.getElementById('wpp');
							if(wpp2)window.__loadPanel(wpp2.getAttribute('data-pid'),wpp2,'dashboard',true);
							setTimeout(chkCaisse,400);
						});
					}
				},200);

				/* Check caisse au démarrage + toutes les 60s */
				chkCaisse();
				setInterval(chkCaisse,60000);

				/* Surveille la fermeture du panel pour re-check caisse */
				var _pws=false;
				setInterval(function(){
					if(!inPOS())return;
					if(hasPP()){ window.__hideOverlay(); _pws=true; }
					else if(_pws){ _pws=false; chkCaisse(); }
				},1000);

				console.log('[setup] OK');
			}catch(e){ console.error('[setup] EXCEPTION',e.message,e.stack); }
		})();`;
		mainWindow.webContents.executeJavaScript(js)
			.catch((e: Error) => log.error('[setup] executeJS: '+e.message));
	}

	/* ════════════════════════════════════════════════════════════════════════
	   BLOC 3 — Injection panel pour un onglet donné
	   Appelé depuis le main process à chaque changement d'URL détecté.
	   findPanel() : filtre d'abord par texte (pas de reflow), puis cherche
	   l'élément FEUILLE (aucun enfant ne contient aussi la signature) avant
	   d'appeler getBoundingClientRect. O(N texte) + O(1 reflow) max.
	   ════════════════════════════════════════════════════════════════════════ */
	function runPanelForTab(tab: string | null): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;

		if (!tab) {
			mainWindow.webContents.executeJavaScript(`(function(){
				var w=document.getElementById('wpp');
				if(w){ w.style.setProperty('display','none','important'); console.log('[panel] cache'); }
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
		if (!sig) { log.warn(`[panel] onglet inconnu: ${tab}`); return; }
		log.info(`[panel] injection tab=${tab}`);

		const js = `(function(){
			try{
				var tab=${JSON.stringify(tab)};
				var sig=${JSON.stringify(sig)};
				console.log('[panel] run tab='+tab);

				if(!document.querySelector('[data-testid="search-products"]')){
					console.log('[panel] hors POS');
					return;
				}
				if(!window.__setup){
					console.log('[panel] setup absent, retry dans 500ms');
					setTimeout(function(){
						var e=new CustomEvent('wcpos-retry-panel',{detail:{tab:tab}});
						document.dispatchEvent(e);
					},500);
					return;
				}

				var wpp=document.getElementById('wpp');

				/* Panel déjà chargé pour cet onglet → ré-afficher */
				if(wpp&&wpp.getAttribute('data-pid')===tab&&wpp.innerHTML.length>100){
					wpp.style.removeProperty('display');
					console.log('[panel] re-affiche tab='+tab);
					return;
				}

				/* Recherche de l'élément upsell feuille */
				var W=window.innerWidth, H=window.innerHeight;
				var sigLow=sig.toLowerCase();
				var best=null, bestScore=0;
				var checked=0;

				document.querySelectorAll('div,section,aside').forEach(function(el){
					if(el.id==='wpp')return;
					var txt=(el.textContent||'').toLowerCase();
					if(txt.indexOf(sigLow)===-1)return;
					checked++;

					/* Rejeter si un enfant direct contient aussi la signature (el = container) */
					for(var i=0;i<el.children.length;i++){
						if((el.children[i].textContent||'').toLowerCase().indexOf(sigLow)!==-1)return;
					}

					/* el est la feuille portant le texte → reflow autorisé */
					var r=el.getBoundingClientRect();
					console.log('[panel] candidat '+checked+' x='+Math.round(r.x)
						+' w='+Math.round(r.width)+' h='+Math.round(r.height));
					if(r.width<W*0.15||r.height<H*0.05)return;
					if(r.x===0&&r.width>W*0.85)return;
					if(r.x>W*0.75||r.width<W*0.20)return;
					var score=r.width*r.height;
					if(score>bestScore){ bestScore=score; best={el:el,r:r}; }
				});

				if(!best){
					console.log('[panel] upsell introuvable pour tab='+tab+' (verifie '+checked+' elems)');
					if(wpp)wpp.style.setProperty('display','none','important');
					return;
				}

				console.log('[panel] upsell OK tab='+tab
					+' top='+Math.round(best.r.top)+' left='+Math.round(best.r.left)
					+' w='+Math.round(best.r.width)+' h='+Math.round(best.r.height));

				if(wpp)wpp.remove();

				/* Trouver le bord droit de la sidebar WCPOS (barre d'icônes à gauche).
				   On cherche le premier élément nav/sidebar visuel, ou on prend best.r.left
				   si c'est raisonnable (< 30% écran), sinon on part du bord gauche + 55px. */
				var navLeft = (function(){
					var selectors = [
						'[class*="TabBar"]','[class*="Sidebar"]','[class*="Navigation"]',
						'[class*="sidebar"]','[class*="nav-bar"]','nav[class]'
					];
					for(var i=0;i<selectors.length;i++){
						var el=document.querySelector(selectors[i]);
						if(el){
							var r2=el.getBoundingClientRect();
							/* Valide uniquement si c'est une barre étroite sur le côté gauche */
							if(r2.left===0 && r2.width>0 && r2.width<W*0.15){
								return Math.round(r2.right);
							}
						}
					}
					/* Fallback : si best.r.left < 30% écran, l'utiliser, sinon 55px */
					return best.r.left < W*0.30 ? Math.round(best.r.left) : 55;
				})();

				/* Détecter le bas de la ZONE DE HEADER complète.
				   WCPOS peut avoir plusieurs couches (app bar + navigation bar).
				   On scanne TOUS les candidats et on prend le bottom maximum. */
				var headerBottom = (function(){
					var maxB = 0;
					var tags = 'header,nav,[role="banner"],[role="navigation"],'
						+'[class*="Header"],[class*="TopBar"],[class*="AppBar"],'
						+'[class*="Toolbar"],[class*="toolbar"],[class*="header"],'
						+'[class*="topbar"],[class*="app-bar"],[class*="NavBar"]';
					document.querySelectorAll(tags).forEach(function(el){
						var r3=el.getBoundingClientRect();
						/* Valide : collé en haut (top ≤ 5px), largeur > 50% écran,
						   hauteur entre 10px et 200px */
						if(r3.top<=5 && r3.width>W*0.5 && r3.height>10 && r3.height<200){
							if(Math.round(r3.bottom)>maxB) maxB=Math.round(r3.bottom);
						}
					});
					return maxB>0 ? maxB : 50;
				})();

				console.log('[panel] navLeft='+navLeft+' headerBottom='+headerBottom+' best.r.left='+Math.round(best.r.left)+' best.r.top='+Math.round(best.r.top));

				var w=document.createElement('div');
				w.id='wpp'; w.setAttribute('data-pid',tab);
				w.style.cssText='position:fixed'
					+';top:'+headerBottom+'px;left:'+navLeft+'px;right:0;bottom:0'
					+';z-index:50;background:#f0f0f1;overflow-y:auto;box-sizing:border-box';
				document.body.appendChild(w);
				best.el.style.setProperty('visibility','hidden','important');
				best.el.setAttribute('data-wcpos-off','1');

				window.__loadPanel(tab,w,null,true);
			}catch(e){ console.error('[panel] EXCEPTION',e.message,e.stack); }
		})();`;
		mainWindow.webContents.executeJavaScript(js)
			.catch((e: Error) => log.error(`[panel] executeJS: ${e.message}`));
	}

	/* ════════════════════════════════════════════════════════════════════════
	   ORCHESTRATION MAIN PROCESS
	   ════════════════════════════════════════════════════════════════════════ */
	let lastTab: string | null = null;

	function onNavigate(label: string, url?: string): void {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		const currentUrl = url ?? mainWindow.webContents.getURL();
		const tab = tabFromUrl(currentUrl);
		log.info(`[${label}] url=${currentUrl} → tab=${tab}`);
		runAntiPro();
		runSetup();
		if (tab !== lastTab) {
			lastTab = tab;
			/* Délai 400ms : laisse React finir le render avant findPanel */
			setTimeout(() => runPanelForTab(tab), 400);
		}
	}

	mainWindow.webContents.on('dom-ready', () => {
		mainWindow?.setTitle(APP_VERSION);
		log.info('[dom-ready]');
		onNavigate('dom-ready');
		/* Injecte un listener resize dans le renderer pour recalculer le panel
		   quand la fenêtre est redimensionnée (v3.9) */
		setTimeout(() => {
			mainWindow?.webContents.executeJavaScript(`(function(){
				if(window.__wcpos_resize)return;
				window.__wcpos_resize=true;
				var resizeTimer=null;
				window.addEventListener('resize',function(){
					clearTimeout(resizeTimer);
					resizeTimer=setTimeout(function(){
						var wpp=document.getElementById('wpp');
						if(wpp){
							/* Retire le panel — le main process re-injecte via did-navigate-in-page
							   OU via le console.log('[resize]...) capturé par console-message */
							wpp.remove();
							console.log('[resize] recalcul pid='+wpp.getAttribute('data-pid'));
						}
					},300);
				});
			})();`).catch(()=>{});
		}, 2000);
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

	/* Poll court (10 × 2s) pour le chargement initial du POS */
	let pollCount = 0;
	const pollTimer = setInterval(() => {
		if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
		const url = mainWindow.webContents.getURL();
		const tab = tabFromUrl(url);
		log.info(`[poll ${pollCount+1}/10] url=${url} tab=${tab}`);
		runAntiPro();
		runSetup();
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
		log.error(`[did-fail-load] desc=${desc}`);
		if (desc === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= 30) return;
			retryCount++;
			setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
