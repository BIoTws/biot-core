const core = require('../core');
const Channel = require('../lib/Channel');
const ChannelsManager = require('../lib/ChannelsManager');

async function start() {
	await core.init('test');
	const device = require('byteballcore/device');
	let wallets = await core.getMyDeviceWallets();
	let myDeviceAddress = device.getMyDeviceAddress();
	let channel;

	const channelsManager = new ChannelsManager(wallets[0]);

	let list = await channelsManager.list();
	if (list.length) {
		channel = channelsManager.recoveryChannel(list[0]);
		channel.events.on('error', error => {
			console.error('channelError', channel.id, error);
		});
		channel.events.on('start', async () => {
			console.error('channel start. t.js', channel.id);
			console.error('info', channel.info());
		});
		channel.events.on('changed_step', (step) => {
			console.error('changed_step: ', step);
		});
		channel.events.on('new_transfer', (amount) => {
			console.error('new_transfer: ', amount);
		});
		await channel.init();
		console.error('transfer', await channel.transfer(500));
		// console.error(await channel.closeNow());
		console.error('info', channel.info());
	} else {
		let channel = new Channel(wallets[0], myDeviceAddress, '0ER62QXE74WFU7ZVYFSJVJBLHVUPBO3Y4', null, 6000, 5000, 10);
		channel.events.on('error', error => {
			console.error('channelError', channel.id, error);
		});
		channel.events.on('start', async () => {
			console.error('channel start. t.js', channel.id);
			console.error('info', channel.info());
			// console.error('close. waiting_stable_unit: ', await channel.closeNow());
		});
		channel.events.on('changed_step', (step) => {
			console.error('changed_step: ', step);
		});
		console.error('init', await channel.init());
		console.error('test', channel.info());
	}
}

start().catch(console.error)
