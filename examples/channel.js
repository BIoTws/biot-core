const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getWallets();
	let addresses = await core.getAddressesInWallet(wallets[0]);

	// -------

	let channel = await core.startChannel({
		myWalletId: wallets[0],
		myAddress: addresses[0],
		peerAddress: 'VY52VTHNX27WKRGFUGJY7KNTGXP3Z6YU',
		peerDeviceAddress: '0WI73XY6WPR46D4ZKEQEFFQSSPBZMUOVD',
		peerAmount: 10000,
		myAmount: 5000,
	 secrets: {'pass1': 'testpwd'}
	});
	console.error('shared_address: ', channel.shared_address);
	console.error('unit: ', channel.unit);

	// -------

	// console.error('unit', await core.takeMoneyFromContractUsingSignature(wallets[0], 1000,
	// 	'4ICGDPIPMIXAJKD4RRKNMST6PJ4WMIBJ', addresses[0], ['0WI73XY6WPR46D4ZKEQEFFQSSPBZMUOVD']));

	// -------

	// console.error('unit', await core.takeMoneyFromContractUsingSecrets(wallets[0], 1000,
	// 	'4ICGDPIPMIXAJKD4RRKNMST6PJ4WMIBJ', addresses[0], {'pass1': 'testpwd'}));


	return 'ok';
}

start().then(console.log).catch(error => console.error('err', error));