const core = require('../core');
const eventBus = require('ocore/event_bus');

async function start() {
	await core.init('test');

	eventBus.on('paired', from_address => {
		console.error('paired', from_address);
	});

	eventBus.on('text', (from_address, text) => {
		console.error('text', from_address, ' - ', text)
	});

	// await core.addCorrespondent('A1sgbdTdc0FDxI8ZS5cwHIK1iPVk/QXev8ncHmD4BWYi@byteball.org/bb-test#AnKTBIDZWBWf');
	//await core.removeCorrespondent('0WI73XY6WPR46D4ZKEQEFFQSSPBZMUOVD');
	console.error(await core.listCorrespondents());

	return 'ok';
}

start().then(console.log).catch(console.error);