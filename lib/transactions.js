const Wallet = require('byteballcore/wallet');
const libKeys = require('./keys');

const libOfferContract = require('./offerContract');

function sendPaymentFromWallet(options) {
	return new Promise((resolve, reject) => {
		let device = require('byteballcore/device.js');
		Wallet.sendPaymentFromWallet(
			options.asset, options.wallet, options.toAddress, options.amount, options.changeAddress,
			[], options.deviceAddress,
			libKeys.signWithLocalPrivateKey,
			function (err, unit, assocMnemonics) {
				if (err) {
					return reject(err)
				} else {
					if (options.deviceAddress) {
						if (err)
							device.sendMessageToDevice(options.deviceAddress, 'text', "Failed to pay: " + err);
						else
							device.sendMessageToDevice(options.deviceAddress, 'text', "paid");
					}
					return resolve(unit)
				}
			}
		);
	})
}

function sendAssetFromAddress(wallet_id, asset, amount, from_address, to_address, recipient_device_address, arrSigningDeviceAddresses, secrets) {
	return new Promise((resolve, reject) => {
		let device = require('byteballcore/device.js');
		let opts = {
			fee_paying_wallet: wallet_id,
			asset: asset,
			to_address: to_address,
			amount: amount,
			paying_addresses: [from_address],
			change_address: from_address,
			arrSigningDeviceAddresses: [device.getMyDeviceAddress()],
			recipient_device_address: recipient_device_address,
			signWithLocalPrivateKey: libKeys.signWithLocalPrivateKey
		};
		if (arrSigningDeviceAddresses && arrSigningDeviceAddresses.length) {
			opts.arrSigningDeviceAddresses = opts.arrSigningDeviceAddresses.concat(arrSigningDeviceAddresses);
		}

		if (secrets) {
			opts.secrets = secrets;
		}

		Wallet.sendMultiPayment(opts, (err, unit, assocMnemonics) => {
			if (err) {
				return reject(err);
			} else {
				return resolve(unit)
			}
		});
	});
}

async function startChannel(opts) {
	let device = require('byteballcore/device');
	let contract = await libOfferContract(opts.myWalletId, opts.myAddress, {
		peerAddress: opts.peerAddress,
		peerDeviceAddress: opts.peerDeviceAddress,
		peerAmount: opts.peerAmount,
		myAmount: opts.myAmount,
		asset: 'base',
		secrets: opts.secrets
	});
	device.sendMessageToDevice(opts.peerDeviceAddress, 'text',
		'This is your contract, please check and pay within 15 minutes: ' + contract.paymentRequestText);
	return contract;
}

async function takeMoneyFromContractUsingSignature(walletId, amount, shared_address, to_address, arrSigningDeviceAddresses) {
	return sendAssetFromAddress(walletId, 'base', amount,
		shared_address, to_address, null, arrSigningDeviceAddresses);
}

async function takeMoneyFromContractUsingSecrets(walletId, amount, shared_address, to_address, secrets) {
	return sendAssetFromAddress(walletId, 'base', amount,
		shared_address, to_address, null, null, secrets);
}

exports.sendPaymentFromWallet = sendPaymentFromWallet;
exports.startChannel = startChannel;
exports.takeMoneyFromContractUsingSignature = takeMoneyFromContractUsingSignature;
exports.takeMoneyFromContractUsingSecrets = takeMoneyFromContractUsingSecrets;
exports.sendAssetFromAddress = sendAssetFromAddress;