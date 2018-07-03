const crypto = require('crypto');
const core = require('../core');
const libAddress = require('../lib/address');
const libKeys = require('../lib/keys');
const libToEs6 = require('./toEs6');
const libTransactions = require('./transactions');
const eventBus = require('byteballcore/event_bus');
const EventEmitter = require('events');
const composer = require('byteballcore/composer');
const my_witnesses = require('byteballcore/my_witnesses');
const network = require('byteballcore/network');
const objectHash = require('byteballcore/object_hash');
const bbWallet = require('byteballcore/wallet');
const db = require('byteballcore/db');
const mutex = require('byteballcore/mutex');
const ChannelUtils = require('./ChannelUtils');
const constants = require('./constants');

let openingChannel = false;

const MAX_UNLOCK_TIMEOUT = 60000;

class Channel {
	constructor(params) {
		this.walletId = params.walletId;
		this.myDeviceAddress = params.myDeviceAddress;
		this.peerDeviceAddress = params.peerDeviceAddress;
		this.peerAddress = params.peerAddress;
		this.myAmount = params.myAmount;
		this.peerAmount = params.peerAmount;
		this.age = params.age;
		this.id = params.id || Channel.toSha256(JSON.stringify(this.info()) + Date.now());
		this.events = new EventEmitter();
		this.step = 'null';
		this.channelAddress = null;
		this.peerClosingAddress = params.peerClosingAddress;

		this.objMyContract = null;
		this.objPeerContract = null;
		this.waitingUnit = null;

		if (params.id) {
			this.step = 'get1Contract';
		}

		if (params.objRecovery) {
			for (let key in params.objRecovery) {
				if (params.objRecovery.hasOwnProperty(key)) {
					let v = params.objRecovery[key];
					this[key] = (v === 'null') ? null : v;
				}
			}
		} else {
			this.insertInDb().catch(e => {throw e});
		}

		if (this.step === 'waiting_mci') {
			this.startWaitingMCI(this.waitingUnit).catch(console.error);
		}

		this.cb_new_my_transactions = this.cb_new_my_transactions.bind(this);
		this.cb_text = this.cb_text.bind(this);
		this.cb_signing_request = this.cb_signing_request.bind(this);
		this.startListeningEvents();
	}


	cb_new_my_transactions(arrUnits) {
		console.error('%$^@#%!@#!@#!@#!@#!@#!@#!@#!@#');
		console.error('cb_new_my_transactions', arrUnits);
		console.error('%$^@#%!@#!@#!@#!@#!@#!@#!@#!@#');
		arrUnits.forEach(async unit => {
			let rowsOutputs = await libToEs6.dbQuery("SELECT address, amount FROM outputs WHERE unit = ?", [unit]);
			let check = ChannelUtils.checkPaymentToChannelContract(this, rowsOutputs, await core.getAddressesInWallet(this.walletId));
			if (check.status) {
				this.total_input = null;
				this.step = 'waiting_transfers';
				this.events.emit('start');
				if (this.unlockPick) {
					this.unlockPick();
					this.unlockPick = null;
				}
				if (this.unlockApprove) {
					this.unlockApprove();
					this.unlockApprove = null;
				}
				this.updateInDb().catch(console.error);
			} else {
				let rows = await libToEs6.dbQuery("SELECT address FROM unit_authors WHERE unit = ?", [unit]);
				let arrAddresses = rows.map(author => author.address);
				if (ChannelUtils.isClosingPayment(this, arrAddresses)) {
					this.checkClosingPaymentAndPunish(unit).catch(console.error);
				}
			}
		});
	}

	async cb_text(from_address, text) {
		let objMessage = null;
		try {
			objMessage = JSON.parse(text);
		} catch (e) {
			console.error('incorrect tech message', text);
		}

		if (objMessage) {
			if (objMessage.app === 'BIoT' && objMessage.id === this.id) {
				if (objMessage.status && objMessage.status === 'reject') {
					this.events.emit('error', {type: 'reject', step: objMessage.step});
					this.step = 'reject';
					await this.updateInDb();
				} else if (objMessage.step === 'channelAddress') {
					let check = ChannelUtils.checkSharedAddress(this, objMessage.channelAddress, objMessage.arrDefinition);
					if (!check.status) {
						console.error(new Error('SharedAddress incorrect. code:' + check.code));
						return this.reject();
					}
					this.channelAddress = objMessage.channelAddress;
				} else if (objMessage.step === '1Contract' && this.step === 'await_get1Contract') {
					this.peerAddress = objMessage.myAddress;
					let check = ChannelUtils.check1Contract(this, objMessage.contract.shared_address, objMessage.contract.arrDefinition);
					if (!check.status) {
						console.error(new Error('1Contract incorrect. code:' + check.code));
						return this.reject();
					}
					await this.saveHash(objMessage.contract.shared_address, objMessage.contract.arrDefinition);
					this.objPeerContract = objMessage.contract;
					this.peerAddress = objMessage.myAddress;
					this.objMyContract = await this.create1Contract(this.myAmount, this.peerAmount);
					let arrAddressesRows = await libAddress.getAddressesFromDb([this.myAddress, this.myClosingAddress]);
					this.peerClosingAddress = objMessage.myClosingAddress;
					core.sendTechMessageToDevice(this.peerDeviceAddress, {
						step: 'getInputsAndAddresses',
						contract: this.objMyContract,
						id: this.id,
						arrAddressesRows
					});
					this.step = 'await_getInputsAndAddresses';
					await this.updateInDb();
				} else if (objMessage.step === 'getInputsAndAddresses' && this.step === 'await_get1Contract') {
					let check = ChannelUtils.check1Contract(this, objMessage.contract.shared_address, objMessage.contract.arrDefinition);
					if (!check.status) {
						console.error(new Error('1Contract incorrect. code:' + check.code));
						return this.reject();
					}
					await libAddress.addIfNotExistRemoteAddresses(objMessage.arrAddressesRows, this.peerDeviceAddress);
					await this.saveHash(objMessage.contract.shared_address, objMessage.contract.arrDefinition);
					this.objPeerContract = objMessage.contract;
					await this.sendInputsAndAddresses();
					await this.updateInDb();
				} else if (objMessage.step === 'inputsAndAddresses' && this.step === 'await_getInputsAndAddresses') {
					await libAddress.addIfNotExistRemoteAddresses(objMessage.arrAddressesRows, this.peerDeviceAddress);
					let objChannelContract = await this.createChannelContract();
					this.channelAddress = objChannelContract.shared_address;
					core.sendTechMessageToDevice(this.peerDeviceAddress, {
						step: 'channelAddress',
						channelAddress: this.channelAddress,
						arrDefinition: objChannelContract.arrDefinition,
						id: this.id
					});
					let objJoint = await this.createChannel(objMessage);
					this.step = 'waiting_transfers';
					this.events.emit('start');
					if (this.unlockStartChannel) {
						this.unlockStartChannel();
						this.unlockStartChannel = null;
					}
					await this.updateInDb();
				} else if (objMessage.step === 'transfer_start' && this.step === 'waiting_transfers') {
					this.messageTransfer = objMessage.message;
					let objMyContract = objMessage.objMyContract;
					let check = ChannelUtils.check1Contract(this, objMyContract.shared_address, objMyContract.arrDefinition, objMessage.amount);
					if (!check.status) {
						console.error(new Error('1Contract incorrect. code:' + check.code));
						return this.reject();
					}
					this.step = 'waiting_transfer';
					await this.saveHash(objMyContract.shared_address, objMyContract.arrDefinition);
					this.objPeerContract = objMyContract;
					this.transferAmount = objMessage.amount;
				} else if (objMessage.step === 'transfer_end' && this.step === 'waiting_reverse_transfer') {
					let objMyContract = objMessage.objMyContract;
					let check = ChannelUtils.check1Contract(this, objMyContract.shared_address, objMyContract.arrDefinition, objMessage.amount, true);
					if (!check.status) {
						console.error(new Error('1Contract incorrect. code:' + check.code));
						return this.reject();
					}
					await this.saveHash(objMyContract.shared_address, objMyContract.arrDefinition);
					this.objPeerContract = objMyContract;
					this.step = 'waiting_transfer';
				} else if (objMessage.step === 'close' && this.step === 'waiting_transfers') {
					this.step = 'await_closing';
				} else if (objMessage.step === 'pass' && ((this.step === 'waiting_pass' && this.imInitiator) ||
					(this.step === 'waiting_reverse_transfer' && !this.imInitiator))) {
					if (!(await this.checkPassHash(objMessage.address, objMessage.pass))) {
						console.error(new Error('checkPassHash incorrect. address:' + objMessage.address));
						return this.reject();
					}
					if (this.imInitiator) {
						this.imInitiator = false;
					}
					await this.savePass(objMessage.address, objMessage.pass);
					this.step = 'waiting_transfers';
					this.myAmount = this.newMyAmount;
					this.peerAmount = this.newPeerAmount;
					await this.updateInDb();
				}
			}
		}
	}

	async cb_signing_request(objAddress, top_address, objUnit, assocPrivatePayloads, from_address, signing_path) {
		if (this.step === 'reject' || from_address !== this.peerDeviceAddress) return;

		let outputs = objUnit.messages[0].payload.outputs;
		let channelOutput = outputs.find(output => output.address === this.channelAddress);
		let peerSharedAddressOutput;
		if (this.objPeerContract) {
			peerSharedAddressOutput = outputs.find(output => output.address === this.objPeerContract.shared_address);
		}
		let myAddressOutput = outputs.find(output => output.address === this.myClosingAddress);
		let peerAddressOutput = outputs.find(output => output.address === this.peerClosingAddress);
		if (channelOutput || peerSharedAddressOutput || (this.step === 'await_closing' && myAddressOutput && peerAddressOutput && outputs.length === 2)) {
			if (this.step === 'await_createChannel' && signing_path === 'r') {
				let check = ChannelUtils.checkPaymentToChannelContract(this, outputs, await core.getAddressesInWallet(this.walletId));
				if (!check.status) {
					console.error(new Error('await_createChannel incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
			}
			else if (this.step === 'waiting_transfer' && (signing_path === 'r.2.0' || signing_path === 'r.1.0') && !this.imInitiator) {
				// this is B
				this.newMyAmount = this.myAmount + this.transferAmount;
				this.newPeerAmount = this.peerAmount - this.transferAmount;
				this.prevSharedAddress = this.objMyContract.shared_address;
				let check = ChannelUtils.checkTransferPayment(this, outputs);
				if (!check.status) {
					console.error(new Error('waiting_transfer incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
				this.objMyContract = await this.create1Contract(this.newMyAmount, this.newPeerAmount);

				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'transfer_end',
					amount: this.transferAmount,
					id: this.id,
					objMyContract: this.objMyContract
				});
				this.step = 'waiting_reverse_transfer';
				this.objJoint = await this.signMyTransfer(this.newMyAmount, this.newPeerAmount, this.objMyContract);
				await this.updateInDb();
				let rowsPass = await libToEs6.dbQuery("SELECT pass FROM address_passes WHERE id = ? AND address = ?", [this.id, this.prevSharedAddress]);
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'pass',
					id: this.id,
					address: this.prevSharedAddress,
					pass: rowsPass[0].pass
				}, {
					ifOk: () => {
						this.events.emit('new_transfer', this.transferAmount, this.messageTransfer);
					}
				});

			} else if (this.step === 'waiting_transfer' && (signing_path === 'r.2.0' || signing_path === 'r.1.0') && this.imInitiator) {
				// This is A
				let check = ChannelUtils.checkTransferPayment(this, outputs);
				if (!check.status) {
					console.error(new Error('waiting_transfer incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
				this.step = 'waiting_pass';
				this.newMyAmount = this.myAmount - this.transferAmount;
				this.newPeerAmount = this.peerAmount + this.transferAmount;
				let rowsPass = await libToEs6.dbQuery("SELECT pass FROM address_passes WHERE id = ? AND address = ?", [this.id, this.prevSharedAddress]);
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'pass',
					id: this.id,
					address: this.prevSharedAddress,
					pass: rowsPass[0].pass
				});
			} else if (this.step === 'await_closing' && (signing_path === 'r.0.0' || signing_path === 'r.0.1' || signing_path === 'r')) {
				let check = ChannelUtils.checkClosingPayment(this, outputs);
				if (!check.status) {
					console.error(new Error('await_closing incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
			} else if (this.step === 'await_closing' && (signing_path === 'r.1.0' || signing_path === 'r.2.0')) {
				let check = ChannelUtils.checkClosingPayment(this, outputs);
				if (!check.status) {
					console.error(new Error('await_closing incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
				this.step = 'mutualClose';
				this.mutualClose = true;
				await this.updateInDb();
				this.removeListeners();
			} else if (this.step === 'waiting_transfer') {
				let check = ChannelUtils.checkTransferPayment(this, outputs);
				if (!check.status) {
					console.error(new Error('waiting_transfer incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
			} else {
				return;
			}

			let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
			libKeys.signWithLocalPrivateKey(null, objAddress.account, objAddress.is_change, objAddress.address_index, buf_to_sign, signature => {
				bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), signature, signing_path, top_address);
			});
		}
	}

	startListeningEvents() {
		eventBus.on('new_my_transactions', this.cb_new_my_transactions);
		eventBus.on('text', this.cb_text);
		eventBus.on("signing_request", this.cb_signing_request);
	}

	removeListeners() {
		console.error('removeListeners');
		eventBus.removeListener('new_my_transactions', this.cb_new_my_transactions);
		eventBus.removeListener('text', this.cb_text);
		eventBus.removeListener("signing_request", this.cb_signing_request);
		this.events.removeAllListeners();
	}

	set step(value) {
		this.events.emit('changed_step', value);
		this._step = value;
	}

	get step() {
		return this._step;
	}

	async insertInDb() {
		return libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO channels (id, address, peerDeviceAddress, peerAddress, \n\
		myAmount, peerAmount, age, step, change_date) VALUES(?,?,?,?,?,?,?,?," + db.getNow() + ")",
			[this.id, this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step]);
	}

	async updateInDb() {
		return libToEs6.dbQuery("UPDATE channels SET address=?, peerDeviceAddress=?, peerAddress=?, myAmount=?, peerAmount=?, age=?, step=?,\n\
			myAddress=?, objMyContract=?, objPeerContract=?, waitingUnit=?, joint=?, myClosingAddress=?, peerClosingAddress=?,\n\
			change_date = " + db.getNow() + " WHERE id=?",
			[this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step,
				this.myAddress, JSON.stringify(this.objMyContract), JSON.stringify(this.objPeerContract), this.waitingUnit,
				JSON.stringify(this.objJoint), this.myClosingAddress, this.peerClosingAddress, this.id]);
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

	async init() {
		if (!this.myAddress) {
			this.myAddress = await core.createNewAddress(this.walletId);
			await this.updateInDb();
		}
		if (this.step === 'null') {
			this.unlockStartChannel = await Channel.lockStartChannel();
			this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
			if (!this.addresses || !this.addresses.length) {
				this.unlockStartChannel();
				throw new Error('Insufficient funds');
			}
			openingChannel = true;
			this.myClosingAddress = await core.createNewAddress(this.walletId);

			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: 'get1Contract',
				id: this.id,
				myAmount: this.myAmount,
				peerAmount: this.peerAmount,
				myAddress: this.myAddress,
				age: this.age,
				myClosingAddress: this.myClosingAddress
			});
			this.step = 'await_get1Contract';
			await this.updateInDb();
			return true;
		} else {
			return false;
		}
	}

	async approve() {
		if (this.step === 'get1Contract') {
			if (openingChannel) {
				let i = parseInt(Buffer.from(this.myDeviceAddress).toString('hex'), 16);
				let peer = parseInt(Buffer.from(this.peerDeviceAddress).toString('hex'), 16);
				if (peer > i) {
					this.unlockApprove = await Channel.lockStartChannel();
				}
			}
			this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
			if (!this.addresses || !this.addresses.length) {
				throw new Error('Insufficient funds');
			}

			this.objMyContract = await this.create1Contract(this.myAmount, this.peerAmount);
			this.myClosingAddress = await core.createNewAddress(this.walletId);
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: '1Contract',
				contract: this.objMyContract,
				myAddress: this.myAddress,
				id: this.id,
				myClosingAddress: this.myClosingAddress
			});
			this.step = 'await_get1Contract';
			await this.updateInDb();
		}
	}

	reject() {
		core.sendTechMessageToDevice(this.peerDeviceAddress, {
			step: this.step,
			id: this.id,
			status: 'reject'
		});
		this.events.emit('reject', {step: this.step});
		this.step = 'reject';
		this.updateInDb().catch(console.error);
	}

	create1Contract(myAmount, peerAmount) {
		return new Promise((resolve, reject) => {
			let pass = crypto.randomBytes(10).toString('hex');
			let arrDefinition = ['or', [
				['and', [
					['or', [
						['address', this.myAddress],
						['address', this.peerAddress]
					]],
					['age', ['>', this.age]],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.myAddress,
						amount: myAmount
					}],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.peerAddress,
						amount: peerAmount
					}]
				]],
				['and', [
					['address', this.peerAddress],
					['hash', {hash: crypto.createHash("sha256").update(pass, "utf8").digest("base64")}]
				]]
			]];

			let assocSignersByPath = {
				'r.0.0.0': {
					address: this.myAddress,
					member_signing_path: 'r',
					device_address: this.myDeviceAddress
				},
				'r.0.0.1': {
					address: this.peerAddress,
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				},
				'r.1.0': {
					address: this.peerAddress,
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				},
				'r.1.1': {
					address: 'secret',
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				}
			};

			let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
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

	async sendInputsAndAddresses() {
		this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, this.myAmount + (constants.FEES_FOR_CHANNEL_OPERATIONS * 2)
			+ constants.FEES_FOR_CREATE_CHANNEL, true);
		this.total_input = objPick.total_input;
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
		let arrAddressesRows = await libAddress.getAddressesFromDb(myPayingAddresses.concat([this.myAddress, this.myClosingAddress]));
		core.sendTechMessageToDevice(this.peerDeviceAddress, {
			step: 'inputsAndAddresses',
			inputs: objPick.arrInputs,
			total_input: objPick.total_input,
			myPayingAddresses,
			arrAddressesRows,
			id: this.id,
			newAddress: await core.createNewAddress(this.walletId)
		});

		this.unlockPick = objPick.unlock;
		setTimeout(() => {
			if (this.unlockPick) {
				this.unlockPick();
			}
		}, MAX_UNLOCK_TIMEOUT);

		this.step = 'await_createChannel';
		return true;
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
						address: this.objMyContract.shared_address
					}]
				]],
				['and', [
					['address', this.peerAddress],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.objPeerContract.shared_address
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
				},
				'r.2.0': {
					address: this.peerAddress,
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				}
			};

			let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
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


	async createChannel(objMessage) {
		this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, this.myAmount + (constants.FEES_FOR_CHANNEL_OPERATIONS * 2)
			+ constants.FEES_FOR_CREATE_CHANNEL, true);
		if (!objPick) {
			return Promise.reject(new Error('Insufficient funds'));
		}
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
		let newMyAddress = await core.createNewAddress(this.walletId);
		return new Promise(((resolve, reject) => {
			let opts = {};
			opts.paying_addresses = myPayingAddresses.concat(objMessage.myPayingAddresses);
			opts.inputs = objPick.arrInputs.concat(objMessage.inputs);
			opts.input_amount = objPick.total_input + objMessage.total_input;
			opts.outputs = [{
				address: this.channelAddress,
				amount: this.myAmount + this.peerAmount + (constants.FEES_FOR_CHANNEL_OPERATIONS * 4)
			}, {
				address: objMessage.newAddress,
				amount: objMessage.total_input - this.peerAmount - constants.FEES_FOR_CREATE_CHANNEL - (constants.FEES_FOR_CHANNEL_OPERATIONS * 2)
			}, {
				address: newMyAddress,
				amount: 0
			}];
			opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
			opts.signer = libKeys.getLocalSigner(opts, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey);
			opts.callbacks = {
				ifError: (err) => {
					setImmediate(objPick.unlock);
					openingChannel = false;
					return reject(new Error(err));
				},
				ifNotEnoughFunds: (err) => {
					setImmediate(objPick.unlock);
					openingChannel = false;
					return reject(new Error(err));
				},
				ifOk: (objJoint) => {
					network.broadcastJoint(objJoint);
					setImmediate(objPick.unlock);
					openingChannel = false;
					return resolve(objJoint);
				}
			};
			opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
			composer.composeJoint(opts);
		}));
	}

	async transfer(amount, message) {
		let unlock = await new Promise(resolve => {mutex.lock(["biot_transfer"], (unlock) => {return resolve(unlock)});});
		this.imInitiator = true;
		let newMyAmount = this.myAmount - amount;
		let newPeerAmount = this.peerAmount + amount;
		this.transferAmount = amount;

		this.prevSharedAddress = this.objMyContract.shared_address;
		this.objMyContract = await this.create1Contract(newMyAmount, newPeerAmount);

		core.sendTechMessageToDevice(this.peerDeviceAddress, {
			step: 'transfer_start',
			amount,
			id: this.id,
			objMyContract: this.objMyContract,
			message: message || null
		});
		this.step = 'waiting_reverse_transfer';

		let objJoint = await this.signMyTransfer(newMyAmount, newPeerAmount, this.objMyContract);
		this.objJoint = objJoint;
		await this.updateInDb();
		setTimeout(unlock, 70);
		return {status: 'ok', objJoint};
	}

	signMyTransfer(newMyAmount, newPeerAmount, objMyContract) {
		return new Promise(((resolve, reject) => {
			this.getInputs(this.channelAddress).then(objInputs => {
				let opts = {};
				opts.paying_addresses = [this.channelAddress];
				opts.signing_addresses = [this.myAddress, this.peerAddress];
				opts.inputs = objInputs.arrInputs;
				opts.input_amount = objInputs.total_input;
				opts.outputs = [{
					address: objMyContract.shared_address,
					amount: 0
				}];
				opts.signer = libKeys.getLocalSigner(opts, [this.myDeviceAddress, this.peerDeviceAddress], libKeys.signWithLocalPrivateKey);
				opts.callbacks = {
					ifError: (err) => {
						return reject(new Error(err));
					},
					ifNotEnoughFunds: (err) => {
						return reject(new Error(err));
					},
					ifOk: (objJoint, assocPrivatePayloads, unlock_callback) => {
						unlock_callback();
						return resolve(objJoint);
					}
				};
				composer.composeJoint(opts);
			})
		}));
	}

	async getInputs(fromAddress) {
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, [fromAddress], this.myAmount + this.peerAmount);
		if (!objPick) return null;

		return {
			arrInputs: objPick.arrInputs,
			total_input: objPick.total_input
		};
	}

	closeChannel(objInputs, from_addresses, outputs, signers, pass, signingAddresses) {
		return new Promise((resolve, reject) => {
			let opts = {};
			opts.outputs = outputs;
			opts.paying_addresses = from_addresses;
			if (signingAddresses)
				opts.signing_addresses = signingAddresses;

			if (objInputs) {
				opts.inputs = objInputs.arrInputs;
				opts.input_amount = objInputs.total_input;
				opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
			}
			if (pass) {
				opts.secrets = {'r.1.1': pass};
			}
			opts.signer = libKeys.getLocalSigner(opts, signers, libKeys.signWithLocalPrivateKey);
			opts.callbacks = {
				ifError: (err) => {
					return reject(new Error(err));
				},
				ifNotEnoughFunds: (err) => {
					return reject(new Error(err));
				},
				ifOk: async (objJoint) => {
					network.broadcastJoint(objJoint);
					return resolve(objJoint);
				}
			};
			opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
			composer.composeJoint(opts);
		});
	}

	closeMutually() {
		if (this.step === 'waiting_transfers') {
			return new Promise((resolve, reject) => {
				this.getInputs(this.channelAddress).then(async (objInputs) => {
					if (!objInputs || !objInputs.arrInputs.length) {
						return reject(new Error('Insufficient funds'));
					}
					core.sendTechMessageToDevice(this.peerDeviceAddress, {
						id: this.id,
						step: 'close'
					});
					this.closeChannel(objInputs, [this.channelAddress],
						[
							{address: this.peerClosingAddress, amount: this.peerAmount},
							{address: this.myClosingAddress, amount: 0}
						],
						[this.myDeviceAddress, this.peerDeviceAddress], null, [this.myAddress, this.peerAddress])
						.then(async (objJoint) => {
							this.step = 'mutualClose';
							this.mutualClose = true;
							await this.updateInDb();
							this.removeListeners();
							return resolve({status: 'ok', objJoint});
						}).catch((e) => {
						return reject(new Error(e))
					});
				});
			});
		} else {
			return {status: 'error', text: 'step not equal waiting_transfers'}
		}
	}

	closeOneSide() {
		return new Promise((resolve, reject) => {
			if (this.objJoint) {
				let opts = {};
				opts.callbacks = {
					ifError: (err) => {
						return reject(new Error(err));
					},
					ifNotEnoughFunds: (err) => {
						return reject(new Error(err));
					},
					ifOk: async (objJoint) => {
						network.broadcastJoint(objJoint);
						this.waitingUnit = objJoint.unit.unit;
						this.step = 'waiting_mci';
						this.startWaitingMCI(this.waitingUnit).catch((e) => reject(new Error(e)));
						await this.updateInDb();
						return resolve(objJoint);
					}
				};
				opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
				opts.callbacks.ifOk(this.objJoint, null, () => {});
			} else {
				this.getInputs(this.channelAddress).then(async (objInputs) => {
					if (!objInputs || !objInputs.arrInputs.length) {
						return reject(new Error('Insufficient funds'));
					}
					this.closeChannel(objInputs, [this.channelAddress],
						[{
							address: this.objMyContract.shared_address,
							amount: this.myAmount + this.peerAmount + (constants.FEES_FOR_CHANNEL_OPERATIONS * 2)
						}, {
							address: this.myClosingAddress,
							amount: 0
						}],
						[this.myDeviceAddress], null, [this.myAddress])
						.then(async (objJoint) => {
							this.waitingUnit = objJoint.unit.unit;
							this.step = 'waiting_mci';
							this.startWaitingMCI(this.waitingUnit).catch(e => reject(new Error(e)));
							await this.updateInDb();
							return resolve(objJoint);
						}).catch(e => reject(new Error(e)));
				});
			}
		});
	}

	async startWaitingMCI(unit) {
		this.intervalMCI = setInterval(async () => {
			if (await Channel.checkAgeGreaterThan(unit, this.age)) {
				if (this.intervalMCI) {
					clearInterval(this.intervalMCI);
				}
				await this.closeOneSideFinal();
			}
		}, 60000);
		if (await Channel.checkAgeGreaterThan(unit, this.age)) {
			if (this.intervalMCI) {
				clearInterval(this.intervalMCI);
			}
			await this.closeOneSideFinal();
		}
	}

	closeOneSideFinal() {
		return new Promise((resolve, reject) => {
			this.getInputs(this.objMyContract.shared_address).then(async (objInputs) => {
				if (!objInputs || !objInputs.arrInputs.length) {
					return reject(new Error('Insufficient funds'));
				}

				this.closeChannel(objInputs, [this.objMyContract.shared_address],
					[{
						address: this.peerAddress,
						amount: this.peerAmount
					}, {
						address: this.myAddress,
						amount: this.myAmount
					}, {
						address: this.myAddress,
						amount: 0
					}],
					[this.myDeviceAddress])
					.then(async () => {
						this.step = 'close';
						this.waitingUnit = null;
						await this.updateInDb();
						this.removeListeners();
					}).catch(e => {
					reject(new Error(e))
				});
			});
		});
	}

	async checkPassHash(address, pass) {
		let rowsPass = await libToEs6.dbQuery("SELECT hash FROM address_passes WHERE id = ? AND address = ?", [this.id, address]);
		return (rowsPass[0].hash === crypto.createHash("sha256").update(pass, "utf8").digest("base64"));
	}

	async punishPeer(address, pass) {
		this.getInputs(address).then(async (objInputs) => {
			if (!objInputs || !objInputs.arrInputs.length || objInputs.total_input < constants.FEES_FOR_GET_INPUTS) {
				return;
			}
			return this.closeChannel(objInputs, [address],
				[{
					address: this.myClosingAddress,
					amount: 0
				}],
				[this.myDeviceAddress], pass, [this.myAddress])
				.then(async (objJoint) => {
					this.step = 'close';
					this.waitingUnit = null;
					await this.updateInDb();
					this.removeListeners();
					console.error('punishUnit', objJoint.unit);
					return true;
				}).catch(e => {
					return Promise.reject(new Error(e))
				});
		});
	}

	async checkClosingPaymentAndPunish(unit) {
		if (this.objJoint) {
			let rows = await libToEs6.dbQuery("SELECT address FROM outputs WHERE unit =?", [unit]);
			let arrAddresses = rows.map(output => output.address);
			if (arrAddresses.indexOf(this.objPeerContract.shared_address) !== -1) {
				this.step = 'close';
				this.removeListeners();
				await this.updateInDb();
			} else {
				await this.punish(unit);
			}
		}
	}

	async punish(unit) {
		let rowsOutputs = await libToEs6.dbQuery("SELECT address FROM outputs WHERE unit = ?", [unit]);
		let arrAddresses = rowsOutputs.map(row => row.address);
		let rows = await libToEs6.dbQuery("SELECT address, pass FROM address_passes WHERE id = ? AND address IN (?)", [this.id, arrAddresses]);
		if (rows.length === 1) {
			await this.punishPeer(rows[0].address, rows[0].pass);
		} else {
			this.removeListeners();
			console.error('error checkClosingPaymentAndPunish', unit, rows);
		}
	}

	static pickDivisibleCoinsForAmount(db, asset, addresses, amount, lock) {
		return new Promise((resolve => {
			mutex.lock(["biot_pickDivisibleCoinsForAmount"], unlock => {
				libTransactions.pickDivisibleCoinsForAmount(asset.asset, addresses, amount).then(objPick => {
					if (!lock) unlock();
					return resolve({
						arrInputs: objPick.arrInputs,
						total_input: objPick.total_input,
						unlock: lock ? unlock : undefined
					});
				}).catch(() => {return resolve(null)});
			});
		}));
	}

	static lockStartChannel() {
		return new Promise(resolve => {
			mutex.lock(["biot_startChannel"], resolve);
		});
	}

	static async checkAgeGreaterThan(unit, greatValue) {
		let rows = await libToEs6.dbQuery("SELECT main_chain_index FROM units WHERE unit = ?", [unit]);
		if (!rows[0].main_chain_index) return false;
		let MCIAndResponse = await Channel.getMCIAndResponse();
		return (MCIAndResponse.mci > (rows[0].main_chain_index + greatValue));
	}

	static clearOutputs(input_amount, outputs) {
		let sumAmount = 0;
		let _outputs;

		outputs.forEach(output => {
			sumAmount += output.amount;
		});

		if (input_amount === sumAmount) {
			_outputs = outputs.filter(output => {
				return output.amount > 0;
			});
		} else {
			_outputs = outputs.filter((output, index) => {
				return output.amount > 0 || index === outputs.length - 1;
			});
		}

		return _outputs;
	}

	static getMCIAndResponse() {
		return new Promise(resolve => {
			my_witnesses.readMyWitnesses((arrWitnesses) => {
				network.requestFromLightVendor(
					'light/get_parents_and_last_ball_and_witness_list_unit',
					{witnesses: arrWitnesses},
					(ws, request, response) => {
						return resolve({mci: response.last_stable_mc_ball_mci, response});
					})
			});
		});
	};

	info() {
		return {
			myDeviceAddress: this.myDeviceAddress,
			peerDeviceAddress: this.peerDeviceAddress,
			myAmount: this.myAmount,
			peerAmount: this.peerAmount,
			age: this.age,
			step: this.step
		}
	}

	static toSha256(text) {
		return crypto.createHash("sha256").update(text, "utf8").digest("base64")
	}
}

module.exports = Channel;