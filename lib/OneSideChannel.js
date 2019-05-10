const core = require('../core');
const EventEmitter = require('events');
const libToEs6 = require('./toEs6');
const crypto = require('crypto');
const ChannelUtils = require('./ChannelUtils');
const libKeys = require('./keys');
const network = require('ocore/network.js');
const composer = require('ocore/composer.js');
const objectHash = require('ocore/object_hash.js');
const wallet = require('ocore/wallet.js');
const eventBus = require('ocore/event_bus');
const db = require('ocore/db');
const libAddress = require('../lib/address');


/*
init:
	let channel = new OneSideChannel({
		walletId,
		peerDeviceAddress,
		myAmount,
		age
	});
	await channel.init();
 */


class OneSideChannel {
	constructor(params) {
		const device = require('ocore/device');
		this.walletId = params.walletId;
		this.myDeviceAddress = device.getMyDeviceAddress();
		this.peerDeviceAddress = params.peerDeviceAddress;
		this.peerAddress = params.peerAddress || null;
		this.amount = params.amount;
		this.age = params.age;
		this.id = params.id || OneSideChannel.toSha256(JSON.stringify(this.info()) + Date.now());
		this.step = params.step || 'init';
		
		this.peerUnilateralAddress = params.peerUnilateralAddress;
		this.peerDestinationAddress = params.peerDestinationAddress;
		this.messageOnOpening = params.messageOnOpening || null;
		
		this.events = new EventEmitter();
		
		if (params.id) {
			this.step = 'need_send_meta';
		}
		
		this.cb_new_my_transactions = this.cb_new_my_transactions.bind(this);
		this.cb_object = this.cb_object.bind(this);
		this.cb_signing_request = this.cb_signing_request.bind(this);
		this.startListeningEvents();
	}
	
	set step(value) {
		this.events.emit('changed_step', value);
		this._step = value;
	}
	
	get step() {
		return this._step;
	}
	
	cb_new_my_transactions(arrUnits) {
	
	}
	
	async cb_object(from_address, objMessage) {
		if (objMessage.app === 'BIoT' && objMessage.id === this.id) {
			if (objMessage.step === 'myMeta') {
				this.peerAddress = objMessage.myAddress;
				this.peerDestinationAddress = objMessage.myDestinationAddress;
				this.peerUnilateralAddress = objMessage.myUnilateralAddress;
				await this.insertInDb();
				this.objMyAddress = await this.createMyAddress();
				this.myAddress = this.objMyAddress.shared_address;
				let objChannelContract = await this.createChannelContract();
				this.channelAddress = objChannelContract.shared_address;
				let objJoint = await this.createChannel();
				console.error('objsasdf', objJoint.unit.unit);
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'channelStarted',
					channelAddress: this.channelAddress,
					arrDefinition: objChannelContract.arrDefinition,
					id: this.id,
					objMyAddress: this.objMyAddress
				});
				this.step = 'waiting_transfers';
				this.events.emit('start');
				await this.updateInDb();
			} else if (objMessage.step === 'channelStarted') {
				this.objPeerAddress = objMessage.objMyAddress;
				this.channelAddress = objMessage.channelAddress;
				this.step = 'waiting_transfers';
				this.events.emit('start');
				await this.updateInDb();
			}
		}
	}
	
	async cb_signing_request(objAddress, top_address, objUnit, assocPrivatePayloads, from_address, signing_path) {
	
	}
	
	startListeningEvents() {
		eventBus.on('new_my_transactions', this.cb_new_my_transactions);
		eventBus.on('object', this.cb_object);
		eventBus.on("signing_request", this.cb_signing_request);
	}
	
	removeListeners() {
		eventBus.removeListener('new_my_transactions', this.cb_new_my_transactions);
		eventBus.removeListener('object', this.cb_object);
		eventBus.removeListener("signing_request", this.cb_signing_request);
		this.events.removeAllListeners();
	}
	
	async saveHash(address, arrDefinition) {
		let hash = ChannelUtils.getHash(arrDefinition);
		return libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO address_passes (id, address, hash) VALUES(?,?,?)", [this.id, address, hash]);
	}
	
	async saveMyPass(address, pass) {
		return libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO address_passes (id, address, pass) VALUES(?,?,?)", [this.id, address, pass]);
	}
	
	async savePass(address, pass) {
		return libToEs6.dbQuery("UPDATE address_passes SET pass = ? WHERE id = ? AND address = ?", [pass, this.id, address]);
	}
	
	async updateInDb() {
		return libToEs6.dbQuery("UPDATE channels SET address=?, peerDeviceAddress=?, peerAddress=?, myAmount=?, peerAmount=?, age=?, step=?,\n\
			myAddress=?, objMyContract=?, objPeerContract=?, waitingUnit=?, joint=?, myUnilateralAddress=?, peerUnilateralAddress=?,\n\
			myDestinationAddress=?, peerDestinationAddress=?, change_date = " + db.getNow() + " WHERE id=?",
			[
				this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step,
				this.myAddress, JSON.stringify(this.objMyContract), JSON.stringify(this.objPeerContract), this.waitingUnit,
				JSON.stringify(this.objJoint), this.myUnilateralAddress, this.peerUnilateralAddress, this.myDestinationAddress,
				this.peerDestinationAddress, this.id
			]);
	}
	
	async insertInDb() {
		return libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO oneSideChannels (id, walletId, channelAddress, peerDeviceAddress, peerAddress, \n\
		amount, age, step, change_date, myUnilateralAddress, myDestinationAddress) VALUES(?,?,?,?,?,?,?,?," + db.getNow() + ",?,?)",
			[
				this.id, this.walletId, null, this.peerDeviceAddress, null, this.amount, this.age, this.step,
				this.myUnilateralAddress, this.myDestinationAddress
			]);
	}
	
	createChannelContract() {
		return new Promise((resolve, reject) => {
			let arrDefinition = ['or', [
				['and', [
					['address', this.myAddress],
					['address', this.peerAddress]
				]],
				['and', [
					['address', this.myAddress],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.myAddress
					}]
				]]
			]];
			
			let assocSignersByPath = {
				'r.0.0': {
					address: this.myAddress,
					member_signing_path: 'r',
					device_address: this.myDeviceAddress
				},
				'r.0.1': {
					address: this.peerAddress,
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				},
				'r.1.0': {
					address: this.myAddress,
					member_signing_path: 'r',
					device_address: this.myDeviceAddress
				}
			};
			
			let walletDefinedByAddresses = require('ocore/wallet_defined_by_addresses.js');
			walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
				ifError: (err) => {
					return reject(new Error(err));
				},
				ifOk: async (shared_address) => {
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}
	
	async createChannel() {
		let paying_addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
		let newMyAddress = await core.createNewAddress(this.walletId);
		
		return new Promise(resolve => {
			let params = {
				paying_addresses,
				outputs: [
					{address: this.channelAddress, amount: this.amount},
					{address: newMyAddress, amount: 0}
				],
				signer: wallet.getSigner({}, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey),
				spend_unconfirmed: 'all',
				callbacks: composer.getSavingCallbacks({
					ifNotEnoughFunds: console.error,
					ifError: console.error,
					ifOk: function (objJoint) {
						network.broadcastJoint(objJoint);
						return resolve(objJoint);
					}
				})
			};
			composer.composeJoint(params);
		})
	}
	
	async createMyAddress() {
		return new Promise((resolve, reject) => {
			let pass = crypto.randomBytes(10).toString('hex');
			let arrDefinition = ['or', [
				['and', [
					['address', this.myUnilateralAddress],
					['age', ['>', this.age]],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.myDestinationAddress,
						amount: this.amount
					}]
				]],
				['and', [
					['address', this.peerUnilateralAddress],
					['hash', {hash: crypto.createHash("sha256").update(pass, "utf8").digest("base64")}]
				]]
			]];
			
			let assocSignersByPath = {
				'r.0.0': {
					address: this.myUnilateralAddress,
					member_signing_path: 'r',
					device_address: this.myDeviceAddress
				},
				'r.1.0': {
					address: this.peerUnilateralAddress,
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				},
				'r.1.1': {
					address: 'secret',
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				}
			};
			
			let walletDefinedByAddresses = require('ocore/wallet_defined_by_addresses.js');
			
			// console.error('asdfasdfasdfasdfsadf', JSON.stringify(arrDefinition), '__\n\n', JSON.stringify(assocSignersByPath));
			walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
				ifError: (err) => {
					return reject(new Error(err));
				},
				ifOk: async (shared_address) => {
					await this.saveMyPass(shared_address, pass);
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}
	
	async init() {
		if (!this.myUnilateralAddress) {
			this.myUnilateralAddress = await core.createNewAddress(this.walletId);
			this.myDestinationAddress = await core.createNewAddress(this.walletId);
		}
		
		if (this.step === 'init') {
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: 'init',
				id: this.id,
				amount: this.amount,
				age: this.age,
				myUnilateralAddress: this.myUnilateralAddress,
				myDestinationAddress: this.myDestinationAddress,
				messageOnOpening: this.messageOnOpening
			}, {
				ifOk: async () => {
					this.step = 'await_meta_from_peer';
					this.events.emit('ready');
					return true;
				}
			});
		} else if (this.step === 'need_send_meta') {
			this.events.emit('ready');
		}
	}
	
	async approve() {
		if (this.step === 'need_send_meta') {
			this.myAddress = await core.createNewAddress(this.walletId);
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: 'myMeta',
				id: this.id,
				myAddress: this.myAddress,
				myUnilateralAddress: this.myUnilateralAddress,
				myDestinationAddress: this.myDestinationAddress,
			});
			this.step = 'await_createChannel';
			await this.insertInDb();
		}
	}
	
	reject() {
	
	}
	
	info() {
		return {
			myDeviceAddress: this.myDeviceAddress,
			peerDeviceAddress: this.peerDeviceAddress,
			myAmount: this.amount,
			age: this.age,
			step: this.step
		}
	}
	
	static toSha256(text) {
		return crypto.createHash("sha256").update(text, "utf8").digest("base64")
	}
}

module.exports = OneSideChannel;