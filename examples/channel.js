const core = require('../core');

async function start() {
	await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	let addresses = await core.getAddressesInWallet(wallets[0]);

	// -------

	// let channel = await core.startChannel({
	// 	myWalletId: wallets[0],
	// 	myAddress: addresses[0],
	// 	peerAddress: 'VY52VTHNX27WKRGFUGJY7KNTGXP3Z6YU',
	// 	peerDeviceAddress: '0WI73XY6WPR46D4ZKEQEFFQSSPBZMUOVD',
	// 	peerAmount: 10000,
	// 	myAmount: 5000,
	// 	secrets: {'r.2.0.1': 'testpwd', 'r.2.1.1': 'testpwd'}
	// });
	// console.error('shared_address: ', channel.shared_address);
	// console.error('unit: ', channel.unit);

	// -------

	console.error('unit', await core.takeMoneyFromContractUsingSignature(wallets[0], 70000,
		'UDUETIX6ZFWI5KUK6T5IV6UV7Z4WZXSJ', 'Q7NGJ2JNNCRVVY74J3P3YNMEDV76DTRF', []));

	// -------

	// console.error('unit', await core.takeMoneyFromContractUsingSecrets(wallets[0], 1002,
	// 	'XJVVAJMD7K4BFCMIHAOHHQBEY5PVILMG', 'AGRBMP2VVYDGCCJNFFLVUAA6S2FDBWK4', {}));


	return 'ok';
}

start().then(console.log).catch(error => console.error('err', error));