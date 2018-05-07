const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	console.error('wallets', wallets);

	console.error('New walletId: ', await core.createNewWallet())

	wallets = await core.getMyDeviceWallets();
	console.error('wallets', wallets);

	return 'ok';
}

start().then(console.log).catch(console.error);