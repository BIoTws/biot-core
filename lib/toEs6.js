const db = require('byteballcore/db.js');
const _fs = require('./fs');
const isCordova = global.window && window.cordova;

module.exports = {
	dbQuery: async (query, params = []) => {
		return new Promise((resolve) => {
			db.query(query, params, resolve);
		});
	},
	fsAccess: async (path) => {
		return new Promise((resolve) => {
			if (isCordova) {
				return _fs.cordovaExists(path, resolve);
			} else {
				const fs = require('fs' + '');
				fs.access(path, fs.constants.R_OK | fs.constants.W_OK, err => {
					if (err) {
						return resolve(false);
					} else {
						return resolve(true);
					}
				});
			}
		});
	},
	fsMkdir: async (path) => {
		return new Promise((resolve, reject) => {
			const fs = require('fs' + '');
			fs.mkdir(path, err => {
				if (err) {
					return reject(err);
				} else {
					return resolve();
				}
			});
		});
	},
	fsWriteFile: async (path, data, options) => {
		return new Promise((resolve, reject) => {
			const fs = require('fs' + '');
			fs.writeFile(path, data, options, (err) => {
				if (err) {
					return reject(err);
				} else {
					return resolve();
				}
			});
		});
	}
};