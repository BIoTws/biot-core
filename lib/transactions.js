const Wallet = require('byteballcore/wallet');
const db = require('byteballcore/db');
const libToEs6 = require('./toEs6');
const libKeys = require('./keys');

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

async function pickDivisibleCoinsForAmount(asset, addresses, amount) {
	let rows = await libToEs6.dbQuery("SELECT unit, message_index, output_index, amount, blinding, address \n\
		FROM outputs\n\
		CROSS JOIN units USING(unit) \n\
		WHERE address IN(?) AND asset " + (asset ? '=' + db.escape(asset) : 'IS NULL') + " AND is_spent=0 AND amount >= ? AND sequence='good'\n\
		ORDER BY amount LIMIT 1", [addresses, amount]);
	if (rows.length) {
		return {
			arrInputs: [{
				unit: rows[0].unit,
				message_index: rows[0].message_index,
				output_index: rows[0].output_index
			}],
			total_input: rows[0].amount
		};
	} else {
		let rows = await libToEs6.dbQuery("SELECT unit, message_index, output_index, amount, blinding, address \n\
		FROM outputs\n\
		CROSS JOIN units USING(unit) \n\
		WHERE address IN(?) AND asset " + (asset ? '=' + db.escape(asset) : 'IS NULL') + " AND is_spent=0 AND amount >= ? AND sequence='good'\n\
		ORDER BY amount LIMIT 120", [addresses, amount]);
		if (rows.length) {
			let arrInputs = [];
			let total_input = 0;
			for (let i = 0; i < rows.length; i++) {
				if (total_input >= amount) {
					break;
				}
				arrInputs.push({
					unit: rows[i].unit,
					message_index: rows[i].message_index,
					output_index: rows[i].output_index
				});
				total_input += rows[i].amount;
			}
			if (total_input >= amount) {
				return {arrInputs, total_input};
			} else {
				return null;
			}
		} else {
			return null;
		}
	}
}

exports.sendPaymentFromWallet = sendPaymentFromWallet;
exports.sendAssetFromAddress = sendAssetFromAddress;
exports.pickDivisibleCoinsForAmount = pickDivisibleCoinsForAmount;