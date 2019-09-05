const core = require('../core');

async function start() {
	await core.init('test');
	let wallets = await core.getWallets();
	let addresses = await core.getAddressesInWallet(wallets[0]);
	
	let profile = {type:'printer'};
	let result = await core.postPublicProfile(addresses[0], profile);
	console.error('result', result);
	console.error('-------________-------');
	console.error(JSON.stringify(result));
	// await core.saveProfile(result.address, addresses[0], result.objJoint.unit, result.src_profile);
	return 'ok';
}

start().then(console.error).catch(console.error);