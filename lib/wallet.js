const Bitcore = require('bitcore-lib');

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

exports.createWallet = createWallet;