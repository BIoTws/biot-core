const Wallet = require('byteballcore/wallet');
const ecdsaSig = require('byteballcore/signature.js');

let xPrivKey;

function setXPrivKey(_xPrivKey) {
	xPrivKey = _xPrivKey
}

function signWithLocalPrivateKey(wallet_id, account, is_change, address_index, text_to_sign, handleSig) {
	let path = "m/44'/0'/" + account + "'/" + is_change + "/" + address_index;
	let privateKey = xPrivKey.derive(path).privateKey;
	let privKeyBuf = privateKey.bn.toBuffer({size: 32}); // https://github.com/bitpay/bitcore-lib/issues/47
	handleSig(ecdsaSig.sign(text_to_sign, privKeyBuf));
}

function sendPaymentFromWallet(options) {
	return new Promise((resolve, reject) => {
		let device = require('byteballcore/device.js');
		Wallet.sendPaymentFromWallet(
			options.asset, options.wallet, options.toAddress, options.amount, options.changeAddress,
			[], options.deviceAddress,
			signWithLocalPrivateKey,
			function (err, unit, assocMnemonics) {
				if (err) {
					return reject(err)
				} else {
					if (options.deviceAddress) {
						if (err)
							device.sendMessageToDevice(options.device_address, 'text', "Failed to pay: " + err);
						else
							device.sendMessageToDevice(options.device_address, 'text', "paid");
					}
					return resolve(unit)
				}
			}
		);
	})
}


exports.setXPrivKey = setXPrivKey;
exports.sendPaymentFromWallet = sendPaymentFromWallet;
