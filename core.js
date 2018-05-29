const fs = require('fs');
const util = require('util');
const conf = require('byteballcore/conf');
const Wallet = require('byteballcore/wallet');
const desktopApp = require('byteballcore/desktop_app');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus');
const walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys');
const ecdsaSig = require('byteballcore/signature.js');
const ecdsa = require('secp256k1');

const Mnemonic = require('bitcore-mnemonic');

const toEs6 = require('./lib/toEs6');
const libKeys = require('./lib/keys');
const libWallet = require('./lib/wallet');
const libAddress = require('./lib/address');
const libTransactions = require('./lib/transactions');
const libCorrespondents = require('./lib/correspondents');
const libSqliteMigrations = require('./lib/sqlite_migrations');

const appDataDir = desktopApp.getAppDataDir();

const protocolVersion = '0.1';

let xPrivKey;

process.on('unhandledRejection', up => { throw up; });

function replaceConsoleLog() {
	let log_filename = conf.LOG_FILENAME || (appDataDir + '/log.txt');
	let writeStream = fs.createWriteStream(log_filename);
	console.log('---------------');
	console.log('From this point, output will be redirected to ' + log_filename);
	console.log("To release the terminal, type Ctrl-Z, then 'bg'");
	console.log = function () {
		writeStream.write(Date().toString() + ': ');
		writeStream.write(util.format.apply(null, arguments) + '\n');
	};
	console.warn = console.log;
	console.info = console.log;
}

/**
 @async
 @description Core initializing
 @param {string} passphrase Passphrase to unlock your account
 @return {string} Status
 @example
 await core.init('test')
 */
exports.init = async (passphrase) => {
	let keys = await libKeys.readKeys(passphrase);
	let saveTempKeys = (new_temp_key, new_prev_temp_key, onDone) => {
		libKeys.writeKeys(keys.mnemonic_phrase, new_temp_key, new_prev_temp_key, onDone).catch(Promise.reject);
	};

	let mnemonic = new Mnemonic(keys.mnemonic_phrase);
	xPrivKey = mnemonic.toHDPrivateKey(passphrase);
	libKeys.setXPrivKey(xPrivKey);

	let devicePrivKey = xPrivKey.derive("m/1'").privateKey.bn.toBuffer({size: 32});

	let device = require('byteballcore/device');
	device.setDevicePrivateKey(devicePrivKey);
	let my_device_address = device.getMyDeviceAddress();

	if (conf.permanent_pairing_secret)
		db.query(
			"INSERT " + db.getIgnore() + " INTO pairing_secrets (pairing_secret, is_permanent, expiry_date) VALUES (?, 1, '2038-01-01')",
			[conf.permanent_pairing_secret]
		);

	device.setTempKeys(keys.deviceTempPrivKey, keys.devicePrevTempPrivKey, saveTempKeys);
	device.setDeviceName(conf.deviceName);
	device.setDeviceHub(conf.hub);

	let my_device_pubkey = device.getMyDevicePubKey();
	console.log("====== my device address: " + my_device_address);
	console.log("====== my device pubkey: " + my_device_pubkey);
	if (conf.permanent_pairing_secret)
		console.log("====== my pairing code: " + my_device_pubkey + "@" + conf.hub + "#" + conf.permanent_pairing_secret);
	if (conf.bLight) {
		let light_wallet = require('byteballcore/light_wallet');
		light_wallet.setLightVendorHost(conf.hub);
	}
	await libSqliteMigrations.migrateDb();
	eventBus.emit('headless_wallet_ready');

	if (!process.env.DEBUG) {
		replaceConsoleLog();
	}

	return 'Initialized successfully';
};

/**
 @async
 @description Getting list of wallets
 @return {string[]} Wallets list
 @example
 await core.getWallets()
 */
async function getWallets() {
	let rows = await toEs6.dbQuery("SELECT wallet FROM wallets");
	return rows.map(row => row.wallet);
}

async function getMyDeviceWallets() {
	let device = require('byteballcore/device')
	let rows = await toEs6.dbQuery("SELECT wallet FROM wallets JOIN wallet_signing_paths USING(wallet) WHERE device_address = ?",
		[device.getMyDeviceAddress()]);
	return rows.map(row => row.wallet);
}

/**
 @async
 @description Getting list of addresses
 @param {string} walletId Wallet id
 @return {string[]} Addresses list
 @example
 await core.getAddressesInWallet('yXSWvqast2rrmwcR/f5QfUAXZLwaaiRvwE+N9whoZLc=')
 */
async function getAddressesInWallet(walletId) {
	let rows = await toEs6.dbQuery("SELECT address FROM my_addresses WHERE wallet = ?", [walletId]);
	return rows.map(row => row.address);
}

/**
 @async
 @description Creating new wallet
 @return {string} walletId
 @example
 await core.createNewWallet()
 */
async function createNewWallet() {
	let rows = await toEs6.dbQuery("SELECT wallet FROM wallets");
	let walletId = await libWallet.createWallet(xPrivKey, rows.length);
	return walletId;
}

/**
 @description Creating new address
 @param {string} walletId Wallet id
 @return {Promise.<string>} Address
 @example
 await core.createNewAddress('yXSWvqast2rrmwcR/f5QfUAXZLwaaiRvwE+N9whoZLc=')
 */
function createNewAddress(walletId) {
	return new Promise(resolve => {
		walletDefinedByKeys.issueNextAddress(walletId, 0, function (addressInfo) {
			return resolve(addressInfo.address);
		});
	});
}

/**
 @description Getting balance of wallet
 @param {string} walletId Wallet id
 @return {Object} Balance
 @example
 await core.getWalletBalance('yXSWvqast2rrmwcR/f5QfUAXZLwaaiRvwE+N9whoZLc=')
 */
function getWalletBalance(walletId) {
	return new Promise(resolve => {
		Wallet.readBalance(walletId, (balance) => {
			return resolve(balance);
		})
	});
}

/**
 @async
 @description Getting balance of address
 @param {string} address Byteball address
 @return {Object} Balance
 @example
 await core.getAddressBalance('VY52VTHNX27WKRGFUGJY7KNTGXP3Z6YU')
 */
async function getAddressBalance(address) {
	return libAddress.getAddressBalance(address);
}

/**
 @description Sending text message to device address
 @param {string} device_address Device address
 @param {string} text Message text
 @example
 core.sendTextMessageToDevice('0PZT5VOY5AINZKW2SJ3Z7O4IDQNKPV364', 'Hello!')
 */
function sendTextMessageToDevice(device_address, text) {
	let device = require('byteballcore/device');
	device.sendMessageToDevice(device_address, 'text', text);
}

/**
 @description Sending tech message to device address
 @param {string} device_address Device address
 @param {object} object Object
 @example
 core.sendTechMessageToDevice('0PZT5VOY5AINZKW2SJ3Z7O4IDQNKPV364', {version: '0.1'})
 */
function sendTechMessageToDevice(device_address, object, callback) {
	let device = require('byteballcore/device');
	object.version = protocolVersion;
	object.app = 'BIoT';
	device.sendMessageToDevice(device_address, 'text', JSON.stringify(object), callback);
}

/**
 @description Sending payment from wallet
 @param {Object} options Payment options
 @param {string} options.asset Payment asset
 @param {string} options.wallet Wallet from which goes payment
 @param {string} options.toAddress Address on which you send the payment
 @param {number} options.amount Payment amount
 @param {string} options.changeAddress Your new address after the payment
 @param {string|null} options.deviceAddress Device address on what will be sent notification
 @return {Promise.<string>} unit
 @example
 core.sendTransaction({
		asset: 'base',
		wallet: 'yXSWvqast2rrmwcR/f5QfUAXZLwaaiRvwE+N9whoZLc=',
		toAddress: 'VY52VTHNX27WKRGFUGJY7KNTGXP3Z6YU',
		amount: 10,
		changeAddress: 'IZHG7LKW2FJ2KAUHL4RRPY3JG2HNVNPD',
		deviceAddress: null
	});
 */
function sendPaymentFromWallet(options) {
	return libTransactions.sendPaymentFromWallet(options);
}

function sendPaymentFromWalletUseUnstableUnits(options) {
	return libTransactions.sendPaymentFromWalletUseUnstableUnits(options);
}

/**
 @description Getting list of transactions by wallet.
 @param {string} walletId Wallet id
 @return {Promise.<Object>} history
 @example
 core.getListTransactionsForWallet('yXSWvqast2rrmwcR/f5QfUAXZLwaaiRvwE+N9whoZLc=');
 */
function getListTransactionsForWallet(walletId) {
	return new Promise(resolve => {
		Wallet.readTransactionHistory({wallet: walletId}, resolve);
	})
}

/**
 @description Getting list of transactions by address.
 @param {string} address Byteball address
 @return {Promise.<Object>} history
 @example
 core.getListTransactionsForAddress('IZHG7LKW2FJ2KAUHL4RRPY3JG2HNVNPD');
 */
function getListTransactionsForAddress(address) {
	return new Promise(resolve => {
		Wallet.readTransactionHistory({address}, resolve);
	})
}

/**
 * @typedef {Object} AddressInfo
 * @property {number} account
 * @property {number} is_change
 * @property {number} address_index
 */

/**
 @async
 @description Getting address info
 @param {string} address Byteball address
 @return {AddressInfo} address info
 @example
 await core.myAddressInfo('IZHG7LKW2FJ2KAUHL4RRPY3JG2HNVNPD');
 */
function myAddressInfo(address) {
	return libAddress.myAddressInfo(address);
}

/**
 * @typedef {Object} Sign
 * @property {string} sign
 * @property {string} pub_b64
 */

/**
 @description Signing device private key
 @param {string} hash Hash string
 @return {Sign} sign object
 @example
 core.signDevicePrivateKey('IZHG7LKW2FJ2KAUHL4RRPY3JG2HNVNPD');
 */
function signDevicePrivateKey(hash) {
	let device = require('byteballcore/device');
	let devicePrivKey = xPrivKey.derive("m/1'").privateKey.bn.toBuffer({size: 32});

	return {sign: ecdsaSig.sign(hash, devicePrivKey), pub_b64: device.getMyDevicePubKey()};
}


/**
 @description Signing with address (watch: myAddressInfo)
 @param {number} account
 @param {number} is_change
 @param {number} address_index
 @param {string} hash Hash string
 @return {Sign} sign object
 @example
 core.signWithAddress(0, 0, 0, 'IZHG7LKW2FJ2KAUHL4RRPY3JG2HNVNPD');
 */
function signWithAddress(account, is_change, address_index, hash) {
	let path = "m/44'/0'/" + account + "'/" + is_change + "/" + address_index;
	let privateKey = xPrivKey.derive(path).privateKey;
	let privKeyBuf = privateKey.bn.toBuffer({size: 32}); // https://github.com/bitpay/bitcore-lib/issues/47
	let pubKeyb64 = ecdsa.publicKeyCreate(privKeyBuf, true).toString('base64')
	return {sign: ecdsaSig.sign(hash, privKeyBuf), pub_b64: pubKeyb64};
}

/**
 @description Sign verification
 @param {string} hash Hash string
 @param {string} b64_sig Sign.sign
 @param {string} b64_pub_key Sign.pub_b64
 @return {boolean} Verification result
 @example
 core.verifySign('IZHG7LKW2FJ2KAUHL4RRPY3JG2HNVNPD', '/J6Gv9aT8KSgEP2TwmNoQ2W/JmZXYaXBLt4zBE8Po5Vm8TOX+fu53Y7DSYtuH/61EgR7WP5Spk76J8gFTCmPpg==', 'A4QdpqFIqVbyCXgbuzlHEMl+1osh2hGC3oVRzHU1V5V0');
 */
function verifySign(hash, b64_sig, b64_pub_key) {
	return ecdsaSig.verify(hash, b64_sig, b64_pub_key);
}

/**
 @description Add a correspondent
 @param {string} code Pairing code
 @example
 await core.addCorrespondent('ApM6ZzpMhnK87Qqz4LhkIHTxGA79VVTVqb1PmtrAzOzo@byteball.org/bb-test#O3IZDFeH4SR0');
 */
function addCorrespondent(code) {
	return libCorrespondents.add(code);
}

/**
 @description Remove a correspondent
 @param {string} device_address Device address
 @example
 await core.removeCorrespondent('0WI73XY6WPR46D4ZKEQEFFQSSPBZMUOVD');
 */
function removeCorrespondent(device_address) {
	return libCorrespondents.remove(device_address);
}

/**
 @description List of correspondents
 @return {Array.<Object>} list
 @example
 await core.listCorrespondents()
 */
function listCorrespondents() {
	return libCorrespondents.list();
}


exports.createNewWallet = createNewWallet;
exports.getWallets = getWallets;
exports.getMyDeviceWallets = getMyDeviceWallets;
exports.getAddressesInWallet = getAddressesInWallet;
exports.createNewAddress = createNewAddress;
exports.getWalletBalance = getWalletBalance;
exports.getAddressBalance = getAddressBalance;
exports.sendTextMessageToDevice = sendTextMessageToDevice;
exports.sendTechMessageToDevice = sendTechMessageToDevice;
exports.sendPaymentFromWallet = sendPaymentFromWallet;
exports.sendPaymentFromWalletUseUnstableUnits = sendPaymentFromWalletUseUnstableUnits;
exports.getListTransactionsForAddress = getListTransactionsForAddress;
exports.getListTransactionsForWallet = getListTransactionsForWallet;
exports.myAddressInfo = myAddressInfo;
exports.signDevicePrivateKey = signDevicePrivateKey;
exports.signWithAddress = signWithAddress;
exports.verifySign = verifySign;
exports.addCorrespondent = addCorrespondent;
exports.removeCorrespondent = removeCorrespondent;
exports.listCorrespondents = listCorrespondents;
