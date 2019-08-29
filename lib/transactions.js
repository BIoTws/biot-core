const Wallet = require('ocore/wallet');
const composer = require('ocore/composer');
const network = require('ocore/network');
const db = require('ocore/db');
const libToEs6 = require('./toEs6');
const libKeys = require('./keys');
const libTransactions = require('./transactions');
const libAddress = require('./address');
const core = require('../core');

function sendPaymentFromWallet(options) {
	return new Promise((resolve, reject) => {
		let device = require('ocore/device.js');
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

async function sendPaymentUseUnstableUnits(to_address, amount, my_addresses, asset) {
	if (asset === 'base') asset = null;
	return new Promise((resolve, reject) => {
		let opts = {};
		opts.paying_addresses = my_addresses;
		if (asset) {
			opts.asset = asset;
		}
		opts.outputs = [
			{
				address: to_address,
				amount: amount
			},
			{
				address: my_addresses[0],
				amount: 0
			}];
		opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey, false);
		opts.spend_unconfirmed = 'all';
		opts.callbacks = {
			ifError: (err) => {
				return reject(err);
			},
			ifNotEnoughFunds: (err) => {
				return reject(err);
			},
			ifOk: (objJoint) => {
				network.broadcastJoint(objJoint);
				return resolve(objJoint.unit.unit);
			}
		};
		opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
		composer.composeJoint(opts);
	});
}

function sendAssetFromAddress(wallet_id, asset, amount, from_address, to_address, recipient_device_address, arrSigningDeviceAddresses, secrets) {
	return new Promise((resolve, reject) => {
		let device = require('ocore/device.js');
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

async function pickAllDivisibleCoinsFromAddresses(asset, addresses, minAmount) {
	let rows = await libToEs6.dbQuery("SELECT unit, message_index, output_index, amount, blinding, address \n\
		FROM outputs\n\
		CROSS JOIN units USING(unit) \n\
		WHERE address IN(?) AND asset " + (asset ? '=' + db.escape(asset) : 'IS NULL') + " AND is_spent=0 AND sequence='good'\n\
		ORDER BY amount DESC LIMIT 120", [addresses]);
	if (rows.length) {
		let arrInputs = [];
		let total_input = 0;
		let fees = 0;
		for (let i = 0; i < rows.length; i++) {
			fees += 60;
			arrInputs.push({
				unit: rows[i].unit,
				message_index: rows[i].message_index,
				output_index: rows[i].output_index
			});
			total_input += rows[i].amount;
		}
		if (total_input >= minAmount + fees) {
			return {arrInputs, total_input};
		} else {
			return null;
		}
	} else {
		return null;
	}
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
		WHERE address IN(?) AND asset " + (asset ? '=' + db.escape(asset) : 'IS NULL') + " AND is_spent=0 AND sequence='good'\n\
		ORDER BY amount DESC LIMIT 120", [addresses]);
		if (rows.length) {
			let arrInputs = [];
			let total_input = 0;
			let fees = 0;
			for (let i = 0; i < rows.length; i++) {
				fees += 60;
				if (total_input >= amount + fees) {
					break;
				}
				arrInputs.push({
					unit: rows[i].unit,
					message_index: rows[i].message_index,
					output_index: rows[i].output_index
				});
				total_input += rows[i].amount;
			}
			if (total_input >= amount + fees) {
				return {arrInputs, total_input};
			} else {
				return null;
			}
		} else {
			return null;
		}
	}
}

async function getListMyTransactionsFromWallet(walletId) {
	let objTransactions = {};

	let rowsSend = await libToEs6.dbQuery("SELECT outputs.unit, outputs.address, outputs.amount, output_id FROM inputs JOIN my_addresses USING(address) JOIN outputs \n\
		WHERE outputs.unit = inputs.src_unit AND outputs.address = inputs.address AND my_addresses.wallet = ?", [walletId]);
	rowsSend.forEach(row => {
		if (objTransactions[row.unit]) {
			objTransactions[row.unit].amount += row.amount;
		} else {
			objTransactions[row.unit] = {action: 'send', amount: row.amount};
		}
	});

	let rowsReceive = await libToEs6.dbQuery("SELECT unit, outputs.address, amount FROM outputs JOIN my_addresses USING(address)\n\
		WHERE my_addresses.wallet = ?", [walletId]);
	rowsReceive.forEach(row => {
		if (objTransactions[row.unit] && objTransactions[row.unit].action === 'receive') {
			objTransactions[row.unit].amount += row.amount;
		} else {
			objTransactions[row.unit] = {action: 'receive', amount: row.amount};
		}
	});

	return Promise.resolve(objTransactions);
}

function sendMultiPayment(opts) {
	return new Promise((resolve, reject) => {
		const device = require('ocore/device.js');
		const Wallet = require('ocore/wallet.js');
		opts.arrSigningDeviceAddresses = [device.getMyDeviceAddress()];
		opts.signWithLocalPrivateKey = libKeys.signWithLocalPrivateKey;
		Wallet.sendMultiPayment(opts, (err, unit, assocMnemonics) => {
			if (err) return reject(new Error(err));
			return resolve({unit, assocMnemonics});
		});
	});
}

exports.sendPaymentFromWallet = sendPaymentFromWallet;
exports.sendPaymentUseUnstableUnits = sendPaymentUseUnstableUnits;
exports.sendAssetFromAddress = sendAssetFromAddress;
exports.pickDivisibleCoinsForAmount = pickDivisibleCoinsForAmount;
exports.pickAllDivisibleCoinsFromAddresses = pickAllDivisibleCoinsFromAddresses;
exports.getListMyTransactionsFromWallet = getListMyTransactionsFromWallet;
exports.sendMultiPayment = sendMultiPayment;