const core = require('../core');
const Wallet = require('byteballcore/wallet');
const libKeys = require('../lib/keys');
const libAddress = require('../lib/address');
const libTransactions = require('../lib/transactions');
const composer = require('byteballcore/composer');
const network = require('byteballcore/network');

async function start() {
	await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	console.error('wallets', wallets);

	let addresses = await core.getAddressesInWallet(wallets[0]);
	console.error(wallets[0], ' - ', addresses);

	let amount = 1;

	let objPick = await libTransactions.pickDivisibleCoinsForAmount(null, addresses, amount + 1000); // +1000 - fees
	let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
	let opts = {};
	opts.paying_addresses = myPayingAddresses;
	opts.inputs = objPick.arrInputs;
	opts.input_amount = objPick.total_input;
	opts.outputs = [
		{
			address: addresses[0],
			amount: 1
		},
		{
			address: addresses[0],
			amount: 0
		}];
	opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey, false);
	opts.callbacks = {
		ifError: (err) => {
			console.error(err);
		},
		ifNotEnoughFunds: (err) => {
			console.error(err);
		},
		ifOk: (objJoint) => {
			network.broadcastJoint(objJoint);
			console.error('unit:', objJoint.unit.unit);
		}
	};
	opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
	composer.composeJoint(opts);

	return 'ok';
}

start().then(console.log).catch(console.error);