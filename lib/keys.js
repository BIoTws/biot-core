const fs = require('fs');
const crypto = require('crypto');
const conf = require('byteballcore/conf');
const desktopApp = require('byteballcore/desktop_app');
const Mnemonic = require('bitcore-mnemonic');
const ecdsaSig = require('byteballcore/signature');
const Wallet = require('byteballcore/wallet');
const objectHash = require('byteballcore/object_hash');
const eventBus = require('byteballcore/event_bus');
const walletGeneral = require('byteballcore/wallet_general');
const db = require('byteballcore/db');

const toEs6 = require('./toEs6');
const wallet = require('./wallet');
const utils = require('./utils');

const appDataDir = desktopApp.getAppDataDir();
const KEYS_FILENAME = appDataDir + '/' + (conf.KEYS_FILENAME || 'keys.json');

let xPrivKey;

function setXPrivKey(_xPrivKey) {
	xPrivKey = _xPrivKey
}

function signWithLocalPrivateKey(wallet_id, account, is_change, address_index, text_to_sign, handleSig) {
	let path = "m/44'/0'/" + account + "'/" + is_change + "/" + address_index;
	let privateKey = xPrivKey.derive(path).privateKey;
	let privKeyBuf = privateKey.bn.toBuffer({size: 32}); // https://github.com/bitpay/bitcore-lib/issues/47
	handleSig(ecdsaSig.sign(text_to_sign, privKeyBuf));
}

async function keysFileExists() {
	return await toEs6.fsAccess(KEYS_FILENAME, fs.constants.R_OK | fs.constants.W_OK);
}

function generateKey() {
	let deviceTempPrivKey = crypto.randomBytes(32);
	let devicePrevTempPrivKey = crypto.randomBytes(32);

	let mnemonic = new Mnemonic(); // generates new mnemonic
	while (!Mnemonic.isValid(mnemonic.toString())) {
		mnemonic = new Mnemonic();
	}

	return {mnemonic, deviceTempPrivKey, devicePrevTempPrivKey};
}

async function readKeys(passphrase) {
	let isAccess = await keysFileExists();
	if (!isAccess) {
		if (!conf.deviceName) return Promise.reject('Please set deviceName in conf.js');
		let keys = generateKey(passphrase);
		await writeKeys(keys.mnemonic.phrase, keys.deviceTempPrivKey, keys.devicePrevTempPrivKey).catch(Promise.reject);
		console.log('keys created');

		let xPrivKey = keys.mnemonic.toHDPrivateKey(passphrase);
		await wallet.createWallet(xPrivKey, 0);

		return Promise.resolve({
			mnemonic_phrase: keys.mnemonic.phrase,
			passphrase: passphrase,
			deviceTempPrivKey: keys.deviceTempPrivKey,
			devicePrevTempPrivKey: keys.devicePrevTempPrivKey
		});
	} else {
		return new Promise((resolve, reject) => {
			fs.readFile(KEYS_FILENAME, 'utf8', async (err, data) => {
				if (err) {
					return reject(err);
				}
				let keys = JSON.parse(data);
				let deviceTempPrivKey = Buffer.from(keys.temp_priv_key, 'base64');
				let devicePrevTempPrivKey = Buffer.from(keys.prev_temp_priv_key, 'base64');
				console.log('keys read');

				let rows = await toEs6.dbQuery("SELECT wallet FROM wallets");
				if (!rows.length) {
					let mnemonic = new Mnemonic(keys.mnemonic_phrase);
					let xPrivKey = mnemonic.toHDPrivateKey(passphrase);
					await wallet.createWallet(xPrivKey, 0);
				}
				return resolve({
					mnemonic_phrase: keys.mnemonic_phrase,
					passphrase: passphrase,
					deviceTempPrivKey,
					devicePrevTempPrivKey
				});
			});
		});
	}
}

async function writeKeys(mnemonic_phrase, deviceTempPrivKey, devicePrevTempPrivKey) {
	let keys = {
		mnemonic_phrase: mnemonic_phrase,
		temp_priv_key: deviceTempPrivKey.toString('base64'),
		prev_temp_priv_key: devicePrevTempPrivKey.toString('base64')
	};

	await utils.createFolderIfNotExists(appDataDir);
	await toEs6.fsWriteFile(KEYS_FILENAME, JSON.stringify(keys, null, '\t'), 'utf8').catch(Promise.reject);
	return true;
}

function findAddress(address, signing_path, callbacks, fallback_remote_device_address) {
	const device = require('byteballcore/device');
	db.query(
		"SELECT wallet, account, is_change, address_index, full_approval_date, device_address \n\
		FROM my_addresses JOIN wallets USING(wallet) JOIN wallet_signing_paths USING(wallet) \n\
		WHERE address=? AND signing_path=?",
		[address, signing_path],
		rows => {
			if (rows.length > 1)
				throw Error("more than 1 address found");
			if (rows.length === 1) {
				let row = rows[0];
				if (!row.full_approval_date)
					return callbacks.ifError("wallet of address " + address + " not approved");
				if (row.device_address !== device.getMyDeviceAddress())
					return callbacks.ifRemote(row.device_address);
				let objAddress = {
					address: address,
					wallet: row.wallet,
					account: row.account,
					is_change: row.is_change,
					address_index: row.address_index
				};
				callbacks.ifLocal(objAddress);
				return;
			}
			db.query("SELECT device_address FROM peer_addresses WHERE address = ?", [address], rows2 => {
				if (rows2.length === 1) {
					return callbacks.ifRemote(rows2[0].device_address);
				}
				db.query(
					//	"SELECT address, device_address, member_signing_path FROM shared_address_signing_paths WHERE shared_address=? AND signing_path=?",
					// look for a prefix of the requested signing_path
					"SELECT address, device_address, signing_path FROM shared_address_signing_paths \n\
					WHERE shared_address=? AND signing_path=SUBSTR(?, 1, LENGTH(signing_path))",
					[address, signing_path],
					sa_rows => {
						if (rows.length > 1)
							throw Error("more than 1 member address found for shared address " + address + " and signing path " + signing_path);
						if (sa_rows.length === 0) {
							if (fallback_remote_device_address)
								return callbacks.ifRemote(fallback_remote_device_address);
							return callbacks.ifUnknownAddress();
						}
						let objSharedAddress = sa_rows[0];
						let relative_signing_path = 'r' + signing_path.substr(objSharedAddress.signing_path.length);
						let bLocal = (objSharedAddress.device_address === device.getMyDeviceAddress()); // local keys
						if (objSharedAddress.address === '') {
							return callbacks.ifMerkle(bLocal);
						} else if (objSharedAddress.address === 'secret') {
							return callbacks.ifSecret();
						}
						findAddress(objSharedAddress.address, relative_signing_path, callbacks, bLocal ? null : objSharedAddress.device_address);
					}
				);
			});
		}
	);
}

function getLocalSigner(opts, arrSigningDeviceAddresses, signWithLocalPrivateKey) {
	let bRequestedConfirmation = false;
	let signer = Wallet.getSigner(opts, arrSigningDeviceAddresses, signWithLocalPrivateKey);

	signer.readDefinition = function (conn, address, handleDefinition) {
		conn.query(
			"SELECT definition FROM my_addresses WHERE address=? \n\
			UNION SELECT definition FROM shared_addresses WHERE shared_address=?\n\
			UNION SELECT definition FROM peer_addresses WHERE address=?",
			[address, address, address],
			function (rows) {
				if (rows.length !== 1)
					throw Error("definition not found");
				handleDefinition(null, JSON.parse(rows[0].definition));
			}
		);
	};

	signer.sign = (objUnsignedUnit, assocPrivatePayloads, address, signing_path, handleSignature) => {
		let buf_to_sign = objectHash.getUnitHashToSign(objUnsignedUnit);
		findAddress(address, signing_path, {
			ifError: function (err) {
				throw Error(err);
			},
			ifUnknownAddress: function (err) {
				throw Error("unknown address " + address + " at " + signing_path);
			},
			ifLocal: function (objAddress) {
				signWithLocalPrivateKey(objAddress.wallet, objAddress.account, objAddress.is_change, objAddress.address_index, buf_to_sign, function (sig) {
					handleSignature(null, sig);
				});
			},
			ifRemote: function (device_address) {
				// we'll receive this event after the peer signs
				eventBus.once("signature-" + device_address + "-" + address + "-" + signing_path + "-" + buf_to_sign.toString("base64"), function (sig) {
					handleSignature(null, sig);
					if (sig === '[refused]')
						eventBus.emit('refused_to_sign', device_address);
				});
				walletGeneral.sendOfferToSign(device_address, address, signing_path, objUnsignedUnit, assocPrivatePayloads);
				if (!bRequestedConfirmation) {
					eventBus.emit("confirm_on_other_devices");
					bRequestedConfirmation = true;
				}
			},
			ifMerkle: function (bLocal) {
				if (!bLocal)
					throw Error("merkle proof at path " + signing_path + " should be provided by another device");
				if (!opts.merkle_proof)
					throw Error("merkle proof at path " + signing_path + " not provided");
				handleSignature(null, opts.merkle_proof);
			},
			ifSecret: function () {
				if (!opts.secrets || !opts.secrets[signing_path])
					throw Error("secret " + signing_path + " not found");
				handleSignature(null, opts.secrets[signing_path])
			}
		});
	};

	return signer;
}

exports.keysFileExists = keysFileExists;
exports.readKeys = readKeys;
exports.writeKeys = writeKeys;
exports.signWithLocalPrivateKey = signWithLocalPrivateKey;
exports.setXPrivKey = setXPrivKey;
exports.getLocalSigner = getLocalSigner;