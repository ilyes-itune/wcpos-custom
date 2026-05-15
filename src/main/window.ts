import * as path from 'path';

import { BrowserWindow, shell } from 'electron';
import serve from 'electron-serve';

import { logger as log } from './log';
import { isDevelopment } from './util';

// Set up electron-serve
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

/* Version affichée dans la barre de titre — modifier à chaque build */
const APP_VERSION = 'WCPOS Custom 1.2';

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

	loadURL(mainWindow);

	/* Injection anti-pubs via executeJavaScript
	 * - did-finish-load + délais progressifs pour les re-renders React
	 * - MutationObserver pour les changements dynamiques
	 * Note : insertCSS ne fonctionne pas sur le schéma wcpos://
	 *        on injecte donc un <style> via JS
	 */
	mainWindow.webContents.on('did-finish-load', () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;

		/* Force le titre après chargement (React peut l'écraser) */
		mainWindow.setTitle(APP_VERSION);

		const js = `
(function() {
  var HIDE = [
    'upgrade-notice-banner',
    'upgrade-title',
    'upgrade-to-pro-button',
    'view-demo-button',
    'add-fee',
    'add-shipping'
  ];

  function hide() {
    /* Masque via setProperty (compatible SES/Lockdown) */
    HIDE.forEach(function(t) {
      document.querySelectorAll('[data-testid="' + t + '"]').forEach(function(el) {
        el.style.setProperty('display', 'none', 'important');
      });
    });

    /* Injecte le CSS dans <head> si pas encore fait */
    if (!document.getElementById('wcpos-anti-pro')) {
      var s = document.createElement('style');
      s.id = 'wcpos-anti-pro';
      s.textContent = [
        '[data-testid="upgrade-notice-banner"]',
        '[data-testid="upgrade-title"]',
        '[data-testid="upgrade-to-pro-button"]',
        '[data-testid="view-demo-button"]',
        '[data-testid="add-fee"]',
        '[data-testid="add-shipping"]'
      ].join(',') + '{display:none!important}';
      document.head.appendChild(s);
    }
  }

  /* Exécution immédiate */
  hide();

  /* Délais progressifs pour attraper les re-renders React */
  [300, 800, 1500, 3000, 5000].forEach(function(ms) {
    setTimeout(hide, ms);
  });

  /* MutationObserver pour les changements dynamiques continus */
  if (window.MutationObserver) {
    new MutationObserver(hide).observe(document.body, {
      childList: true,
      subtree: true
    });
  }
})();
`;

		mainWindow.webContents.executeJavaScript(js).catch((err) => {
			log.error('Anti-pro JS failed:', err);
		});

		log.info('Anti-pro injected — ' + APP_VERSION);
	});

	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) throw new Error('"mainWindow" is not defined');
		if (process.env.START_MINIMIZED) {
			mainWindow.minimize();
		} else {
			mainWindow.show();
		}
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
			if (retryCount >= MAX_RETRIES) {
				log.error('Max retries reached');
				return;
			}
			retryCount++;
			log.info('Dev server not ready, retrying in 2s...');
			setTimeout(() => {
				if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow);
			}, 2000);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
