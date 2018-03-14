const fs = require('fs');
const crypto = require('crypto');
const conf = require('byteballcore/conf.js');
const desktopApp = require('byteballcore/desktop_app.js');
const Mnemonic = require('bitcore-mnemonic');

const toEs6 = require('./toEs6');
const wallet = require('./wallet');
const utils = require('./utils');

const appDataDir = desktopApp.getAppDataDir();
const KEYS_FILENAME = appDataDir + '/' + (conf.KEYS_FILENAME || 'keys.json');

async function isKeysFileExists() {
	return await toEs6.fsAccess(KEYS_FILENAME, fs.constants.R_OK | fs.constants.W_OK);
}

function keysGeneration() {
	let deviceTempPrivKey = crypto.randomBytes(32);
	let devicePrevTempPrivKey = crypto.randomBytes(32);

	let mnemonic = new Mnemonic(); // generates new mnemonic
	while (!Mnemonic.isValid(mnemonic.toString())) {
		mnemonic = new Mnemonic();
	}

	return {mnemonic, deviceTempPrivKey, devicePrevTempPrivKey};
}

async function readKeys(passphrase) {
	let isAccess = await isKeysFileExists();
	if (!isAccess) {
		if (!conf.deviceName) return Promise.reject('Please set deviceName in conf.js');
		let keys = keysGeneration(passphrase);
		await writeKeys(keys.mnemonic.phrase, keys.deviceTempPrivKey, keys.devicePrevTempPrivKey).catch(Promise.reject);
		console.log('keys created');

		let xPrivKey = keys.mnemonic.toHDPrivateKey(passphrase);
		await wallet.createWallet(xPrivKey, 0);

		return Promise.resolve({
			mnemonic_phrase: keys.mnemonic.phrase,
			passphrase: passphrase,
			deviceTempPrivKey: keys.deviceTempPrivKey,
			devicePrevTempPrivKey: keys.devicePrevTempPrivKey
		});
	} else {
		return new Promise((resolve, reject) => {
			fs.readFile(KEYS_FILENAME, 'utf8', async (err, data) => {
				if (err) {
					return reject(err);
				}
				let keys = JSON.parse(data);
				let deviceTempPrivKey = Buffer.from(keys.temp_priv_key, 'base64');
				let devicePrevTempPrivKey = Buffer.from(keys.prev_temp_priv_key, 'base64');
				console.log('keys read');

				let rows = await toEs6.dbQuery("SELECT wallet FROM wallets");
				if (!rows.length) {
					let mnemonic = new Mnemonic(keys.mnemonic_phrase);
					let xPrivKey = mnemonic.toHDPrivateKey(passphrase);
					await wallet.createWallet(xPrivKey, 0);
				}
				return resolve({
					mnemonic_phrase: keys.mnemonic_phrase,
					passphrase: passphrase,
					deviceTempPrivKey,
					devicePrevTempPrivKey
				});
			});
		});
	}
}

async function writeKeys(mnemonic_phrase, deviceTempPrivKey, devicePrevTempPrivKey) {
	let keys = {
		mnemonic_phrase: mnemonic_phrase,
		temp_priv_key: deviceTempPrivKey.toString('base64'),
		prev_temp_priv_key: devicePrevTempPrivKey.toString('base64')
	};

	await utils.createFolderIfNotExist(appDataDir);
	await toEs6.fsWriteFile(KEYS_FILENAME, JSON.stringify(keys, null, '\t'), 'utf8').catch(Promise.reject);
	return true;
}

exports.isKeysFileExists = isKeysFileExists;
exports.readKeys = readKeys;
exports.writeKeys = writeKeys;