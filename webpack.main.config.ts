import path from 'path';

import { rules } from './webpack.rules';

import type { WebpackConfiguration } from '@electron-forge/plugin-webpack/dist/Config';

export const mainConfig: WebpackConfiguration = {
	stats: 'errors-only',
	entry: './src/index.ts',
	module: {
		rules,
	},
	resolve: {
		extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
		alias: {
			/* Mock rxdb-premium — le bundle dist/ contient déjà le code compilé */
			'rxdb-premium/plugins/storage-filesystem-node': path.resolve(
				__dirname,
				'src/mocks/rxdb-premium-mock.ts'
			),
			'rxdb-premium/plugins/shared': path.resolve(
				__dirname,
				'src/mocks/rxdb-premium-mock.ts'
			),
			'rxdb-premium': path.resolve(
				__dirname,
				'src/mocks/rxdb-premium-mock.ts'
			),
		},
	},
	target: 'electron-main',
	externals: ['aws-sdk', 'mock-aws-s3', 'nock'],
};
