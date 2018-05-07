const core = require('../core');
const address = require('../lib/address');
const db = require('byteballcore/db');
const composer = require('byteballcore/composer');
const my_witnesses = require('byteballcore/my_witnesses');
const Wallet = require('byteballcore/wallet.js');
const ecdsaSig = require('byteballcore/signature.js');

let xPrivKey;

function signWithLocalPrivateKey(wallet_id, account, is_change, address_index, text_to_sign, handleSig) {
	let path = "m/44'/0'/" + account + "'/" + is_change + "/" + address_index;
	let privateKey = xPrivKey.derive(path).privateKey;
	let privKeyBuf = privateKey.bn.toBuffer({size: 32}); // https://github.com/bitpay/bitcore-lib/issues/47
	handleSig(ecdsaSig.sign(text_to_sign, privKeyBuf));
}

async function start() {
	xPrivKey = await core.init('test');
	let network = require('byteballcore/network');
	let device = require('byteballcore/device');

	let wallets = await core.getMyDeviceWallets();
	let addresses = await address.getNonEmptyAddressesInWallet(wallets[0]);
	my_witnesses.readMyWitnesses((arrWitnesses) => {
		network.requestFromLightVendor(
			'light/get_parents_and_last_ball_and_witness_list_unit',
			{witnesses: arrWitnesses},
			(ws, request, response) => {
				composer.pickDivisibleCoinsForAmount(db, {asset: null}, addresses, response.last_stable_mc_ball_mci, 10000, false,
					async (arrInputsWithProofs, _total_input) => {
						let inputs = arrInputsWithProofs.map(function (objInputWithProof) { return objInputWithProof.input;});
						console.error('arrINP', inputs, _total_input)
						let myPayingAddresses = await address.getAddressesOfUnits(inputs.map(input => input.unit))
						let opts = {};
						opts.lightProps = response;
						opts.paying_addresses = myPayingAddresses;
						opts.inputs = inputs;
						opts.inputs.push({
							unit: 'FIMZDm4hqPoRxHxsW287Ph/KQTszcHW31sgCRXNl2rc=',
							message_index: 0,
							output_index: 1
						})
						console.error(opts.inputs);
						opts.input_amount = _total_input + 70000;
						opts.outputs = [{
							address: 'R5YQ7N5N5EDI3CZ24HVKKG6CEUXTDWMT',
							amount: 10000
						}, {address: 'L5TNDO6PAHGCBYZCBNX36LNSZU6DIHNF', amount: 65000}, {
							address: 'FQ24J5MYT4GREGG65LL3X5NTMUWNCIRI',
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
						}

						opts.callbacks = composer.getSavingCallbacks(opts.callbacks)

						composer.composeJoint(opts);
					})
			}
		);
	})
	return 'ok';
}

start().then(console.log).catch(console.error);