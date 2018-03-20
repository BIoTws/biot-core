const core = require('../core');
const eventBus = require('byteballcore/event_bus');

async function start() {
	await core.init('test');

	eventBus.on('paired', from_address => {
		console.error('paired', from_address);
	});

	eventBus.on('text', (from_address, text) => {
		console.error('text', from_address, ' - ', text)
	});

	await core.addCorrespondent('ApM6ZzpMhnK87Qqz4LhkIHTxGA79VVTVqb1PmtrAzOzo@byteball.org/bb-test#jeYUzsHcWw7a');
	//await core.removeCorrespondent('0WI73XY6WPR46D4ZKEQEFFQSSPBZMUOVD');
	console.error(await core.listCorrespondents());

	return 'ok';
}

start().then(console.log).catch(console.error);