const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getWallets();
	console.error('wallets', wallets);

	let addresses = await core.getAddressesInWallet(wallets[1]);
	console.error(wallets[0], ' - ', addresses);

	//let transactions = await core.getListTransactionsForWallet(wallets[0]);
	let transactions = await core.getListTransactionsForAddress(addresses[0]);
	console.error('transactions', transactions)


	return 'ok';
}

start().then(console.log).catch(console.error);