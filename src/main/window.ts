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

const APP_VERSION  = 'POSTir 5.4.0';
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

	/* ── onBeforeSendHeaders ───────────────────────────────────────────── */
	mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
		{ urls: [WP_SITE_URL + '/*'] },
		(d, cb) => {
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
			if (d.url.includes('/wcpos-checkout/')) {
				cb({ responseHeaders: d.responseHeaders });
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
				
function replaceLoginLogo() {
    var logoPath = document.querySelector('path[fill="#323A46"][d*="l-810,0l-360,270"]');
    
    if (logoPath) {
        var svg = logoPath.closest('svg');
        if (svg && !svg.getAttribute('data-replaced')) {
            svg.setAttribute('data-replaced', 'true');
            
            // Remplacer tout le SVG par le logo USMM-TIR
            svg.outerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="120" height="120"><g transform="translate(0,1024) scale(0.1,-0.1)" fill="#ffffff" stroke="none"><path d="M5828 9973 c7 -3 16 -2 19 1 4 3 -2 6 -13 5 -11 0 -14 -3 -6 -6z"/><path d="M6270 9890 c0 -5 7 -10 15 -10 8 0 15 5 15 10 0 6 -7 10 -15 10 -8 0 -15 -4 -15 -10z"/><path d="M6500 9830 c0 -5 7 -10 15 -10 8 0 15 5 15 10 0 6 -7 10 -15 10 -8 0 -15 -4 -15 -10z"/><path d="M6900 9690 c0 -5 5 -10 10 -10 6 0 10 5 10 10 0 6 -4 10 -10 10 -5 0 -10 -4 -10 -10z"/><path d="M7140 9590 c0 -5 5 -10 10 -10 6 0 10 5 10 10 0 6 -4 10 -10 10 -5 0 -10 -4 -10 -10z"/><path d="M7310 9510 c0 -5 5 -10 11 -10 5 0 7 5 4 10 -3 6 -8 10 -11 10 -2 0 -4 -4 -4 -10z"/><path d="M7470 9430 c0 -6 7 -10 15 -10 8 0 15 2 15 4 0 2 -7 6 -15 10 -8 3 -15 1 -15 -4z"/><path d="M7535 9390 c3 -5 11 -10 16 -10 6 0 7 5 4 10 -3 6 -11 10 -16 10 -6 0 -7 -4 -4 -10z"/><path d="M7578 9363 c7 -3 16 -2 19 1 4 3 -2 6 -13 5 -11 0 -14 -3 -6 -6z"/><path d="M7650 9315 c0 -8 7 -15 15 -15 8 0 15 4 15 9 0 5 -7 11 -15 15 -9 3 -15 0 -15 -9z"/><path d="M7740 9265 c0 -8 7 -15 15 -15 9 0 12 6 9 15 -4 8 -10 15 -15 15 -5 0 -9 -7 -9 -15z"/><path d="M7792 9228 c3 -7 13 -15 24 -17 16 -3 17 -1 5 13 -16 19 -34 21 -29 4z"/><path d="M7867 9179 c5 -20 18 -25 27 -11 2 4 -4 13 -14 19 -15 10 -17 9 -13 -8z"/><path d="M7944 9125 c3 -9 6 -19 6 -21 0 -2 9 -4 20 -4 28 0 25 15 -6 29 -23 10 -26 10 -20 -4z"/><path d="M8010 9082 c0 -14 46 -53 53 -45 12 11 8 18 -23 36 -16 10 -30 14 -30 9z"/><path d="M8120 8995 c0 -12 42 -45 58 -45 12 0 10 5 -10 18 -16 9 -28 20 -28 24 0 5 -4 8 -10 8 -5 0 -10 -2 -10 -5z"/><path d="M8242 8890 c14 -22 37 -34 47 -24 7 6 -36 44 -50 44 -5 0 -4 -9 3 -20z"/><path d="M8300 8840 c0 -5 4 -10 9 -10 5 0 11 -9 14 -20 3 -11 12 -20 21 -20 24 0 19 14 -14 38 -16 13 -30 18 -30 12z"/><path d="M8405 8760 c9 -10 105 -107 211 -213 107 -107 194 -199 194 -206 0 -7 32 -43 70 -82 39 -38 70 -75 70 -82 0 -7 20 -33 45 -57 25 -24 45 -49 45 -55 0 -6 11 -22 25 -35 14 -13 25 -29 25 -35 0 -6 16 -26 35 -45 19 -18 32 -37 30 -41 -7 -11 6 -39 17 -39 15 0 37 -32 38 -52 0 -10 9 -23 20 -30 11 -7 20 -19 20 -26 0 -8 11 -23 25 -34 14 -11 25 -27 25 -35 0 -9 10 -30 23 -47 13 -17 31 -48 41 -68 9 -21 21 -38 26 -38 6 0 10 -7 10 -16 0 -8 11 -30 25 -48 14 -18 25 -40 25 -49 0 -9 4 -18 9 -22 13 -7 41 -64 41 -82 0 -7 3 -13 8 -13 8 0 32 -49 32 -67 0 -7 5 -13 10 -13 6 0 10 -7 10 -16 0 -18 31 -77 43 -82 4 -2 10 -21 13 -42 4 -21 13 -41 20 -44 8 -3 14 -16 14 -29 0 -14 7 -30 15 -37 8 -7 15 -22 15 -35 0 -20 15 -60 41 -107 5 -10 9 -28 9 -42 0 -13 7 -29 15 -36 8 -7 15 -25 15 -40 0 -15 7 -33 15 -40 9 -7 15 -29 15 -51 0 -22 5 -39 10 -39 6 0 10 -18 10 -40 0 -27 5 -43 15 -46 11 -4 15 -21 15 -55 0 -35 4 -51 15 -55 11 -4 15 -21 15 -55 0 -35 4 -51 15 -55 11 -4 15 -21 15 -58 0 -29 5 -57 10 -62 6 -6 14 -43 17 -82 4 -54 10 -72 21 -72 12 0 13 9 8 48 -9 71 -23 154 -31 182 -22 87 -28 107 -35 125 -8 19 -12 34 -29 120 -8 38 -13 55 -31 100 -16 41 -50 153 -50 164 0 6 -9 33 -21 59 -32 72 -36 82 -59 150 -12 35 -35 88 -51 119 -16 30 -29 61 -29 69 0 7 -32 75 -71 151 -39 76 -79 154 -89 174 -11 20 -41 71 -68 115 -27 43 -64 104 -83 134 -19 30 -37 57 -40 60 -13 11 -109 160 -109 169 0 5 -4 11 -8 13 -5 2 -28 32 -52 68 -24 36 -58 81 -76 100 -18 19 -54 64 -80 99 -57 76 -526 551 -545 551 -8 0 -6 -7 6 -20z"/><path d="M4869 7855 c-4 -3 -44 -10 -90 -15 -185 -19 -449 -106 -784 -260 -33 -15 -165 -70 -240 -100 -38 -16 -119 -49 -180 -75 -60 -26 -159 -67 -220 -91 -60 -25 -123 -51 -140 -59 -64 -30 -326 -135 -338 -135 -36 0 -37 -17 -37 -436 0 -237 4 -415 9 -418 19 -12 37 6 60 59 32 75 75 120 151 159 l65 33 3 186 2 187 38 16 c20 8 64 25 97 36 33 11 64 24 70 29 5 5 15 9 23 9 8 0 28 6 45 14 18 7 70 28 117 46 47 17 95 36 108 41 12 5 32 13 45 18 51 22 155 61 202 76 28 9 64 23 80 30 30 13 137 55 205 80 19 8 91 35 160 60 69 26 139 53 157 61 17 8 38 14 46 14 9 0 19 5 22 10 3 6 15 10 26 10 10 0 27 4 37 9 24 14 111 36 222 58 112 21 360 24 455 5 137 -29 202 -45 232 -58 17 -8 35 -14 40 -14 9 0 145 -51 198 -74 17 -7 46 -19 65 -26 19 -6 44 -16 55 -20 46 -18 111 -43 130 -50 11 -4 31 -12 45 -17 14 -6 43 -17 65 -26 47 -17 122 -46 150 -57 98 -39 237 -92 340 -130 11 -4 31 -12 45 -18 72 -31 233 -92 243 -92 6 0 27 -8 48 -17 l38 -17 3 -110 3 -110 66 -21 c78 -24 104 -40 163 -101 24 -26 49 -44 54 -40 7 4 11 100 12 276 1 264 -3 320 -21 320 -5 0 -31 10 -57 21 -113 51 -132 59 -137 59 -3 0 -24 9 -48 19 -23 10 -78 33 -122 51 -44 17 -93 38 -110 45 -16 8 -70 31 -120 51 -49 20 -115 47 -145 61 -30 13 -64 28 -75 33 -11 4 -36 15 -57 24 -20 9 -39 16 -42 16 -3 0 -25 9 -49 19 -23 11 -98 43 -167 72 -140 58 -196 82 -255 110 -132 61 -312 115 -485 146 -86 15 -510 30 -521 18z"/><path d="M5426 6779 c-35 -10 -86 -44 -107 -73 -9 -11 -30 -64 -48 -116 -41 -124 -45 -137 -70 -255 -12 -55 -26 -116 -31 -136 -6 -20 -10 -46 -10 -59 0 -35 -30 -130 -42 -130 -13 0 -276 -132 -388 -195 -125 -70 -154 -84 -161 -77 -4 4 -14 34 -24 67 -9 33 -21 73 -26 89 -22 70 -8 250 24 326 19 46 89 145 123 173 l34 29 0 -36 c0 -26 7 -44 25 -61 49 -50 112 -20 141 68 23 67 25 187 4 209 -8 8 -24 27 -35 41 -11 15 -27 27 -37 27 -9 0 -20 5 -23 10 -11 18 -121 11 -176 -10 -175 -69 -355 -254 -425 -435 -16 -42 -19 -76 -19 -210 0 -157 9 -215 46 -287 5 -10 9 -23 9 -29 0 -6 16 -45 35 -86 19 -41 35 -76 35 -78 0 -2 -33 -27 -72 -56 -166 -122 -297 -239 -398 -354 l-43 -50 6 35 c12 64 149 485 173 530 7 14 29 68 50 120 20 52 52 127 70 167 55 121 57 214 5 272 -48 53 -146 75 -233 51 -70 -20 -122 -100 -223 -345 -41 -98 -42 -102 -108 -250 -44 -98 -103 -224 -185 -395 -23 -47 -59 -116 -81 -155 -22 -38 -43 -77 -47 -85 -21 -43 -99 -153 -125 -174 -72 -61 -78 24 -18 259 22 88 44 176 49 195 18 71 195 564 209 585 4 6 16 33 26 60 10 28 27 70 38 95 50 113 57 134 57 177 0 92 -73 147 -192 145 -55 -1 -79 -6 -114 -27 -78 -46 -94 -77 -184 -370 -5 -16 -21 -77 -35 -135 -14 -58 -32 -128 -40 -156 -8 -28 -15 -62 -15 -77 0 -14 -5 -38 -11 -54 -6 -15 -15 -64 -20 -108 -6 -44 -14 -111 -19 -150 -5 -38 -9 -156 -9 -262 -1 -172 1 -198 20 -249 36 -96 83 -134 164 -134 71 0 114 29 192 127 87 109 111 147 187 297 102 199 147 282 141 261 -25 -80 -29 -601 -6 -658 6 -16 11 -48 11 -73 0 -24 9 -79 20 -122 18 -68 26 -82 69 -122 76 -71 156 -100 275 -100 116 0 315 34 394 66 100 43 137 60 237 115 49 27 225 201 225 223 0 9 4 16 8 16 10 0 54 87 79 156 13 36 18 80 18 169 0 140 -18 218 -87 365 -14 30 -33 73 -43 95 -9 22 -23 53 -31 69 -8 16 -14 34 -14 40 0 15 43 39 339 193 l124 65 -7 -89 c-3 -48 -9 -189 -12 -313 -6 -195 -4 -246 15 -387 12 -90 27 -175 33 -190 27 -64 71 -88 117 -63 29 15 40 56 50 191 9 121 42 295 61 331 6 10 10 26 10 35 0 10 7 31 15 47 8 15 15 35 15 42 0 14 4 25 28 71 7 13 12 28 12 34 0 28 218 446 280 539 6 8 13 23 16 33 4 9 10 17 14 17 4 0 11 10 17 23 25 54 211 260 257 284 44 23 51 7 50 -105 -2 -199 -25 -401 -79 -692 -15 -80 -30 -170 -35 -200 -10 -67 -34 -182 -55 -270 -9 -36 -19 -99 -22 -140 -4 -66 -2 -78 17 -102 18 -24 29 -28 71 -28 43 0 54 4 82 33 37 37 57 76 82 162 9 33 21 69 25 80 4 11 15 38 23 60 9 22 28 74 42 115 82 231 229 543 325 689 34 52 69 101 76 109 8 7 14 16 14 20 1 11 82 95 121 125 70 53 95 26 85 -92 -7 -73 -14 -106 -41 -181 -31 -83 -64 -193 -90 -300 -7 -30 -21 -82 -30 -115 -9 -33 -21 -94 -27 -135 -11 -89 -5 -277 11 -293 6 -6 11 -18 11 -26 0 -24 51 -91 81 -107 43 -22 141 -18 197 8 79 36 260 229 383 408 24 35 52 73 62 84 9 11 17 23 17 27 0 4 6 14 13 21 26 29 85 120 195 303 124 208 129 226 76 273 -53 46 -106 14 -164 -98 -15 -30 -40 -73 -56 -95 -15 -22 -65 -103 -113 -180 -47 -77 -90 -145 -96 -151 -5 -7 -50 -72 -100 -145 -108 -159 -210 -272 -225 -249 -15 24 8 171 39 245 8 18 29 73 51 130 4 12 22 63 40 115 18 52 41 113 51 135 10 22 30 87 45 145 34 138 32 256 -8 342 -33 70 -58 97 -123 127 -105 49 -215 36 -330 -39 -72 -47 -195 -170 -254 -254 -45 -65 -46 -62 -31 46 7 45 6 101 0 165 -11 100 -30 143 -84 183 -75 56 -229 53 -346 -6 -52 -26 -172 -126 -217 -181 -52 -63 -194 -267 -223 -320 -13 -24 -26 -41 -28 -38 -5 4 1 27 45 175 25 87 65 203 77 225 19 37 35 109 36 166 0 49 -4 60 -35 96 -54 64 -156 95 -239 72z m-1056 -1425 c6 -14 21 -49 34 -78 43 -94 59 -179 53 -285 -5 -94 -37 -211 -58 -211 -5 0 -9 -7 -9 -16 0 -8 -39 -55 -87 -102 -68 -68 -108 -98 -178 -134 -125 -65 -190 -83 -307 -83 -87 0 -99 2 -117 22 -40 42 -21 172 41 286 13 23 26 44 29 47 3 3 14 21 25 40 32 59 145 202 209 263 156 153 310 277 342 277 8 0 18 -12 23 -26z"/><path d="M9956 5904 c4 -49 10 -93 14 -99 4 -5 11 -63 15 -127 6 -90 11 -118 21 -118 18 0 17 25 -2 170 -9 63 -19 146 -22 184 -5 44 -12 71 -20 74 -11 3 -12 -14 -6 -84z"/><path d="M10014 5113 c1 -236 6 -400 12 -403 10 -5 19 738 9 778 -17 71 -22 -20 -21 -375z"/><path d="M7210 5012 c-43 -47 -136 -117 -170 -127 -63 -19 -60 10 -60 -520 l0 -483 -112 -84 c-62 -47 -165 -122 -228 -168 -63 -46 -158 -115 -210 -153 -52 -39 -135 -101 -185 -137 -173 -128 -526 -391 -543 -405 -9 -8 -62 -47 -118 -87 -55 -40 -131 -97 -170 -126 -38 -29 -133 -100 -211 -158 l-142 -105 -28 18 c-29 19 -47 32 -91 71 -15 13 -80 61 -144 108 -64 46 -123 90 -130 97 -7 7 -29 24 -48 37 -19 13 -37 27 -40 30 -3 4 -34 26 -70 50 -36 24 -71 50 -79 58 -8 7 -26 21 -40 30 -14 9 -33 22 -41 29 -8 6 -80 60 -160 119 -80 59 -173 128 -207 153 -34 25 -84 62 -110 81 -26 19 -50 37 -53 41 -3 3 -27 20 -55 39 -27 19 -52 36 -55 40 -4 5 -179 133 -298 218 -13 9 -39 28 -57 42 -18 14 -44 32 -57 42 -12 9 -56 40 -96 70 l-72 53 1 315 c1 315 1 315 -21 318 -11 2 -26 -1 -33 -6 -26 -21 -115 -24 -172 -6 -31 9 -59 14 -63 10 -10 -10 -15 -819 -5 -831 4 -6 42 -35 83 -65 41 -29 77 -56 80 -60 3 -3 100 -74 215 -157 116 -82 285 -206 376 -274 92 -68 210 -155 263 -194 53 -38 199 -146 324 -239 125 -93 290 -216 367 -273 77 -57 147 -110 155 -116 8 -7 33 -26 55 -42 22 -17 45 -34 52 -40 71 -58 245 -185 254 -185 10 0 68 37 79 50 8 9 282 213 311 232 14 9 32 23 40 30 15 15 263 200 319 238 19 13 41 30 48 37 8 7 44 34 80 60 37 26 69 50 72 53 3 3 34 27 70 53 36 27 74 55 85 64 11 9 33 26 50 37 43 30 107 78 129 99 11 9 23 17 26 17 4 0 16 8 28 18 11 9 31 24 44 34 39 28 426 314 453 336 6 4 26 18 45 32 19 13 37 27 40 30 3 4 32 25 65 47 33 23 74 53 90 67 17 15 54 43 83 63 28 20 52 41 52 47 0 6 1 315 1 686 0 557 -2 675 -13 678 -7 1 -29 -15 -48 -36z"/><path d="M9995 4678 c-2 -7 -6 -65 -10 -128 -3 -63 -10 -119 -15 -125 -4 -5 -11 -52 -15 -102 -4 -51 -11 -93 -16 -93 -5 0 -9 -28 -9 -63 0 -40 -5 -70 -15 -83 -8 -10 -15 -40 -15 -65 0 -29 -6 -51 -15 -59 -9 -7 -15 -30 -15 -54 0 -22 -7 -50 -15 -60 -8 -11 -15 -37 -15 -57 0 -21 -5 -39 -12 -41 -7 -3 -13 -24 -14 -48 -1 -24 -6 -46 -13 -48 -6 -2 -11 -19 -11 -39 0 -19 -7 -41 -15 -49 -8 -9 -15 -27 -15 -40 0 -14 -7 -32 -15 -40 -8 -9 -15 -27 -15 -40 0 -14 -7 -32 -15 -40 -8 -9 -15 -26 -15 -40 0 -13 -4 -24 -10 -24 -5 0 -10 -15 -10 -34 0 -21 -6 -36 -15 -40 -8 -3 -15 -16 -15 -29 0 -14 -7 -30 -15 -37 -8 -7 -15 -23 -15 -36 0 -12 -7 -29 -15 -38 -8 -8 -15 -18 -15 -23 0 -12 -54 -118 -62 -121 -5 -2 -8 -14 -8 -26 0 -13 -11 -35 -25 -50 -14 -15 -25 -36 -25 -46 0 -10 -4 -22 -10 -25 -5 -3 -10 -14 -10 -23 0 -10 -11 -29 -25 -44 -14 -15 -25 -34 -25 -43 0 -9 -7 -18 -15 -21 -8 -4 -15 -17 -15 -30 0 -13 -4 -24 -10 -24 -5 0 -10 -7 -10 -16 0 -9 -11 -25 -25 -36 -14 -11 -25 -27 -25 -37 0 -10 -11 -28 -25 -41 -14 -13 -23 -30 -21 -36 3 -7 -6 -20 -20 -28 -13 -9 -24 -25 -24 -36 0 -10 -11 -27 -25 -38 -14 -11 -25 -28 -25 -38 0 -11 -16 -32 -35 -49 -19 -16 -35 -36 -35 -43 0 -7 -14 -25 -30 -39 -17 -14 -29 -31 -28 -37 2 -7 -16 -32 -39 -56 -24 -24 -43 -49 -43 -55 0 -7 -31 -42 -70 -78 -38 -36 -70 -72 -70 -79 0 -18 -435 -458 -453 -458 -8 0 -31 -18 -51 -40 -20 -22 -38 -40 -41 -40 -3 0 -19 -16 -37 -35 -18 -20 -43 -37 -55 -38 -13 -1 -23 -4 -23 -7 0 -12 -71 -80 -83 -80 -7 0 -26 -13 -42 -30 -16 -16 -34 -30 -40 -30 -6 0 -26 -16 -45 -35 -19 -19 -39 -35 -45 -35 -5 0 -23 -11 -38 -26 -15 -14 -31 -23 -36 -20 -4 3 -19 -6 -32 -20 -12 -13 -29 -22 -35 -20 -7 3 -20 -6 -28 -20 -10 -14 -26 -24 -40 -24 -13 0 -26 -6 -29 -13 -3 -8 -21 -22 -41 -31 -20 -9 -36 -21 -36 -26 0 -6 -7 -10 -16 -10 -9 0 -43 -18 -75 -40 -32 -22 -66 -40 -74 -40 -8 0 -15 -4 -15 -10 0 -5 -9 -10 -19 -10 -11 0 -23 -4 -26 -10 -5 -8 -43 -27 -100 -50 -11 -4 -49 -22 -83 -39 -35 -17 -70 -31 -78 -31 -8 0 -14 -4 -14 -10 0 -5 -11 -10 -25 -10 -14 0 -28 -7 -31 -15 -4 -8 -17 -15 -29 -15 -13 0 -27 -5 -30 -10 -3 -6 -20 -10 -36 -10 -17 0 -32 -6 -35 -15 -4 -8 -16 -15 -29 -15 -12 0 -28 -7 -35 -15 -7 -8 -28 -15 -47 -15 -21 0 -36 -6 -39 -15 -4 -8 -18 -15 -34 -15 -15 0 -33 -7 -40 -15 -7 -9 -29 -15 -50 -15 -21 0 -40 -5 -42 -11 -2 -6 -22 -13 -43 -16 -22 -2 -41 -8 -43 -13 -2 -6 -23 -10 -47 -10 -25 0 -50 -6 -59 -15 -8 -8 -30 -15 -48 -15 -18 0 -46 -7 -62 -15 -15 -8 -45 -15 -66 -15 -21 0 -43 -7 -50 -15 -9 -10 -32 -15 -77 -15 -47 0 -65 -4 -69 -15 -5 -12 -25 -15 -94 -15 -66 0 -91 -4 -100 -15 -10 -12 -37 -15 -127 -15 -92 0 -115 -3 -119 -15 -5 -13 -64 -15 -439 -15 -239 0 -436 -4 -439 -9 -13 -21 516 -28 769 -10 72 6 171 12 220 15 50 2 99 9 110 13 11 5 45 12 75 16 30 3 82 11 115 16 33 6 80 13 105 16 25 3 49 9 54 14 6 5 25 9 42 9 18 0 35 4 38 9 3 5 23 11 43 14 51 7 94 17 118 27 19 7 42 14 148 41 23 6 50 15 59 20 10 5 25 9 33 9 8 0 23 4 33 9 29 15 65 29 107 42 22 7 44 17 49 21 6 4 17 8 26 8 9 0 35 9 58 20 22 11 46 20 52 20 5 0 18 4 28 9 9 5 28 13 42 19 32 12 94 40 193 86 168 79 233 110 257 127 14 9 42 26 63 38 20 11 52 30 71 40 19 11 72 44 117 74 46 30 115 74 153 98 38 23 74 48 80 54 6 6 27 22 46 35 19 13 37 27 40 30 3 3 21 17 40 30 36 26 42 30 127 101 28 24 82 69 120 99 85 69 434 416 492 490 24 30 64 78 90 105 25 28 58 66 73 87 15 20 34 42 41 50 7 7 24 29 37 48 13 19 33 44 43 55 22 24 197 281 197 290 0 3 17 32 38 63 21 31 49 77 63 102 13 25 27 47 30 50 3 3 42 75 86 160 44 85 84 164 90 175 6 11 15 31 20 45 18 44 35 84 44 102 5 10 9 27 9 37 0 11 5 23 10 26 6 3 10 12 10 20 0 8 13 42 29 77 27 58 91 237 112 316 10 37 26 92 40 142 6 19 15 53 20 75 6 22 14 58 20 80 10 38 15 62 39 185 6 30 15 87 20 125 5 39 13 106 19 150 20 149 25 255 12 255 -6 0 -13 -6 -16 -12z"/><path d="M5355 4654 c-182 -23 -211 -31 -241 -67 -35 -41 -30 -104 12 -148 35 -37 57 -37 221 0 314 71 407 81 774 81 278 0 535 -18 596 -41 13 -5 40 -9 59 -9 28 0 35 4 32 17 -2 10 -12 19 -23 21 -11 2 -34 10 -52 18 -17 8 -42 14 -56 14 -14 0 -38 7 -53 15 -16 8 -45 15 -64 15 -19 1 -46 7 -60 15 -14 8 -44 14 -67 15 -23 0 -44 4 -47 9 -5 8 -31 12 -166 26 -30 4 -80 11 -110 17 -91 17 -627 19 -755 2z"/><path d="M4935 4067 c-21 -33 -92 -208 -97 -238 -2 -19 2 -25 22 -27 19 -2 32 5 48 28 18 23 30 30 58 30 28 0 38 -6 52 -30 14 -24 24 -30 51 -30 31 0 33 2 28 28 -4 24 -90 239 -99 247 -1 1 -13 6 -25 9 -17 5 -26 1 -38 -17z m45 -127 c0 -11 -7 -20 -15 -20 -17 0 -18 2 -9 24 9 23 24 20 24 -4z"/><path d="M3935 4068 c-11 -30 -44 -251 -39 -259 3 -5 18 -9 34 -9 30 0 40 14 40 58 0 55 16 53 39 -3 13 -31 29 -55 38 -55 8 0 26 26 41 58 l27 57 3 -35 c5 -73 10 -80 47 -80 32 0 35 3 35 28 0 33 -37 242 -44 249 -3 3 -16 3 -29 -1 -18 -4 -31 -20 -47 -61 -12 -30 -25 -55 -29 -55 -4 0 -20 27 -36 60 -23 48 -33 60 -52 60 -13 0 -26 -6 -28 -12z"/><path d="M4377 4073 c-14 -23 -97 -244 -97 -257 0 -27 55 -21 68 8 8 17 21 25 49 29 33 4 41 1 63 -24 29 -34 70 -40 70 -10 0 25 -45 152 -76 214 -19 37 -30 47 -49 47 -13 0 -26 -3 -28 -7z m43 -145 c0 -5 -4 -8 -10 -8 -5 0 -10 10 -10 23 0 18 2 19 10 7 5 -8 10 -18 10 -22z"/><path d="M4626 4064 c-3 -9 -6 -69 -6 -134 0 -144 -3 -140 123 -132 24 2 27 6 27 36 0 33 -2 35 -37 38 l-38 3 -3 90 c-2 50 -5 96 -7 103 -6 17 -52 15 -59 -4z"/><path d="M5187 4073 c-10 -16 -19 -185 -12 -230 6 -42 8 -44 38 -41 30 3 32 6 37 47 5 41 6 42 21 25 8 -11 23 -31 32 -46 14 -23 25 -28 57 -28 52 0 51 14 -5 82 -25 30 -45 61 -45 69 0 7 19 32 41 55 47 48 47 74 1 74 -22 0 -37 -10 -63 -42 l-34 -43 -5 40 c-4 34 -9 40 -32 43 -14 2 -29 -1 -31 -5z"/><path d="M5530 4057 c-82 -55 -91 -145 -21 -220 32 -34 45 -40 87 -44 67 -6 111 18 142 78 39 77 11 164 -64 195 -50 21 -106 17 -144 -9z m132 -64 c27 -24 24 -87 -4 -107 -47 -33 -118 -6 -118 45 0 23 18 60 34 71 20 13 69 8 88 -9z"/><path d="M5862 4068 c-8 -8 -12 -51 -12 -130 0 -109 2 -118 21 -128 35 -19 49 -6 49 50 l0 50 39 0 c30 0 41 5 46 19 12 39 -19 65 -66 56 -13 -3 -19 1 -16 8 2 7 19 13 38 15 43 4 53 14 45 46 -6 24 -10 26 -69 26 -36 0 -68 -5 -75 -12z"/><path d="M6113 4072 c-14 -9 -28 -195 -18 -241 5 -26 11 -31 35 -31 25 0 30 5 35 33 3 17 4 41 2 52 -2 16 5 21 38 25 37 5 40 8 43 38 3 31 2 32 -37 32 -30 0 -41 4 -41 15 0 11 11 15 39 15 42 0 54 13 44 49 -5 18 -13 21 -67 21 -33 0 -66 -4 -73 -8z"/><path d="M4311 3661 c-52 -48 -38 -121 29 -156 65 -33 124 -2 136 73 6 37 3 44 -28 76 -46 47 -92 49 -137 7z m107 -33 c28 -28 0 -88 -43 -88 -28 0 -45 18 -45 50 0 14 5 31 12 38 7 7 24 12 38 12 14 0 31 -5 38 -12z"/><path d="M4519 3664 c-20 -53 -32 -145 -21 -156 17 -17 42 -1 42 25 0 37 11 39 29 5 21 -43 36 -45 51 -8 15 37 28 38 32 3 3 -32 34 -44 40 -16 2 10 -2 50 -9 88 -7 39 -12 71 -13 73 0 1 -7 2 -15 2 -8 0 -25 -20 -37 -46 -20 -40 -24 -43 -35 -28 -7 10 -13 25 -13 34 0 9 -9 25 -20 35 -19 17 -20 17 -31 -11z"/><path d="M4714 3677 c-2 -7 -1 -49 3 -93 7 -70 10 -79 28 -79 17 0 21 8 23 44 l3 45 44 -47 c66 -71 75 -65 75 44 0 88 -1 90 -22 87 -18 -2 -24 -11 -28 -40 l-5 -38 -45 45 c-47 46 -67 54 -76 32z"/><path d="M4924 3679 c-9 -15 -13 -108 -7 -146 4 -24 11 -33 24 -33 21 0 20 -1 21 50 1 97 -3 128 -17 133 -8 4 -17 2 -21 -4z"/><path d="M5007 3672 c-9 -10 -17 -31 -17 -45 0 -21 8 -31 35 -44 33 -16 43 -32 28 -46 -3 -4 -14 0 -24 9 -20 18 -49 12 -49 -10 0 -20 39 -46 67 -46 13 0 32 9 44 21 29 29 22 69 -18 94 -39 24 -41 35 -7 35 21 0 25 4 22 23 -4 30 -57 36 -81 9z"/><path d="M5134 3677 c-3 -8 -4 -49 -2 -93 2 -62 6 -79 18 -79 9 0 17 12 20 30 4 21 12 31 27 33 51 7 67 67 27 106 -19 20 -83 21 -90 3z m63 -63 c-9 -9 -28 6 -21 18 4 6 10 6 17 -1 6 -6 8 -13 4 -17z"/><path d="M5289 3661 c-23 -24 -29 -38 -29 -75 0 -39 4 -48 33 -70 22 -17 47 -26 69 -26 87 0 123 114 55 173 -43 37 -89 37 -128 -2z m107 -47 c28 -42 -20 -89 -66 -64 -22 12 -28 58 -9 77 19 19 59 12 75 -13z"/><path d="M5483 3684 c-9 -4 -13 -33 -13 -95 0 -83 1 -89 20 -89 12 0 24 9 29 22 l8 22 12 -22 c14 -27 51 -30 51 -4 0 10 -5 23 -12 30 -9 9 -9 20 1 48 12 33 11 39 -6 63 -19 25 -62 37 -90 25z m57 -65 c0 -5 -4 -9 -10 -9 -5 0 -10 7 -10 16 0 8 5 12 10 9 6 -3 10 -10 10 -16z"/><path d="M5600 3670 c0 -11 6 -23 14 -26 9 -3 16 -30 20 -75 6 -58 10 -70 24 -67 13 2 18 18 22 68 4 49 9 66 21 68 10 2 19 -5 22 -17 3 -11 21 -28 41 -38 36 -17 49 -43 21 -43 -8 0 -15 5 -15 10 0 12 -37 14 -43 3 -11 -19 13 -51 44 -57 47 -9 79 15 79 59 0 19 -3 35 -7 35 -5 1 -21 12 -38 26 l-30 25 26 -6 c32 -8 44 7 29 35 -13 25 -56 26 -83 3 -18 -17 -19 -17 -32 0 -9 12 -26 17 -64 17 -45 0 -51 -3 -51 -20z"/><path d="M5078 3402 c-14 -2 -18 -14 -18 -43 0 -30 -4 -39 -17 -39 -64 0 -206 -116 -219 -179 -12 -59 -22 -71 -58 -71 -26 0 -36 -5 -41 -20 -9 -29 2 -40 41 -40 28 0 36 -5 45 -27 43 -113 117 -193 199 -217 40 -12 46 -17 50 -47 4 -28 9 -34 30 -34 22 0 25 5 28 37 3 34 6 38 40 44 20 4 53 18 72 32 31 22 45 36 91 90 6 7 18 36 28 65 17 49 20 52 57 57 34 4 39 8 39 30 0 22 -5 26 -39 30 -35 5 -40 9 -51 45 -27 93 -98 166 -186 192 -46 14 -49 17 -49 48 0 36 -16 54 -42 47z m-18 -168 c0 -8 -18 -21 -40 -30 -44 -18 -87 -62 -96 -99 -6 -23 -39 -43 -51 -32 -3 3 0 21 7 41 16 50 78 115 125 131 43 14 55 12 55 -11z m146 -10 c44 -29 82 -80 91 -124 5 -25 2 -30 -15 -30 -13 0 -22 9 -26 25 -9 34 -69 100 -106 115 -17 7 -30 19 -30 26 0 22 42 16 86 -12z m-146 -110 c0 -33 2 -35 28 -32 22 2 28 8 30 36 4 39 23 42 57 7 35 -34 32 -55 -6 -55 -27 0 -30 -3 -27 -27 2 -22 9 -29 31 -31 34 -4 34 -12 -2 -51 -28 -30 -50 -40 -52 -23 -5 47 -20 68 -43 59 -10 -4 -16 -18 -16 -37 0 -37 -18 -39 -54 -5 -37 34 -34 55 8 55 26 0 36 5 41 20 9 30 -13 53 -47 48 -36 -6 -37 14 -3 47 36 36 55 33 55 -11z m-140 -122 c0 -32 56 -99 99 -118 59 -26 56 -61 -2 -42 -68 23 -117 77 -141 156 -6 19 -4 22 18 22 19 0 26 -5 26 -18z m380 1 c0 -59 -84 -151 -154 -169 -25 -6 -27 -4 -24 17 2 14 11 25 23 27 26 5 103 86 111 117 7 29 44 35 44 8z"/><path d="M1005 2440 c-3 -5 -1 -10 4 -10 6 0 11 5 11 10 0 6 -2 10 -4 10 -3 0 -8 -4 -11 -10z"/><path d="M1060 2350 c0 -5 5 -10 10 -10 6 0 10 5 10 10 0 6 -4 10 -10 10 -5 0 -10 -4 -10 -10z"/><path d="M1285 2070 c-3 -5 -1 -10 4 -10 6 0 11 5 11 10 0 6 -2 10 -4 10 -3 0 -8 -4 -11 -10z"/><path d="M1400 1921 c0 -5 7 -14 15 -21 16 -14 18 -10 9 14 -6 17 -24 22 -24 7z"/><path d="M1490 1813 c0 -10 325 -336 340 -341 6 -2 10 -2 10 0 0 2 -79 82 -175 177 -96 95 -175 169 -175 164z"/><path d="M1880 1432 c0 -10 41 -35 47 -28 9 8 -17 36 -33 36 -8 0 -14 -3 -14 -8z"/><path d="M1960 1374 c0 -7 27 -34 34 -34 4 0 1 9 -6 20 -12 19 -28 27 -28 14z"/><path d="M2075 1265 c34 -28 42 -26 23 4 -7 12 -22 21 -33 21 -18 -1 -16 -4 10 -25z"/><path d="M2160 1201 c0 -11 39 -41 53 -41 4 0 0 11 -10 25 -18 24 -43 34 -43 16z"/><path d="M2250 1132 c0 -8 43 -32 55 -32 3 0 -3 9 -12 20 -18 20 -43 27 -43 12z"/><path d="M2342 1068 c6 -16 36 -34 44 -26 8 9 -20 38 -36 38 -6 0 -10 -5 -8 -12z"/><path d="M2420 1014 c15 -17 30 -18 30 -1 0 7 -9 13 -21 14 -17 2 -18 -1 -9 -13z"/><path d="M2476 976 c7 -19 38 -22 32 -3 -3 6 -12 13 -21 15 -12 2 -15 -1 -11 -12z"/><path d="M2552 941 c-10 -6 -7 -12 12 -24 31 -21 36 -21 36 -2 0 8 -6 15 -14 15 -8 0 -16 4 -18 10 -2 5 -9 6 -16 1z"/><path d="M2655 865 c30 -25 47 -28 46 -10 0 6 -9 11 -21 13 -11 2 -20 8 -20 13 0 5 -8 9 -17 9 -14 -1 -11 -6 12 -25z"/><path d="M2730 820 c14 -10 59 -36 100 -58 41 -21 102 -53 135 -70 109 -57 231 -112 248 -112 9 0 19 -4 22 -10 10 -15 35 -12 35 5 0 9 -9 15 -24 15 -14 0 -28 5 -31 10 -3 6 -17 10 -30 10 -12 0 -25 7 -29 15 -3 8 -14 15 -25 15 -11 0 -23 5 -26 10 -3 6 -17 10 -30 10 -12 0 -25 7 -29 15 -3 8 -16 15 -30 15 -13 0 -26 7 -30 15 -3 8 -15 15 -26 15 -11 0 -20 5 -20 10 0 6 -11 10 -24 10 -13 0 -26 7 -30 15 -3 8 -14 15 -25 15 -11 0 -23 5 -26 10 -3 6 -14 10 -25 10 -10 0 -20 7 -24 15 -3 8 -12 15 -21 15 -8 0 -15 5 -15 10 0 6 -10 10 -22 10 -23 0 -23 0 2 -20z"/><path d="M3290 550 c0 -5 8 -10 19 -10 10 0 32 -7 47 -15 33 -17 54 -19 54 -6 0 12 -37 24 -49 17 -5 -3 -11 1 -15 9 -6 17 -56 21 -56 5z"/><path d="M3437 504 c-11 -12 3 -24 29 -24 16 0 24 5 22 13 -5 13 -40 22 -51 11z"/><path d="M3500 472 c0 -10 60 -32 88 -32 11 0 24 -4 27 -10 8 -13 45 -13 45 -1 0 14 -13 20 -49 23 -18 1 -37 8 -43 15 -11 14 -68 18 -68 5z"/><path d="M3680 410 c0 -5 11 -10 25 -10 14 0 28 0 32 -1 4 0 9 4 11 10 2 7 -11 11 -32 11 -20 0 -36 -4 -36 -10z"/><path d="M3765 390 c-3 -6 5 -10 19 -10 14 0 28 -4 31 -10 9 -15 45 -12 45 4 0 23 -82 37 -95 16z"/><path d="M3885 360 c-7 -11 -3 -13 70 -30 28 -6 67 -16 88 -22 20 -6 40 -8 44 -4 13 13 -15 27 -62 32 -27 2 -53 8 -59 13 -18 14 -75 21 -81 11z"/><path d="M4107 304 c-15 -15 7 -24 58 -24 56 0 81 13 42 24 -29 8 -92 8 -100 0z"/><path d="M4240 271 c0 -5 28 -11 63 -14 34 -3 74 -9 90 -13 20 -5 27 -3 27 9 0 8 -7 18 -16 21 -25 9 -164 7 -164 -3z"/><path d="M4459 236 c16 -19 211 -27 211 -10 0 19 -26 24 -127 24 -82 0 -94 -2 -84 -14z"/></g></svg>';
        }
    }
}

// Appels
replaceLoginLogo();

// Dans le MutationObserver
var permanentObserver = new MutationObserver(function() {
    hideClientHeader();
    hideFilterButton();
    hideDemoButton();
    hidePanelTitle();
    replaceLoginLogo();
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
	   BLOC 2 — Setup caisse v5.4.0
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
						toast.style.cssText = 'position:fixed;top:12px;left:75%;transform:translateX(-50%);z-index:9999999;display:none;font-family:-apple-system,sans-serif;';
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

				// ═══════════════════════════════════════════════════════════════
				// v5.4.0 : GESTION CREDENTIALS PAR RÔLE
				// Admin & shop_manager → credentials supprimés = mot de passe requis
				// Caissier → credentials conservés = reste connecté
				// ═══════════════════════════════════════════════════════════════
				var ADMIN_CREDENTIALS_UUID = '3de16a8f-d876-4a95-8a63-421b302c354c';
				var CAISSIER_CREDENTIALS_UUID = '54d06a09-02d0-4515-9888-b1db9c09279a';

				function clearCredentials(uuid) {
					try {
						var request = indexedDB.open('rxdbwcposusers_v2');
						request.onsuccess = function(e) {
							var db = e.target.result;
							if (!db.objectStoreNames.contains('wp_credentials-1')) {
								db.close(); return;
							}
							var tx = db.transaction('wp_credentials-1', 'readwrite');
							var store = tx.objectStore('wp_credentials-1');
							store.delete(uuid);
							tx.oncomplete = function() { db.close(); };
							tx.onerror = function() { db.close(); };
							console.log('[auth] Credentials supprim\u00e9s uuid=' + uuid);
						};
						request.onerror = function() {};
					} catch(e) {}
				}

				function handleAuthCleanup(usr) {
					if (!usr) return;
					var roles = usr.roles || [];
					var isAdminUser = roles.indexOf('administrator') !== -1;
					var isShopManager = roles.indexOf('shop_manager') !== -1;
					
					if (isAdminUser || isShopManager) {
						// Admin & shop manager → mot de passe requis à chaque lancement
						console.log('[auth] Admin/manager d\u00e9tect\u00e9, suppression credentials');
						clearCredentials(ADMIN_CREDENTIALS_UUID);
						clearCredentials(CAISSIER_CREDENTIALS_UUID);
					} else {
						// Caissier → credentials conservés, reste connecté
						console.log('[auth] Caissier d\u00e9tect\u00e9, credentials conserv\u00e9s');
					}
				}

				function initAuth(callback){
					var cached = sessionStorage.getItem('wcpos_can_edit');
					if(cached === 'true'){ callback(true); return; }
					if(cached === 'false'){ callback(false); return; }
					var domLogin = getUserFromDOM();
					if(domLogin){
						rp('/whoami', {client_login: domLogin}, function(usr){
							// v5.4.0 : nettoyage credentials par rôle
							handleAuthCleanup(usr);
							
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
									// v5.4.0 : nettoyage credentials par rôle
									handleAuthCleanup(usr);
									
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
