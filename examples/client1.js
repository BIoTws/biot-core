const core = require('../core');
const eventBus = require('byteballcore/event_bus');
const composer = require('byteballcore/composer');
const Wallet = require('byteballcore/wallet');
const wallet = require('../lib/wallet');
const address = require('../lib/address');
const db = require('byteballcore/db');
const ecdsaSig = require('byteballcore/signature.js');
const conf = require('byteballcore/conf');
const crypto = require('crypto');

let xPrivKey;

async function start() {
	let device = require('byteballcore/device');

	xPrivKey = await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	let addresses = await address.getNonEmptyAddressesInWallet(wallets[0]);

	let objMyContract, objPeerContract;

	const correspondent = '0ER62QXE74WFU7ZVYFSJVJBLHVUPBO3Y4';

	let a_pay = 10000;
	let b_pay = 5000;

	eventBus.on('text', async (from_address, text) => {
		let object = JSON.parse(text);
		if (object.step === 2) {
			objPeerContract = object.contract;
			objMyContract = await createContract({a_pay, b_pay, my_address: object.my_address}, from_address);

			console.error('!============-========');
			console.error('peerContract', objPeerContract);
			console.error('============-========');
			console.error('myContract', objMyContract);
			console.error('$============-========');
			core.sendTechMessageToDevice(correspondent, {
				version: '0.1',
				step: 3,
				contract: objMyContract
			});
		}
		else if (object.step === 4) {
			if (object.status === 'approve') {
				console.error('ok :)', object);
				await wallet.addIfNotExistRemoteWallet(object.objWalletRows);
				await address.addIfNotExistRemoteAddresses(object.arrAddressesRows);
				await createChannel(from_address, object);
			} else {
				console.error('cancel');
			}
		}
		console.error('text', from_address, ' - ', object);
	});

	function hello() {
		core.sendTechMessageToDevice(correspondent, {version: '0.1', step: 1, a_pay, b_pay, my_address: addresses[0]});
	}

	function signWithLocalPrivateKey(wallet_id, account, is_change, address_index, text_to_sign, handleSig) {
		let path = "m/44'/0'/" + account + "'/" + is_change + "/" + address_index;
		let privateKey = xPrivKey.derive(path).privateKey;
		let privKeyBuf = privateKey.bn.toBuffer({size: 32}); // https://github.com/bitpay/bitcore-lib/issues/47
		handleSig(ecdsaSig.sign(text_to_sign, privKeyBuf));
	}

	async function createChannel(device_address, object) {
		let device = require('byteballcore/device');
		let network = require('byteballcore/network');
		let my_witnesses = require('byteballcore/my_witnesses');
		let objSharedAddress = await createSharedAddress({
			a_pay,
			b_pay,
			my_address: object.myPayingAddresses[0],
			peerDeviceAddress: device_address
		});

		my_witnesses.readMyWitnesses((arrWitnesses) => {
			network.requestFromLightVendor(
				'light/get_parents_and_last_ball_and_witness_list_unit',
				{witnesses: arrWitnesses},
				(ws, request, response) => {
					console.error('arrdresses', addresses, response.last_stable_mc_ball_mci);
					composer.pickDivisibleCoinsForAmount(db, {asset: null}, addresses, response.last_stable_mc_ball_mci, a_pay, false,
						async (arrInputsWithProofs, _total_input) => {
							console.error('arrINPWP', arrInputsWithProofs);
							let inputs = arrInputsWithProofs.map(function (objInputWithProof) { return objInputWithProof.input;});
							console.error('arrINP', inputs, _total_input)
							let myPayingAddresses = await address.getAddressesOfUnits(inputs.map(input => input.unit))
							let opts = {};
							opts.lightProps = response;
							opts.paying_addresses = myPayingAddresses.concat(object.myPayingAddresses);
							opts.inputs = inputs.concat(object.inputs);
							opts.input_amount = _total_input + object.total_input;
							opts.outputs = [{
								address: objSharedAddress.shared_address,
								amount: a_pay + b_pay
							}, {
								address: object.myPayingAddresses[0],
								amount: object.total_input - b_pay
							}, {
								address: myPayingAddresses[0],
								amount: 0
							}];
							opts.signer = Wallet.getSigner(opts, [device.getMyDeviceAddress()], signWithLocalPrivateKey, false);
							opts.callbacks = {
								ifError: (err) => {
									console.error('_err', err);
								},
								ifNotEnoughFunds: (err) => {
									console.error('_ifNotEnoughFunds', err);
								},
								ifOk: (objJoint, assocPrivatePayloads) => {
									network.broadcastJoint(objJoint);
									console.error('_objJoint', objJoint);
									console.error('_assocPrivatePayloads', assocPrivatePayloads)
								}
							};

							opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
							console.error('opts', opts);
							composer.composeJoint(opts);
						})
				}
			);
		})
	}

	function createContract(object, peerDeviceAddress) {
		return new Promise((resolve, reject) => {
			let timeout = Date.now() + Math.round(0.1 * 3600 * 1000);
			let arrDefinition = ['or', [
				['and', [
					['or', [
						['address', addresses[0]],
						['address', object.my_address]
					]],
					['in data feed', [[conf.TIMESTAMPER_ADDRESS], 'timestamp', '>', timeout]],
					['has', {
						what: 'output',
						asset: 'base',
						address: addresses[0],
						amount: object.a_pay
					}],
					['has', {
						what: 'output',
						asset: 'base',
						address: object.my_address,
						amount: object.b_pay
					}]
				]],
				['and', [
					['address', object.my_address],
					['hash', {hash: 'hash'}]
				]]
			]];

			let assocSignersByPath = {
				'r.0.0.0': {
					address: addresses[0],
					member_signing_path: 'r',
					device_address: device.getMyDeviceAddress()
				},
				'r.0.0.1': {
					address: object.my_address,
					member_signing_path: 'r',
					device_address: peerDeviceAddress
				},
				'r.1.0': {
					address: object.my_address,
					member_signing_path: 'r',
					device_address: peerDeviceAddress
				},
				'r.1.1': {
					address: 'secret',
					member_signing_path: 'r',
					device_address: peerDeviceAddress
				}
			};

			let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
			walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
				ifError: (err) => {
					console.error('erra', err);
					return reject(err);
				},
				ifOk: async (shared_address) => {
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}

	function createSharedAddress(object) {
		return new Promise((resolve, reject) => {
			let arrDefinition = ['or', [
				['and', [
					['address', addresses[0]],
					['address', object.my_address]
				]],
				['and', [
					['address', addresses[0]],
					['has', {
						what: 'output',
						asset: 'base',
						address: objMyContract.shared_address,
						amount: object.a_pay + object.b_pay
					}]
				]],
				['and', [
					['address', object.my_address],
					['has', {
						what: 'output',
						asset: 'base',
						address: objPeerContract.shared_address,
						amount: object.a_pay + object.b_pay
					}]
				]]
			]];

			let assocSignersByPath = {
				'r.0.0': {
					address: addresses[0],
					member_signing_path: 'r',
					device_address: device.getMyDeviceAddress()
				},
				'r.0.1': {
					address: object.my_address,
					member_signing_path: 'r',
					device_address: object.peerDeviceAddress
				},
				'r.1.0': {
					address: addresses[0],
					member_signing_path: 'r',
					device_address: device.getMyDeviceAddress()
				},
				'r.2.0': {
					address: object.my_address,
					member_signing_path: 'r',
					device_address: object.peerDeviceAddress
				}
			};

			let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
			console.error('dbg', 'SharedAddress', arrDefinition, assocSignersByPath);
			walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
				ifError: (err) => {
					console.error('erra', err);
					return reject(err);
				},
				ifOk: async (shared_address) => {
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}

	hello();

	return 'ok';
}

start().then(console.log).catch(console.error);