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
	// In production mode, serve the 'dist' directory from resources
	const pathToDist = path.join(process.resourcesPath, 'dist');
	loadURL = serve({
		directory: pathToDist,
		scheme: 'wcpos',
	});
}

let mainWindow: BrowserWindow | null;

/* ============================================================
 * CSS anti-pubs — masque les éléments Pro identifiés par inspection
 * data-testid confirmés sur WCPOS 1.8.x
 * ============================================================ */
const ANTI_PRO_CSS = `
  [data-testid="upgrade-notice-banner"],
  [data-testid="upgrade-title"],
  [data-testid="upgrade-to-pro-button"],
  [data-testid="view-demo-button"],
  [data-testid="add-fee"],
  [data-testid="add-shipping"] {
    display: none !important;
  }
`;

/* ============================================================
 * JS anti-pubs — MutationObserver pour les re-renders React
 * SES (Lockdown) note : style.setProperty() fonctionne
 * ============================================================ */
const ANTI_PRO_JS = `
(function() {
  var HIDE = [
    'upgrade-notice-banner',
    'upgrade-title',
    'upgrade-to-pro-button',
    'view-demo-button',
    'add-fee',
    'add-shipping'
  ];

  function hideProElements() {
    HIDE.forEach(function(testid) {
      document.querySelectorAll('[data-testid="' + testid + '"]').forEach(function(el) {
        el.style.setProperty('display', 'none', 'important');
      });
    });
  }

  hideProElements();

  if (window.MutationObserver) {
    new MutationObserver(hideProElements)
      .observe(document.body, { childList: true, subtree: true });
  }
})();
`;

export const createWindow = (): void => {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		show: false,
		width: 1024,
		height: 728,
		icon: path.join(__dirname, '../../icons/icon.ico'),
		webPreferences: {
			preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
			sandbox: false, // Required for preload script to work
			nodeIntegration: false,
			contextIsolation: true,
		},
		backgroundColor: '#fff',
	});

	if (isDevelopment) {
		mainWindow.webContents.openDevTools();
	}

	// Load the application
	loadURL(mainWindow);

	// ── Injection CSS/JS anti-pubs après chaque chargement de page ──────────
	mainWindow.webContents.on('did-finish-load', () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;

		// Injecte le CSS
		mainWindow.webContents.insertCSS(ANTI_PRO_CSS).catch((err) => {
			log.error('insertCSS failed:', err);
		});

		// Injecte le JS
		mainWindow.webContents.executeJavaScript(ANTI_PRO_JS).catch((err) => {
			log.error('executeJavaScript failed:', err);
		});

		log.info('Anti-pro CSS/JS injected');
	});

	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) {
			throw new Error('"mainWindow" is not defined');
		}
		if (process.env.START_MINIMIZED) {
			mainWindow.minimize();
		} else {
			mainWindow.show();
		}
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	// Open external URLs in the user's default browser
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		log.info(`Opening in external browser: ${url}`);
		shell.openExternal(url);
		return { action: 'deny' };
	});

	// Handle failed loads
	let retryCount = 0;
	const MAX_RETRIES = 30;

	mainWindow.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
		log.error(`did fail load with code ${errorCode}: ${errorDescription}`);
		if (errorDescription === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= MAX_RETRIES) {
				log.error('Max retries reached, giving up on dev server connection');
				return;
			}
			retryCount++;
			log.info('Dev server not ready, retrying in 2s...');
			setTimeout(() => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					loadURL(mainWindow);
				}
			}, 2000);
		} else {
			log.error(`Load failed without retry: ${errorDescription}`);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => {
	return mainWindow;
};
