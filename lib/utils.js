const toEs6 = require('./toEs6');

async function createFolderIfNotExists(path) {
	let exist = await toEs6.fsAccess(path);
	if (exist) {
		return Promise.resolve();
	} else {
		toEs6.fsMkdir(path).then(Promise.resolve).catch(console.error);
	}
}

exports.createFolderIfNotExists = createFolderIfNotExists;