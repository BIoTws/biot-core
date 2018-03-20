/*jslint node: true */
'use strict';
const conf = require('byteballcore/conf');
const crypto = require('crypto');

const libAddress = require('./address');
const libTransaction = require('./transactions');

module.exports = (wallet_id, myAddress, contract) => {
	return new Promise((resolve, reject) => {
		let device = require('byteballcore/device.js');

		let defaultContract = {
			timeout: 1,
			myAsset: 'base',
			peerAsset: 'base',
		};

		for (let key in defaultContract) {
			if (contract[key] === undefined) contract[key] = defaultContract[key];
		}

		if (!contract.secrets || !contract.secrets['pass1']) {
			throw Error("now on the other not working :)");
		}

		//if (contract.myAsset === "base") contract.myAmount *= conf.unitValue;
		//if (contract.peerAsset === "base") contract.peerAmount *= conf.unitValue;

		contract.myAmount = Math.round(contract.myAmount);
		contract.peerAmount = Math.round(contract.peerAmount);
		if (contract.myAmount === contract.peerAmount) {
			contract.myAmount += 1;
		}

		let arrSeenCondition = ['seen', {
			what: 'output',
			address: 'this address',
			asset: contract.peerAsset,
			amount: contract.peerAmount
		}];

		let timeout = Date.now() + Math.round(contract.timeout * 3600 * 1000);
		let arrDefinition = ['or', [
			['and', [
				arrSeenCondition,
				['and', [
					['address', myAddress],
					['address', contract.peerAddress]
				]]
			]],
			['and', [
				['address', myAddress],
				['not', arrSeenCondition],
				['in data feed', [[conf.TIMESTAMPER_ADDRESS], 'timestamp', '>', timeout]]
			]],
			['or', [
				['and', [
					['address', myAddress],
					['hash', {hash: crypto.createHash("sha256").update(contract.secrets['pass1'], "utf8").digest("base64")}]
				]],
				['and', [
					['address', contract.peerAddress],
					['hash', {hash: crypto.createHash("sha256").update(contract.secrets['pass1'], "utf8").digest("base64")}]
				]]
			]]
		]];

		let assocSignersByPath = {
			'r.0.1.0': {
				address: myAddress,
				member_signing_path: 'r',
				device_address: device.getMyDeviceAddress()
			},
			'r.0.1.1': {
				address: contract.peerAddress,
				member_signing_path: 'r',
				device_address: contract.peerDeviceAddress
			},
			'r.1.0': {
				address: myAddress,
				member_signing_path: 'r',
				device_address: device.getMyDeviceAddress()
			},
			'r.2.0.0': {
				address: myAddress,
				member_signing_path: 'r',
				device_address: device.getMyDeviceAddress()
			},
			'r.2.0.1': {
				address: 'secret_pass1',
				member_signing_path: 'r',
				device_address: device.getMyDeviceAddress()
			},
			'r.2.1.0': {
				address: contract.peerAddress,
				member_signing_path: 'r',
				device_address: contract.peerDeviceAddress
			},
			'r.2.1.1': {
				address: 'secret_pass1',
				member_signing_path: 'r',
				device_address: contract.peerDeviceAddress
			}

		};

		console.error('contr', assocSignersByPath);

		console.error('device_address', contract.peerDeviceAddress);
		let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
		walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
			ifError: (err) => {
				console.error('erra', err)
				return reject(err);
			},
			ifOk: async (shared_address) => {
				let change_address = await libAddress.issueChangeAddress(wallet_id);
				let unit = await libTransaction.sendPaymentFromWallet({
					asset: contract.myAsset,
					wallet: wallet_id,
					toAddress: shared_address,
					amount: contract.myAmount,
					changeAddress: change_address,
					deviceAddress: contract.peerDeviceAddress
				}).catch(reject);

				let arrPayments = [{
					address: shared_address,
					amount: contract.peerAmount,
					asset: contract.peerAsset
				}];
				let assocDefinitions = {};
				assocDefinitions[shared_address] = {
					definition: arrDefinition,
					signers: assocSignersByPath
				};
				let objPaymentRequest = {payments: arrPayments, definitions: assocDefinitions};
				let paymentJson = JSON.stringify(objPaymentRequest);
				let paymentJsonBase64 = Buffer(paymentJson).toString('base64');
				let paymentRequestCode = 'payment:' + paymentJsonBase64;
				let paymentRequestText = '[your share of payment to the contract](' + paymentRequestCode + ')';
				return resolve({unit, paymentRequestText, shared_address, timeout});
			}
		});
	});
};