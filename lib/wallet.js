const Bitcore = require('bitcore-lib');

const toEs6 = require('./toEs6');
const db = require('byteballcore/db');

function createWallet(xPrivKey, account) {
	return new Promise(resolve => {
		let devicePrivKey = xPrivKey.derive("m/1'").privateKey.bn.toBuffer({size: 32});
		let device = require('byteballcore/device.js');
		device.setDevicePrivateKey(devicePrivKey); // we need device address before creating a wallet
		let strXPubKey = Bitcore.HDPublicKey(xPrivKey.derive("m/44'/0'/" + account + "'")).toString();
		let walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js');
		// we pass isSingleAddress=false because this flag is meant to be forwarded to cosigners and headless wallet doesn't support multidevice
		walletDefinedByKeys.createWalletByDevices(strXPubKey, account, 1, [], 'any walletName', false, (wallet_id) => {
			walletDefinedByKeys.issueNextAddress(wallet_id, 0, () => {
				return resolve(wallet_id);
			});
		});
	});
}

async function getWalletFromDB(walletId) {
	let walletRows = await toEs6.dbQuery("SELECT wallet, account, definition_template FROM wallets WHERE wallet = ?", [walletId]);
	let signingPathRows = await toEs6.dbQuery("SELECT wallet, signing_path, device_address FROM wallet_signing_paths WHERE wallet = ?", [walletId]);
	if (walletRows.length && signingPathRows.length) {
		return {wallet: walletRows[0], signingPath: signingPathRows[0]};
	} else {
		return {};
	}
}

async function addIfNotExistRemoteWallet(objWalletRows) {
	let wallet = objWalletRows.wallet;
	let signingPath = objWalletRows.signingPath;

	await toEs6.dbQuery("INSERT " + db.getIgnore() + " INTO wallets (wallet, account, definition_template, full_approval_date, ready_date) VALUES \n\
		(?,?,?, " + db.getNow() + ", " + db.getNow() + ")",
		[wallet.wallet, wallet.account, wallet.definition_template]);

	await toEs6.dbQuery("INSERT " + db.getIgnore() + " INTO wallet_signing_paths (wallet, signing_path, device_address) VALUES (?,?,?)",
		[signingPath.wallet, signingPath.signing_path, signingPath.device_address]);

	return Promise.resolve();
}

exports.createWallet = createWallet;
exports.getWalletFromDB = getWalletFromDB;
exports.addIfNotExistRemoteWallet = addIfNotExistRemoteWallet;