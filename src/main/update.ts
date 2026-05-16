import { app, dialog, MenuItem } from 'electron';

import { logger } from './log';
import { t } from './translations';
import { getMainWindow } from './window';

/**
 * AutoUpdater désactivé — fork WCPOS Custom.
 * Toutes les vérifications de mise à jour vers updates.wcpos.com sont supprimées.
 */
export class AutoUpdater {

	public init(): void {
		logger.info('Auto-update désactivé (WCPOS Custom)');
	}

	public async checkForUpdates(_manual = false): Promise<false> {
		return false;
	}

	public async manualCheckForUpdates(menuItem: MenuItem): Promise<void> {
		if (menuItem) menuItem.enabled = false;
		const win = getMainWindow();
		if (win) {
			await dialog.showMessageBox(win, {
				title: t('update.no_updates'),
				message: `WCPOS Custom ${app.getVersion()} — Mises à jour désactivées.`,
			});
		}
		if (menuItem) menuItem.enabled = true;
	}
}

export const updater = new AutoUpdater();
