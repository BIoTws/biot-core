const crypto = require('crypto');
const core = require('../core');
const libAddress = require('../lib/address');
const libWallet = require('../lib/wallet');
const libKeys = require('../lib/keys');
const libToEs6 = require('./toEs6');
const libTransactions = require('./transactions');
const eventBus = require('byteballcore/event_bus');
const EventEmitter = require('events');
const composer = require('byteballcore/composer');
const my_witnesses = require('byteballcore/my_witnesses');
const network = require('byteballcore/network');
const Wallet = require('byteballcore/wallet');
const objectHash = require('byteballcore/object_hash');
const bbWallet = require('byteballcore/wallet');
const db = require('byteballcore/db');
const ChannelUtils = require('./ChannelUtils');

class Channel {
	constructor(walletId, myDeviceAddress, peerDeviceAddress, peerAddress, myAmount, peerAmount, age = 150, id = null, objRecovery, notUseUnstableUnits = false) {
		this.walletId = walletId;
		this.myDeviceAddress = myDeviceAddress;
		this.peerDeviceAddress = peerDeviceAddress;
		this.peerAddress = peerAddress;
		this.myAmount = myAmount;
		this.peerAmount = peerAmount;
		this.age = age;
		this.id = id || Channel.toSha256(JSON.stringify(this.info()) + Date.now());
		this.events = new EventEmitter();
		this.step = 'null';
		this.channelAddress = null;
		this.notUseUnstableUnits = notUseUnstableUnits;

		this.objMyContract = null;
		this.objPeerContract = null;

		this.waitingUnit = null;

		if (id) {
			this.step = 'get1Contract';
		}

		if (objRecovery) {
			for (let key in objRecovery) {
				if (objRecovery.hasOwnProperty(key)) {
					let v = objRecovery[key];
					this[key] = (v === 'null') ? null : v;
				}
			}
		} else {
			this.insertInDb().catch(e => {throw e});
		}

		if (this.step === 'waiting_mci') {
			this.waitingMCI(this.waitingUnit).catch(console.error);
		}

		if (this.step === 'wait_for_unit_to_punish') {
			this.punish(this.waitingUnit).catch(console.error);
		}

		this.startListeningEvents();
	}

	startListeningEvents() {
		eventBus.on('my_transactions_became_stable', arrUnits => {
			if (this.step === 'waiting_stable_unit_of_output' && this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
				this.step = 'waiting_mci';
				this.updateInDb().catch(console.error);
				this.waitingMCI(this.waitingUnit).catch(console.error);
			}
			else if (this.step === 'wait_for_unit_to_punish' && this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
				this.punish(this.waitingUnit).catch(console.error);
			}
			else if (this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
				this.step = 'waiting_transfers';
				this.events.emit('start');
				this.waitingUnit = null;
				this.updateInDb().catch(console.error);
			}
		});

		eventBus.on('new_joint', objJoint => {
			if (this.mutualClose) return;

			let authors = objJoint.unit.authors;
			if (ChannelUtils.isClosingPayment(this, authors)) {
				this.checkClosingPaymentAndPunishment(objJoint.unit).catch(console.error);
			}
			if (this.step !== 'close' && authors.findIndex(el => el.address === this.addresses[0]) !== -1 &&
				authors.findIndex(el => el.address === this.peerAddress) !== -1) {
				if (this.notUseUnstableUnits) {
					this.waitingUnit = objJoint.unit.unit;
					this.step = 'waiting_stable_unit';
				} else {
					this.step = 'waiting_transfers';
					this.events.emit('start');
				}
				this.channelAddress = Channel.findChannelAddress(objJoint.unit.messages[0].payload.outputs, this.addresses[0], this.peerAddress);
				this.updateInDb().catch(console.error);
			}
		});

		eventBus.on('text', async (from_address, text) => {
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
					} else if (objMessage.step === '1Contract') {
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
						core.sendTechMessageToDevice(this.peerDeviceAddress, {
							step: 'getInputsAndAddresses',
							contract: this.objMyContract,
							id: this.id
						});
						this.step = 'await_getInputsAndAddresses';
						await this.updateInDb();
					} else if (objMessage.step === 'getInputsAndAddresses') {
						let check = ChannelUtils.check1Contract(this, objMessage.contract.shared_address, objMessage.contract.arrDefinition);
						if (!check.status) {
							console.error(new Error('1Contract incorrect. code:' + check.code));
							return this.reject();
						}
						await this.saveHash(objMessage.contract.shared_address, objMessage.contract.arrDefinition);
						this.objPeerContract = objMessage.contract;
						await this.sendInputsAndAddresses();
						await this.updateInDb();
					} else if (objMessage.step === 'inputsAndAddresses') {
						await libWallet.addIfNotExistRemoteWallet(objMessage.objWalletRows);
						await libAddress.addIfNotExistRemoteAddresses(objMessage.arrAddressesRows);
						let objJoint = await this.createChannel(objMessage);
						if (this.notUseUnstableUnits) {
							this.waitingUnit = objJoint.unit.unit;
							this.step = 'waiting_stable_unit';
						} else {
							this.step = 'waiting_transfers';
							this.events.emit('start');
						}
						await this.updateInDb();
					} else if (objMessage.step === 'sharedAddress') {
						let check = ChannelUtils.checkSharedAddress(this, objMessage.shared_address, objMessage.arrDefinition);
						if (!check.status) {
							console.error(new Error('SharedAddress incorrect. code:' + check.code));
							return this.reject();
						}
						this.channelAddress = objMessage.shared_address;
					} else if (objMessage.step === 'transfer_start') {
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
					} else if (objMessage.step === 'transfer_end') {
						let objMyContract = objMessage.objMyContract;
						let check = ChannelUtils.check1Contract(this, objMyContract.shared_address, objMyContract.arrDefinition, objMessage.amount, true);
						if (!check.status) {
							console.error(new Error('1Contract incorrect. code:' + check.code));
							return this.reject();
						}
						await this.saveHash(objMyContract.shared_address, objMyContract.arrDefinition);
						this.objPeerContract = objMyContract;
						this.step = 'waiting_transfer';
					} else if (objMessage.step === 'close') {
						this.step = 'await_closing';
					} else if (objMessage.step === 'pass') {
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
		});

		eventBus.on("signing_request", async (objAddress, top_address, objUnit, assocPrivatePayloads, from_address, signing_path) => {
			if (this.step === 'reject' || from_address !== this.peerDeviceAddress) return;
			if (this.step === 'await_createChannel' && signing_path === 'r') {
				let check = ChannelUtils.checkPaymentToSharedAddress(this, objUnit.messages[0].payload.outputs);
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
				let check = ChannelUtils.checkTransferPayment(this, objUnit.messages[0].payload.outputs);
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
				let rowsPass = await libToEs6.dbQuery("SELECT pass FROM channel_pass WHERE id = ? AND address = ?", [this.id, this.prevSharedAddress]);
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
				let check = ChannelUtils.checkTransferPayment(this, objUnit.messages[0].payload.outputs);
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
				let rowsPass = await libToEs6.dbQuery("SELECT pass FROM channel_pass WHERE id = ? AND address = ?", [this.id, this.prevSharedAddress]);
				console.error('address', this.prevSharedAddress);
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'pass',
					id: this.id,
					address: this.prevSharedAddress,
					pass: rowsPass[0].pass
				});
			} else if (this.step === 'await_closing' && (signing_path === 'r.0.0' || signing_path === 'r.0.1' || signing_path === 'r')) {
				let check = ChannelUtils.checkClosingPayment(this, objUnit.messages[0].payload.outputs);
				if (!check.status) {
					console.error(new Error('await_closing incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
			} else if (this.step === 'await_closing' && (signing_path === 'r.1.0' || signing_path === 'r.2.0')) {
				let check = ChannelUtils.checkClosingPayment(this, objUnit.messages[0].payload.outputs);
				if (!check.status) {
					console.error(new Error('await_closing incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
				this.step = 'mutualClose';
				this.mutualClose = true;
				await this.updateInDb()
			} else if (this.step === 'waiting_transfer') {
				let check = ChannelUtils.checkTransferPayment(this, objUnit.messages[0].payload.outputs);
				if (!check.status) {
					console.error(new Error('waiting_transfer incorrect. code:' + check.code));
					this.reject();
					let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
					bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, top_address);
					return;
				}
			} else {
				console.error('else sig', this.step, signing_path);
				return;
			}

			let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
			libKeys.signWithLocalPrivateKey(null, objAddress.account, objAddress.is_change, objAddress.address_index, buf_to_sign, signature => {
				bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), signature, signing_path, top_address);
			});
		});
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
			myAddresses=?, objMyContract=?, objPeerContract=?, waitingUnit=?, objJoint=?, change_date = " + db.getNow() + " WHERE id=?",
			[this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step,
				JSON.stringify(this.addresses), JSON.stringify(this.objMyContract), JSON.stringify(this.objPeerContract), this.waitingUnit,
				JSON.stringify(this.objJoint), this.id]);
	}

	async saveHash(address, arrDefinition) {
		let hash = ChannelUtils.getHash(arrDefinition);
		return libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO channel_pass (id, address, hash) VALUES(?,?,?)", [this.id, address, hash]);
	}

	async saveMyPass(address, pass) {
		return libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO channel_pass (id, address, pass) VALUES(?,?,?)", [this.id, address, pass]);
	}

	async savePass(address, pass) {
		return libToEs6.dbQuery("UPDATE channel_pass SET pass = ? WHERE id = ? AND address = ?", [pass, this.id, address]);
	}

	async init() {
		if (!this.addresses) {
			this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
			await this.updateInDb();
		}
		if (!this.addresses || !this.addresses.length) {
			throw new Error('Insufficient funds');
		}
		if (this.step === 'null') {
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: 'get1Contract',
				id: this.id,
				myAmount: this.myAmount,
				peerAmount: this.peerAmount,
				myAddress: this.addresses[0],
				age: this.age
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
			this.objMyContract = await this.create1Contract(this.myAmount, this.peerAmount);
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: '1Contract',
				contract: this.objMyContract,
				myAddress: this.addresses[0],
				id: this.id
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
			let pass = crypto.randomBytes(256).toString('hex');
			let arrDefinition = ['or', [
				['and', [
					['or', [
						['address', this.addresses[0]],
						['address', this.peerAddress]
					]],
					['age', ['>', this.age]],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.addresses[0],
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
					address: this.addresses[0],
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
					return reject(err);
				},
				ifOk: async (shared_address) => {
					await this.saveMyPass(shared_address, pass);
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}

	async sendInputsAndAddresses() {
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, this.myAmount + 450);
		this.total_input = objPick.total_input;
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
		let objWalletRows = await libWallet.getWalletFromDB(this.walletId);
		let arrAddressesRows = await libAddress.getAddressesFromDb(myPayingAddresses);
		core.sendTechMessageToDevice(this.peerDeviceAddress, {
			step: 'inputsAndAddresses',
			inputs: objPick.arrInputs,
			total_input: objPick.total_input,
			myPayingAddresses,
			objWalletRows,
			arrAddressesRows,
			id: this.id
		});
		this.step = 'await_createChannel';
		return true;
	}

	createSharedAddress() {
		return new Promise((resolve, reject) => {
			let arrDefinition = ['or', [
				['and', [
					['address', this.addresses[0]],
					['address', this.peerAddress],
				]],
				['and', [
					['address', this.addresses[0]],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.objMyContract.shared_address,
						amount: this.myAmount + this.peerAmount
					}]
				]],
				['and', [
					['address', this.peerAddress],
					['has', {
						what: 'output',
						asset: 'base',
						address: this.objPeerContract.shared_address,
						amount: this.myAmount + this.peerAmount
					}]
				]]
			]];

			let assocSignersByPath = {
				'r.0.0': {
					address: this.addresses[0],
					member_signing_path: 'r',
					device_address: this.myDeviceAddress
				},
				'r.0.1': {
					address: this.peerAddress,
					member_signing_path: 'r',
					device_address: this.peerDeviceAddress
				},
				'r.1.0': {
					address: this.addresses[0],
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
					return reject(err);
				},
				ifOk: async (shared_address) => {
					core.sendTechMessageToDevice(this.peerDeviceAddress, {
						id: this.id,
						step: 'sharedAddress',
						shared_address,
						arrDefinition
					});
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}


	async createChannel(objMessage) {
		let objSharedAddress = await this.createSharedAddress();
		this.channelAddress = objSharedAddress.shared_address;
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, this.myAmount + 450);
		if (!objPick) {
			return Promise.reject('Insufficient funds');
		}
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
		return new Promise(((resolve, reject) => {
			let opts = {};
			opts.paying_addresses = myPayingAddresses.concat(objMessage.myPayingAddresses);
			opts.inputs = objPick.arrInputs.concat(objMessage.inputs);
			opts.input_amount = objPick.total_input + objMessage.total_input;
			opts.outputs = [{
				address: objSharedAddress.shared_address,
				amount: this.myAmount + this.peerAmount
			}, {
				address: objMessage.myPayingAddresses[0],
				amount: objMessage.total_input - this.peerAmount - 450
			}, {
				address: this.addresses[0],
				amount: 0
			}];
			opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
			opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey, false);
			opts.callbacks = {
				ifError: (err) => {
					return reject(err);
				},
				ifNotEnoughFunds: (err) => {
					return reject(err);
				},
				ifOk: (objJoint) => {
					network.broadcastJoint(objJoint);
					return resolve(objJoint);
				}
			};
			opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
			composer.composeJoint(opts);
		}));
	}

	async transfer(amount, message) {
		if (this.step !== 'waiting_transfers') {
			return {status: 'error', text: 'this.step !== "waiting_transfers"'};
		}
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
		return {status: 'ok', objJoint};
	}

	signMyTransfer(newMyAmount, newPeerAmount, objMyContract) {
		return new Promise(((resolve, reject) => {
			this.getInputs(this.channelAddress).then(objInputs => {
				let opts = {};
				opts.paying_addresses = [this.channelAddress, this.addresses[0]];
				opts.inputs = objInputs.arrInputs;
				opts.input_amount = objInputs.total_input;
				opts.outputs = [{
					address: objMyContract.shared_address,
					amount: newMyAmount + newPeerAmount
				}, {
					address: this.addresses[0],
					amount: 0
				}];
				opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
				opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress, this.peerDeviceAddress], libKeys.signWithLocalPrivateKey, false);
				opts.callbacks = {
					ifError: (err) => {
						return reject(err);
					},
					ifNotEnoughFunds: (err) => {
						return reject(err);
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
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, fromAddress, this.myAmount + this.peerAmount);
		let objPick2 = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, 1400);
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick2.arrInputs.map(input => input.unit));
		return {
			arrInputs: objPick.arrInputs.concat(objPick2.arrInputs),
			total_input: objPick.total_input + objPick2.total_input,
			myPayingAddresses
		};
	}

	closingPayment(objInputs, from_address, outputs, signers, pass) {
		return new Promise((resolve, reject) => {
			let opts = {};
			opts.outputs = outputs;
			opts.paying_addresses = [from_address];
			if (objInputs) {
				opts.paying_addresses = opts.paying_addresses.concat(objInputs.myPayingAddresses);
				opts.inputs = objInputs.arrInputs;
				opts.input_amount = objInputs.total_input;
				opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
			}
			if (pass) {
				opts.secrets = {'r.1.1': pass};
			}
			opts.signer = Wallet.getSigner(opts, signers, libKeys.signWithLocalPrivateKey, false);
			opts.callbacks = {
				ifError: (err) => {
					return reject(err);
				},
				ifNotEnoughFunds: (err) => {
					return reject(err);
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

	mutualClosure() {
		if (this.step === 'waiting_transfers') {
			return new Promise((resolve, reject) => {
				this.getInputs(this.channelAddress).then(async (objInputs) => {
					if (!objInputs || !objInputs.arrInputs.length) {
						return reject('Insufficient funds');
					}
					core.sendTechMessageToDevice(this.peerDeviceAddress, {
						id: this.id,
						step: 'close'
					});
					this.closingPayment(objInputs, this.channelAddress,
						[{address: this.peerAddress, amount: this.peerAmount}, {address: this.addresses[0], amount: 0}],
						[this.myDeviceAddress, this.peerDeviceAddress])
						.then(async (objJoint) => {
							this.step = 'mutualClose';
							this.mutualClose = true;
							await this.updateInDb();
							return resolve(objJoint);
						}).catch(reject);
				});
			});
		} else {
			setTimeout(() => {
				return this.mutualClosure();
			}, 1500);
		}
	}

	closeNow() {
		return new Promise((resolve, reject) => {
			if (this.objJoint) {
				let opts = {};
				opts.callbacks = {
					ifError: (err) => {
						return reject(err);
					},
					ifNotEnoughFunds: (err) => {
						return reject(err);
					},
					ifOk: async (objJoint) => {
						network.broadcastJoint(objJoint);
						this.waitingUnit = objJoint.unit.unit;
						if (this.notUseUnstableUnits) {
							this.step = 'waiting_stable_unit_of_output';
						} else {
							this.step = 'waiting_mci';
							this.waitingMCI(this.waitingUnit).catch(reject)
						}
						await this.updateInDb();
						return resolve(objJoint);
					}
				};
				opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
				opts.callbacks.ifOk(this.objJoint, null, () => {});
			} else {
				this.getInputs(this.channelAddress).then(async (objInputs) => {
					if (!objInputs || !objInputs.arrInputs.length) {
						return reject('Insufficient funds');
					}
					this.closingPayment(objInputs, this.channelAddress,
						[{
							address: this.objMyContract.shared_address,
							amount: this.myAmount + this.peerAmount
						}, {
							address: this.addresses[0],
							amount: 0
						}],
						[this.myDeviceAddress])
						.then(async (objJoint) => {
							this.waitingUnit = objJoint.unit.unit;
							if (this.notUseUnstableUnits) {
								this.step = 'waiting_stable_unit_of_output';
							} else {
								this.step = 'waiting_mci';
								this.waitingMCI(this.waitingUnit).catch(reject)
							}
							await this.updateInDb();
							return resolve(objJoint);
						}).catch(reject);
				});
			}
		});
	}

	async waitingMCI(unit) {
		this.intervalMCI = setInterval(async () => {
			if (await Channel.checkMCIGreat(unit, this.age)) {
				if (this.intervalMCI) {
					clearInterval(this.intervalMCI);
				}
				await this.finalCloseNow();
			}
		}, 60000);
		if (await Channel.checkMCIGreat(unit, this.age)) {
			if (this.intervalMCI) {
				clearInterval(this.intervalMCI);
			}
			await this.finalCloseNow();
		}
	}

	finalCloseNow() {
		return new Promise((resolve, reject) => {
			this.getInputs(this.objMyContract.shared_address).then(async (objInputs) => {
				if (!objInputs || !objInputs.arrInputs.length) {
					return reject('Insufficient funds');
				}
				this.closingPayment(objInputs, this.objMyContract.shared_address,
					[{
						address: this.peerAddress,
						amount: this.peerAmount
					}, {
						address: this.addresses[0],
						amount: this.myAmount
					}, {
						address: this.addresses[0],
						amount: 0
					}],
					[this.myDeviceAddress])
					.then(async () => {
						this.step = 'close';
						this.waitingUnit = null;
						await this.updateInDb();
					}).catch(reject);
			});
		});
	}

	async checkPassHash(address, pass) {
		let rowsPass = await libToEs6.dbQuery("SELECT hash FROM channel_pass WHERE id = ? AND address = ?", [this.id, address]);
		return (rowsPass[0].hash === crypto.createHash("sha256").update(pass, "utf8").digest("base64"));
	}

	async punishPayment(address, pass) {
		this.closingPayment(null, address,
			[{
				address: this.addresses[0],
				amount: 0
			}],
			[this.myDeviceAddress], pass)
			.then(async (objJoint) => {
				this.step = 'close';
				this.waitingUnit = null;
				await this.updateInDb();
				console.error('punishUnit', objJoint.unit);
			}).catch(Promise.reject);
	}

	async checkClosingPaymentAndPunishment(objUnit) {
		if (this.objJoint) {
			let arrAddresses = objUnit.messages[0].payload.outputs.map(output => output.address);
			if (arrAddresses.indexOf(this.objPeerContract.shared_address) !== -1) {
				console.error('checkClosingPayment', 'ok');
			} else {
				await this.punish(objUnit.unit);
			}
		}
	}

	async punish(unit) {
		let rowsOutputs = await libToEs6.dbQuery("SELECT address FROM outputs WHERE unit = ?", [unit]);
		let arrAddresses = rowsOutputs.map(row => row.address);
		let rows = await libToEs6.dbQuery("SELECT address, pass FROM channel_pass WHERE id = ? AND address IN (?)", [this.id, arrAddresses]);
		if (rows.length === 1) {
			let rowsUnits = await libToEs6.dbQuery("SELECT is_stable FROM units WHERE unit = ?", unit);
			if (rowsUnits[0].is_stable) {
				await this.punishPayment(rows[0].address, rows[0].pass);
			} else {
				this.step = 'wait_for_unit_to_punish';
				this.waitingUnit = unit;
				await this.updateInDb();
			}
		} else {
			console.error('error checkClosingPaymentAndPunishment', unit, rows);
		}
	}

	static pickDivisibleCoinsForAmount(db, asset, addresses, amount) {
		return new Promise((resolve => {
			if (this.notUseUnstableUnits) {
				Channel.getMCIAndResponse().then(async (MCIAndResponse) => {
					composer.pickDivisibleCoinsForAmount(db, asset, addresses, MCIAndResponse.last_stable_mc_ball_mci, amount, false,
						(arrInputsWithProofs, total_input) => {
							let arrInputs = arrInputsWithProofs.map(function (objInputWithProof) { return objInputWithProof.input;});
							return resolve({
								arrInputs,
								total_input
							});
						});
				});
			} else {
				libTransactions.pickDivisibleCoinsForAmount(asset.asset, addresses, amount).then(objPick => {
					return resolve({
						arrInputs: objPick.arrInputs,
						total_input: objPick.total_input
					});
				}).catch(() => {return resolve(null)});
			}
		}));
	}

	static async checkMCIGreat(unit, greatValue) {
		let rows = await libToEs6.dbQuery("SELECT main_chain_index FROM units WHERE unit = ?", [unit]);
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

	static findChannelAddress(outputs, myAddress, peerAddress) {
		let _obj = outputs.find(obj => {
			return obj.address !== myAddress && obj.address !== peerAddress;
		});
		if (!_obj) {
			throw 'Address not found';
		}
		return _obj.address;
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