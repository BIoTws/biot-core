const core = require('../core');
const eventBus = require('byteballcore/event_bus');

async function start() {
	await core.init('test');

	let wallets = await core.getMyDeviceWallets();
	let addresses = await core.getAddressesInWallet(wallets[0]);
	console.error('addresses: ', addresses);

	eventBus.on('paired', from_address => {
		console.error('paired', from_address);
	});

	eventBus.on('new_my_transactions', arrUnits => {
		console.error('new_my_transactions units: ', arrUnits);
		console.error('Awaiting stable...');
	});

	eventBus.on('my_transactions_became_stable', arrUnits => {
		console.error('Stable units', arrUnits);
	});


	eventBus.on('text', (from_address, text) => {
		if (text.match(/To receive free bytes/)) {
			core.sendTextMessageToDevice(from_address, addresses[0]);
			console.error('sent', addresses[0]);
			console.error('Awaiting response...');
		} else {
			console.error('text', from_address, ' - ', text)
		}
	});

	await core.addCorrespondent('AxBxXDnPOzE/AxLHmidAjwLPFtQ6dK3k70zM0yKVeDzC@byteball.org/bb-test#0000');

	return 'ok';
}

start().then(console.error).catch(console.error);