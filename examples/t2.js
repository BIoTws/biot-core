const core = require('../core');
const ChannelsManager = require('../lib/ChannelsManager');

async function start() {
	await core.init('test');
	let wallets = await core.getMyDeviceWallets();
	const channelsManager = new ChannelsManager(wallets[0]);
	let channel;
	let list = await channelsManager.list();
	console.error('list', list);
	if (list.length) {
		console.error('start recovery');
		channel = channelsManager.recoveryChannel(list[0]);
		channel.events.on('start', () => {
			console.error('channel start. t.js', channel.id);
		});
		await channel.init();
		console.error('init');
		await channel.approve();
		console.error('channel', channel);
		console.error(channel.info());
	}

	channelsManager.events.on('newChannel', async (objInfo) => {
		console.error('new Channel: ', objInfo);
		channel = channelsManager.getNewChannel(objInfo);
		channel.events.on('start', () => {
			console.error('channel start. t.js', channel.id);
		});
		channel.events.on('changed_step', (step) => {
			console.error('changed_step: ', step);
		});
		await channel.init();
		if (channel.myAmount === 5000) {
			await channel.approve();
		} else {
			await channel.reject();
		}
		console.error(channel.info());
	});
}

start().catch(console.error);