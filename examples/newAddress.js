const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	console.error('wallets', wallets);

	let addresses = await core.getAddressesInWallet(wallets[0]);
	console.error(wallets[0], ' - ', addresses);

	console.error('Create new address: ', await core.createNewAddress(wallets[0]));

	addresses = await core.getAddressesInWallet(wallets[0]);
	console.error(wallets[0], ' - ', addresses);

	return 'ok';
}

start().then(console.log).catch(console.error);