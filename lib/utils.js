const fs = require('fs');
const toEs6 = require('./toEs6');

async function createFolderIfNotExist(path) {
	let exist = await toEs6.fsAccess(path, fs.constants.R_OK | fs.constants.W_OK);
	if (exist) {
		return Promise.resolve();
	} else {
		toEs6.fsMkdir(path).then(Promise.resolve).catch(Promise.reject);
	}
}

exports.createFolderIfNotExist = createFolderIfNotExist;