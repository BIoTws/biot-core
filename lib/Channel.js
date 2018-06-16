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
const Wallet = require('byteballcore/wallet');
const objectHash = require('byteballcore/object_hash');
const bbWallet = require('byteballcore/wallet');
const db = require('byteballcore/db');
const mutex = require('byteballcore/mutex');
const ChannelUtils = require('./ChannelUtils');

let openingChannel = false;

class Channel {
	constructor(walletId, myDeviceAddress, peerDeviceAddress, peerAddress, myAmount, peerAmount, age = 150, id = null, objRecovery) {
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

		this.objMyContract = null;
		this.objPeerContract = null;

		this.waitingUnit = null;

		if (id) {
			this.step = 'get1Contract';
		}

		if (objRecovery && objRecovery.needConfirmation === undefined) {
			for (let key in objRecovery) {
				if (objRecovery.hasOwnProperty(key)) {
					let v = objRecovery[key];
					this[key] = (v === 'null') ? null : v;
				}
			}
		} else {
			if (objRecovery && objRecovery.needConfirmation) {
				this.needConfirmation = true;
			}
			this.insertInDb().catch(e => {throw e});
		}

		if (this.step === 'waiting_mci') {
			this.waitingMCI(this.waitingUnit).catch(console.error);
		}

		this.cb_my_transactions_became_stable = this.cb_my_transactions_became_stable.bind(this);
		this.cb_new_my_transactions = this.cb_new_my_transactions.bind(this);
		this.cb_new_joint = this.cb_new_joint.bind(this);
		this.cb_text = this.cb_text.bind(this);
		this.cb_signing_request = this.cb_signing_request.bind(this);
		this.startListeningEvents();
	}

	cb_my_transactions_became_stable(arrUnits) {
		if (this.step === 'waiting_stable_unit_of_output' && this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
			this.step = 'waiting_mci';
			this.updateInDb().catch(console.error);
			this.waitingMCI(this.waitingUnit).catch(console.error);
		}
		else if (this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
			this.step = 'waiting_transfers';
			this.events.emit('start');
			this.waitingUnit = null;
			if (this.unlockStartChannel) {
				this.unlockStartChannel();
				this.unlockStartChannel = null;
			}
			this.updateInDb().catch(console.error);
		}
	}

	cb_new_my_transactions(arrUnits) {
		arrUnits.forEach(async unit => {
			let rows = await libToEs6.dbQuery("SELECT address FROM unit_authors WHERE unit = ?", [unit]);
			let arrAddresses = rows.map(author => author.address);
			if (ChannelUtils.isClosingPayment(this, arrAddresses)) {
				this.checkClosingPaymentAndPunish(unit).catch(console.error);
			}
		});
	}

	cb_new_joint(objJoint) {
		if (this.mutualClose) return;
		let authors = objJoint.unit.authors;
		let outputs = objJoint.unit.messages[0].payload.outputs;
		if (outputs.findIndex(el => el.address === this.channelAddress) !== -1 &&
			this.step !== 'close' &&
			authors.findIndex(el => el.address === this.addresses[0]) !== -1 &&
			authors.findIndex(el => el.address === this.peerAddress) !== -1) {
			if (this.needConfirmation) {
				this.waitingUnit = objJoint.unit.unit;
				this.step = 'waiting_stable_unit';
			} else {
				this.step = 'waiting_transfers';
				this.events.emit('start');
				if (this.unlockApprove) {
					this.unlockApprove();
					this.unlockApprove = null;
				}
			}
			this.updateInDb().catch(console.error);
		}
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
					this.removeListeners();
				} else if (objMessage.step === 'channelAddress') {
					this.channelAddress = objMessage.channelAddress;
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
					await libAddress.addIfNotExistRemoteAddresses(objMessage.arrAddressesRows, this.peerDeviceAddress);
					let objSharedAddress = await this.createSharedAddress();
					this.channelAddress = objSharedAddress.shared_address;
					core.sendTechMessageToDevice(this.peerDeviceAddress, {
						step: 'channelAddress',
						channelAddress: this.channelAddress,
						id: this.id
					});
					let objJoint = await this.createChannel(objMessage);
					if (this.needConfirmation) {
						this.waitingUnit = objJoint.unit.unit;
						this.step = 'waiting_stable_unit';
					} else {
						this.step = 'waiting_transfers';
						this.events.emit('start');
						if (this.unlockStartChannel) {
							this.unlockStartChannel();
							this.unlockStartChannel = null;
						}
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
	}

	async cb_signing_request(objAddress, top_address, objUnit, assocPrivatePayloads, from_address, signing_path) {
		if (this.step === 'reject' || from_address !== this.peerDeviceAddress) return;

		let outputs = objUnit.messages[0].payload.outputs;
		let channelOutput = outputs.find(output => output.address === this.channelAddress);
		let peerSharedAddressOutput;
		if (this.objPeerContract) {
			peerSharedAddressOutput = outputs.find(output => output.address === this.objPeerContract.shared_address);
		}
		let myAddressOutput = outputs.find(output => output.address === this.addresses[0]);
		let peerAddressOutput = outputs.find(output => output.address === this.peerAddress);
		if (channelOutput || peerSharedAddressOutput || (this.step === 'await_closing' && myAddressOutput && peerAddressOutput && outputs.length === 2)) {
			if (this.step === 'await_createChannel' && signing_path === 'r') {
				let check = ChannelUtils.checkPaymentToSharedAddress(this, outputs);
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
		eventBus.on('my_transactions_became_stable', this.cb_my_transactions_became_stable);

		eventBus.on('new_my_transactions', this.cb_new_my_transactions);

		eventBus.on('new_joint', this.cb_new_joint);

		eventBus.on('text', this.cb_text);

		eventBus.on("signing_request", this.cb_signing_request);
	}

	removeListeners() {
		console.error('removeListeners');
		eventBus.removeListener('my_transactions_became_stable', this.cb_my_transactions_became_stable);
		eventBus.removeListener('new_my_transactions', this.cb_new_my_transactions);
		eventBus.removeListener('new_joint', this.cb_new_joint);
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
			myAddresses=?, objMyContract=?, objPeerContract=?, waitingUnit=?, joint=?, change_date = " + db.getNow() + " WHERE id=?",
			[this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step,
				JSON.stringify(this.addresses), JSON.stringify(this.objMyContract), JSON.stringify(this.objPeerContract), this.waitingUnit,
				JSON.stringify(this.objJoint), this.id]);
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
		if (!this.addresses) {
			this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
			await this.updateInDb();
		}
		if (!this.addresses || !this.addresses.length) {
			throw new Error('Insufficient funds');
		}
		if (this.step === 'null') {
			this.unlockStartChannel = await Channel.lockStartChannel();
			openingChannel = true;
			let MCIAndResponse = await Channel.getMCIAndResponse();
			let rows = await libToEs6.dbQuery("SELECT 1 FROM units CROSS JOIN unit_authors USING(unit) \n\
					WHERE  (main_chain_index>? OR main_chain_index IS NULL) AND address IN(?) AND definition_chash IS NOT NULL \n\
					UNION \n\
					SELECT 1 FROM units JOIN address_definition_changes USING(unit) \n\
					WHERE (main_chain_index>? OR main_chain_index IS NULL) AND address IN(?) \n\
					UNION \n\
					SELECT 1 FROM units CROSS JOIN unit_authors USING(unit) \n\
					WHERE (main_chain_index>? OR main_chain_index IS NULL) AND address IN(?) AND sequence!='good'",
				[MCIAndResponse.mci, [this.addresses[0]], MCIAndResponse.mci, [this.addresses[0]], MCIAndResponse.mci, [this.addresses[0]]]);
			let needConfirmation = !!rows.length;
			this.needConfirmation = needConfirmation;
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: 'get1Contract',
				id: this.id,
				myAmount: this.myAmount,
				peerAmount: this.peerAmount,
				myAddress: this.addresses[0],
				age: this.age,
				needConfirmation
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
				let i = parseInt(Buffer.from(this.myDeviceAddress).toString('hex'));
				let peer = parseInt(Buffer.from(this.peerDeviceAddress).toString('hex'));
				if (peer > i) {
					this.unlockApprove = await Channel.lockStartChannel();
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
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
		this.removeListeners();
	}

	create1Contract(myAmount, peerAmount) {
		return new Promise((resolve, reject) => {
			let pass = crypto.randomBytes(10).toString('hex');
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
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, this.myAmount + 450);
		this.total_input = objPick.total_input;
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
		let arrAddressesRows = await libAddress.getAddressesFromDb(myPayingAddresses);
		core.sendTechMessageToDevice(this.peerDeviceAddress, {
			step: 'inputsAndAddresses',
			inputs: objPick.arrInputs,
			total_input: objPick.total_input,
			myPayingAddresses,
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
					return reject(new Error(err));
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
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, this.myAmount + 450, true);
		if (!objPick) {
			return Promise.reject(new Error('Insufficient funds'));
		}
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick.arrInputs.map(input => input.unit));
		return new Promise(((resolve, reject) => {
			let opts = {};
			opts.paying_addresses = myPayingAddresses.concat(objMessage.myPayingAddresses);
			opts.inputs = objPick.arrInputs.concat(objMessage.inputs);
			opts.input_amount = objPick.total_input + objMessage.total_input;
			opts.outputs = [{
				address: this.channelAddress,
				amount: this.myAmount + this.peerAmount
			}, {
				address: objMessage.myPayingAddresses[0],
				amount: objMessage.total_input - this.peerAmount - 450
			}, {
				address: this.addresses[0],
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
				opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress, this.peerDeviceAddress], libKeys.signWithLocalPrivateKey);
				opts.callbacks = {
					ifError: (err) => {
						return reject(new Error(err));
					},
					ifNotEnoughFunds: (err) => {
						return reject(new Error(err));
					},
					ifOk: (objJoint, assocPrivatePayloads, unlock_callback) => {
						unlock_callback();
						objInputs.unlock();
						return resolve(objJoint);
					}
				};
				composer.composeJoint(opts);
			})
		}));
	}

	async getInputs(fromAddress) {
		let objPick = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, fromAddress, this.myAmount + this.peerAmount);
		let objPick2 = await Channel.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, 1400, true);
		let myPayingAddresses = await libAddress.getAddressesOfUnits(objPick2.arrInputs.map(input => input.unit));
		return {
			arrInputs: objPick.arrInputs.concat(objPick2.arrInputs),
			total_input: objPick.total_input + objPick2.total_input,
			myPayingAddresses,
			unlock: objPick2.unlock
		};
	}

	closeChannel(objInputs, from_addresses, outputs, signers, pass) {
		return new Promise((resolve, reject) => {
			let opts = {};
			opts.outputs = outputs;
			opts.paying_addresses = from_addresses;
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
						[{address: this.peerAddress, amount: this.peerAmount}, {address: this.addresses[0], amount: 0}],
						[this.myDeviceAddress, this.peerDeviceAddress])
						.then(async (objJoint) => {
							objInputs.unlock();
							this.step = 'mutualClose';
							this.mutualClose = true;
							await this.updateInDb();
							this.removeListeners();
							return resolve(objJoint);
						}).catch((e) => {
						return reject(new Error(e))
					});
				});
			});
		} else {
			setTimeout(() => {
				return this.closeMutually();
			}, 1500);
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
						this.waitingMCI(this.waitingUnit).catch((e) => reject(new Error(e)));
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
							amount: this.myAmount + this.peerAmount
						}, {
							address: this.addresses[0],
							amount: 0
						}],
						[this.myDeviceAddress])
						.then(async (objJoint) => {
							objInputs.unlock();
							this.waitingUnit = objJoint.unit.unit;
							this.step = 'waiting_mci';
							this.waitingMCI(this.waitingUnit).catch(e => reject(new Error(e)));
							await this.updateInDb();
							return resolve(objJoint);
						}).catch(e => reject(new Error(e)));
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
				await this.closeOneSideFinal();
			}
		}, 60000);
		if (await Channel.checkMCIGreat(unit, this.age)) {
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
						address: this.addresses[0],
						amount: this.myAmount
					}, {
						address: this.addresses[0],
						amount: 0
					}],
					[this.myDeviceAddress])
					.then(async () => {
						objInputs.unlock();
						this.step = 'close';
						this.waitingUnit = null;
						await this.updateInDb();
						this.removeListeners();
					}).catch(e => reject(new Error(e)));
			});
		});
	}

	async checkPassHash(address, pass) {
		let rowsPass = await libToEs6.dbQuery("SELECT hash FROM address_passes WHERE id = ? AND address = ?", [this.id, address]);
		return (rowsPass[0].hash === crypto.createHash("sha256").update(pass, "utf8").digest("base64"));
	}

	async punishPeer(address, pass) {
		return this.closeChannel(null, [address, this.addresses[0]],
			[{
				address: this.addresses[0],
				amount: 0
			}],
			[this.myDeviceAddress], pass)
			.then(async (objJoint) => {
				this.step = 'close';
				this.waitingUnit = null;
				await this.updateInDb();
				this.removeListeners();
				console.error('punishUnit', objJoint.unit);
				return true;
			}).catch(e => Promise.reject(new Error(e)));
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

	static async checkMCIGreat(unit, greatValue) {
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