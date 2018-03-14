const core = require('../core');
const crypto = require('crypto');

async function start() {
	await core.init('test');

	let hash = crypto.createHash("sha256").update('test', "utf8").digest();

	let signDevice = core.signDevicePrivateKey(hash);
	console.error(`verify sign "${signDevice.sign}" device: ${core.verifySign(hash, signDevice.sign, signDevice.pub_b64)}`);

	let wallets = await core.getWallets();
	let addresses = await core.getAddressesInWallet(wallets[0]);
	let addressInfo = await core.myAddressInfo(addresses[0]);

	let signAddress = core.signWithAddress(addressInfo.account, addressInfo.is_change, addressInfo.address_index, hash);
	console.error(`verify sign "${signAddress.sign}" address: ${core.verifySign(hash, signAddress.sign, signAddress.pub_b64)}`);

	return 'ok';
}

start().then(console.log).catch(console.error);