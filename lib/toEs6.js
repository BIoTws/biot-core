const fs = require('fs');
const db = require('byteballcore/db.js');

module.exports = {
	dbQuery: async (query, params = []) => {
		return new Promise((resolve) => {
			db.query(query, params, resolve);
		});
	},
	fsAccess: async (path, mode) => {
		return new Promise((resolve) => {
			fs.access(path, mode, err => {
				if (err) {
					return resolve(false);
				} else {
					return resolve(true);
				}
			});
		});
	},
	fsMkdir: async (path) => {
		return new Promise((resolve, reject) => {
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