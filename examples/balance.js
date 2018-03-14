const bbConstatns = require('byteballcore/constants');

const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getWallets();
	console.error('wallets', wallets);

	let addresses = await core.getAddressesInWallet(wallets[0]);
	console.error(wallets[0], ' - ', addresses);

	let walletBalance = await core.getWalletBalance(wallets[0]);
	console.error('Wallet balance: ', wallets[0], ' Bytes:', walletBalance['base']);
	console.error('Wallet balance: ', wallets[0], ' BlackBytes:', walletBalance[bbConstatns.BLACKBYTES_ASSET]);

	let addressBalance = await core.getAddressBalance(addresses[0]);
	console.error('Address Balance: ', addresses[0], addressBalance);

	return 'ok';
}

start().then(console.log).catch(console.error);