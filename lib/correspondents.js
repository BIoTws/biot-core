function acceptInvitation(hub_host, device_pubkey, pairing_secret) {
	return new Promise((resolve, reject) => {
		let device = require('ocore/device');

		if (device_pubkey === device.getMyDevicePubKey())
			return reject("cannot pair with myself");

		if (!device.isValidPubKey(device_pubkey))
			return reject("invalid peer public key");

		device.addUnconfirmedCorrespondent(device_pubkey, hub_host, 'New', function (device_address) {
			device.startWaitingForPairing(function (reversePairingInfo) {
				device.sendPairingMessage(hub_host, device_pubkey, pairing_secret, reversePairingInfo.pairing_secret, {
					ifOk: resolve,
					ifError: reject
				});
			});
		});
	});
}

async function add(code) {
	let conf = require('ocore/conf.js');
	let re = new RegExp('^' + conf.program + ':', 'i');
	code = code.replace(re, '');
	let matches = code.match(/^([\w\/+]+)@([\w.:\/-]+)#([\w\/+-]+)$/);
	if (!matches)
		return Promise.reject("Invalid pairing code");
	let pubkey = matches[1];
	let hub = matches[2];
	let pairing_secret = matches[3];
	if (pubkey.length !== 44)
		return Promise.reject("Invalid pubkey length");

	console.log('add correspondent', pubkey, hub, pairing_secret);

	return await acceptInvitation(hub, pubkey, pairing_secret)
}

function remove(device_address) {
	return new Promise((resolve, reject) => {
		const wallet = require('ocore/wallet');
		wallet.determineIfDeviceCanBeRemoved(device_address, function (bRemovable) {
			if (!bRemovable) {
				return reject('device ' + device_address + ' is not removable');
			}

			let device = require('ocore/device.js');
			device.sendMessageToDevice(device_address, "removed_paired_device", "removed");
			device.removeCorrespondentDevice(device_address, function () {
				return resolve();
			});
		});
	});
}

function list() {
	return new Promise(resolve => {
		let device = require('ocore/device.js');
		device.readCorrespondents(resolve);
	});
}

exports.acceptInvitation = acceptInvitation;
exports.add = add;
exports.remove = remove;
exports.list = list;