const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	console.error('wallets', wallets);

	let addresses = await core.getAddressesInWallet(wallets[0]);
	console.error(wallets[0], ' - ', addresses);

	let unit = await core.sendPaymentFromWallet({
		asset: 'base',
		wallet: wallets[0],
		toAddress: addresses[0],
		amount: 1,
		changeAddress: addresses[0],
		deviceAddress: null
	});
	console.error('Unit:', unit);

	return 'ok';
}

start().then(console.log).catch(console.error);