const crypto = require('crypto');
const core = require('../core');
const libAddress = require('../lib/address');
const libWallet = require('../lib/wallet');
const libKeys = require('../lib/keys');
const libToEs6 = require('./toEs6');
const eventBus = require('byteballcore/event_bus');
const EventEmitter = require('events');
const composer = require('byteballcore/composer');
const my_witnesses = require('byteballcore/my_witnesses');
const network = require('byteballcore/network');
const Wallet = require('byteballcore/wallet');
const objectHash = require('byteballcore/object_hash');
const bbWallet = require('byteballcore/wallet');
const db = require('byteballcore/db');
let dStart;

class Channel {
	constructor(walletId, myDeviceAddress, peerDeviceAddress, peerAddress, myAmount, peerAmount, age = 150, id = null, objRecovery) {
		this.walletId = walletId;
		this.myDeviceAddress = myDeviceAddress;
		this.peerDeviceAddress = peerDeviceAddress;
		this.peerAddress = peerAddress;
		this.myAmount = myAmount;
		this.peerAmount = peerAmount;
		this.age = age;
		this.step = 'null';
		this.id = id || Channel.toSha256(JSON.stringify(this.info()) + Date.now());
		this.events = new EventEmitter();
		this.channelAddress = null;

		this.objMyContract = null;
		this.objPeerContract = null;

		this.waitingUnit = null;

		if (id) {
			this.step = 'get1Contract';
		}

		if (objRecovery) {
			let v;
			for (let key in objRecovery) {
				if (objRecovery.hasOwnProperty(key)) {
					v = objRecovery[key];
					this[key] = (v === 'null') ? null : v;
				}
			}
		} else {
			this.insertInDb().catch(e => {throw e});
		}

		if (this.step === 'waiting_mci') {
			this.waitingMCI(this.waitingUnit).catch(console.error);
		}

		eventBus.on('new_my_transactions', arrUnits => {
			console.error('new_my_transactions units: ', arrUnits);
		});

		eventBus.on('my_transactions_became_stable', arrUnits => {
			if (this.step === 'waiting_stable_unit_of_output' && this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
				this.step = 'waiting_mci';
				this.updateInDb().catch(console.error);
				this.waitingMCI(this.waitingUnit).catch(console.error);
			}
			else if (this.waitingUnit && arrUnits.indexOf(this.waitingUnit) !== -1) {
				console.error('stable: ', arrUnits);
				this.step = 'waiting_transfers';
				this.events.emit('start');
				this.waitingUnit = null;
				this.updateInDb().catch(console.error);
			} else {
				console.error('___stable', arrUnits);
			}
		});

		eventBus.on('new_joint', objJoint => {
			let authors = objJoint.unit.authors;
			if (authors.findIndex(el => el.address === this.addresses[0]) !== -1 && authors.findIndex(el => el.address === this.peerAddress) !== -1) {
				this.waitingUnit = objJoint.unit.unit;
				this.step = 'waiting_stable_unit';
				this.channelAddress = Channel.findChannelAddress(objJoint.unit.messages[0].payload.outputs, this.addresses[0], this.peerAddress);
				this.updateInDb().catch(console.error);
				console.error('!!!_!_!__!_!_new_JOINT', objJoint.unit, this.waitingUnit);
			} else {
				console.error('new_JOINT', objJoint.unit);
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
						console.error('sent error');
						this.events.emit('error', {type: 'reject', step: objMessage.step});
					} else if (objMessage.step === '1Contract') {
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
						this.objPeerContract = objMessage.contract;
						await this.sendInputsAndAddresses();
						await this.updateInDb();
					} else if (objMessage.step === 'inputsAndAddresses') {
						await libWallet.addIfNotExistRemoteWallet(objMessage.objWalletRows);
						await libAddress.addIfNotExistRemoteAddresses(objMessage.arrAddressesRows);
						let objJoint = await this.createChannel(objMessage);
						console.error('objJOINT!!!@!@!@', objJoint);
						this.waitingUnit = objJoint.unit.unit;
						this.step = 'waiting_stable_unit';
						await this.updateInDb();
						console.error('this.waitingUnit', this.waitingUnit);
					} else if (objMessage.step === 'transfer_start') {
						this.step = 'waiting_transfer';
						this.objPeerContract = objMessage.objMyContract;
						this.transferAmount = objMessage.amount;
					} else if (objMessage.step === 'transfer_end') {
						this.objPeerContract = objMessage.objMyContract;
						this.step = 'waiting_transfer';
					} else if (objMessage.step === 'close') {
						this.step = 'await_closing';
					} else if (objMessage.step === 'pass') {
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
			console.error('objADDR', objAddress, signing_path);
			if (this.step === 'waiting_transfer' && signing_path === 'r.2.0') {
				console.error('____waiting_transfer', objAddress, top_address, assocPrivatePayloads, from_address, signing_path, objUnit);
				console.error('ok transfer');
				this.newMyAmount = this.myAmount + this.transferAmount;
				this.newPeerAmount = this.peerAmount - this.transferAmount;

				this.prevSharedAddress = this.objMyContract.shared_address;
				this.objMyContract = await this.create1Contract(this.newMyAmount, this.newPeerAmount);

				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'transfer_end',
					amount: this.transferAmount,
					id: this.id,
					objMyContract: this.objMyContract
				});
				this.step = 'waiting_reverse_transfer';
				let objJoint = await this.signMyTransfer(this.newMyAmount, this.newPeerAmount, this.objMyContract);
				this.objJoint = objJoint;
				this.step = 'waiting_pass';
				await this.updateInDb();
				console.error('objJoint', objJoint);
				console.error('transferAmount', this.transferAmount);
				let pass = await libToEs6.dbQuery("SELECT pass FROM channel_pass WHERE id = ? AND address = ?", [this.id, this.prevSharedAddress]);
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'pass',
					id: this.id,
					address: this.prevSharedAddress,
					pass: pass[0].pass
				});

			} else if (signing_path === 'r.1.0' && this.step === 'waiting_transfer') {
				this.step = 'waiting_pass';
				console.error('transferAmount', this.transferAmount);
				console.error('Transfer time', Date.now() - dStart);
				console.error('tdttdtdtdtdtdtdt', this.step, this.transferAmount, this.newMyAmount);
				this.newMyAmount = this.myAmount - this.transferAmount;
				this.newPeerAmount = this.peerAmount + this.transferAmount;
				let pass = await libToEs6.dbQuery("SELECT pass FROM channel_pass WHERE id = ? AND address = ?", [this.id, this.prevSharedAddress]);
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					step: 'pass',
					id: this.id,
					address: this.prevSharedAddress,
					pass: pass[0].pass
				});
			} else if (this.step === 'await_closing') {
				this.step = 'close';
				await this.updateInDb()
			}

			let buf_to_sign = objectHash.getUnitHashToSign(objUnit);
			libKeys.signWithLocalPrivateKey(null, objAddress.account, objAddress.is_change, objAddress.address_index, buf_to_sign, signature => {
				bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), signature, signing_path, top_address)
			});
		});
	}

	async insertInDb() {
		await libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO channels (id, address, peerDeviceAddress, peerAddress, myAmount, peerAmount, age, step, change_date)\n\
		VALUES(?,?,?,?,?,?,?,?," + db.getNow() + ")",
			[this.id, this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step]);
	}

	async updateInDb() {
		await libToEs6.dbQuery("UPDATE channels SET address=?, peerDeviceAddress=?, peerAddress=?, myAmount=?, peerAmount=?, age=?, step=?,\n\
			myAddresses=?, objMyContract=?, objPeerContract=?, waitingUnit=?, objJoint=?, change_date = " + db.getNow() + " WHERE id=?",
			[this.channelAddress, this.peerDeviceAddress, this.peerAddress, this.myAmount, this.peerAmount, this.age, this.step,
				JSON.stringify(this.addresses), JSON.stringify(this.objMyContract), JSON.stringify(this.objPeerContract), this.waitingUnit,
				JSON.stringify(this.objJoint), this.id]);
	}

	async savePass(address, pass) {
		await libToEs6.dbQuery("INSERT " + db.getIgnore() + " INTO channel_pass (id, address, pass) VALUES(?,?,?)", [this.id, address, pass]);
	}

	async init() {
		if (!this.addresses) {
			this.addresses = await libAddress.getNonEmptyAddressesInWallet(this.walletId);
			await this.updateInDb();
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
		console.error('send', 1);
		if (this.step === 'get1Contract') {
			console.error('send', 2);
			this.objMyContract = await this.create1Contract(this.myAmount, this.peerAmount);
			console.error('send', 3);
			core.sendTechMessageToDevice(this.peerDeviceAddress, {
				step: '1Contract',
				contract: this.objMyContract,
				myAddress: this.addresses[0],
				id: this.id
			});
			console.error('send', 4);
			this.step = 'await_get1Contract';
			await this.updateInDb();
		}
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
					console.error('err', err);
					return reject(err);
				},
				ifOk: async (shared_address) => {
					await this.savePass(shared_address, pass);
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}

	sendInputsAndAddresses() {
		return new Promise(resolve => {
			my_witnesses.readMyWitnesses((arrWitnesses) => {
				network.requestFromLightVendor(
					'light/get_parents_and_last_ball_and_witness_list_unit',
					{witnesses: arrWitnesses},
					(ws, request, response) => {
						composer.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, response.last_stable_mc_ball_mci, this.myAmount + 450, false,
							async (arrInputsWithProofs, total_input) => {
								let inputs = arrInputsWithProofs.map(function (objInputWithProof) { return objInputWithProof.input;});
								let myPayingAddresses = await libAddress.getAddressesOfUnits(inputs.map(input => input.unit));
								let objWalletRows = await libWallet.getWalletFromDB(this.walletId);
								let arrAddressesRows = await libAddress.getAddressesFromDb(myPayingAddresses);
								core.sendTechMessageToDevice(this.peerDeviceAddress, {
									step: 'inputsAndAddresses',
									inputs,
									total_input,
									myPayingAddresses,
									objWalletRows,
									arrAddressesRows,
									id: this.id
								});
								this.step = 'await_createChannel';
								return resolve();
							})
					}
				);
			});
		});
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
					console.error('err', err);
					return reject(err);
				},
				ifOk: async (shared_address) => {
					return resolve({shared_address, arrDefinition, assocSignersByPath});
				}
			});
		});
	}

	createChannel(objMessage) {
		return new Promise((resolve, reject) => {
			my_witnesses.readMyWitnesses((arrWitnesses) => {
				network.requestFromLightVendor(
					'light/get_parents_and_last_ball_and_witness_list_unit',
					{witnesses: arrWitnesses},
					async (ws, request, response) => {
						let objSharedAddress = await this.createSharedAddress();
						this.channelAddress = objSharedAddress.shared_address;
						composer.pickDivisibleCoinsForAmount(db, {asset: null}, this.addresses, response.last_stable_mc_ball_mci, this.myAmount + 450, false,
							async (arrInputsWithProofs, _total_input) => {
								if (!arrInputsWithProofs || !arrInputsWithProofs.length) {
									return reject('Insufficient funds');
								}
								let inputs = arrInputsWithProofs.map(function (objInputWithProof) { return objInputWithProof.input;});
								let myPayingAddresses = await libAddress.getAddressesOfUnits(inputs.map(input => input.unit));
								let opts = {};
								opts.lightProps = response;
								opts.paying_addresses = myPayingAddresses.concat(objMessage.myPayingAddresses);
								opts.inputs = inputs.concat(objMessage.inputs);
								opts.input_amount = _total_input + objMessage.total_input;
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
										console.error('_err', err);
										return reject(err);
									},
									ifNotEnoughFunds: (err) => {
										console.error('_ifNotEnoughFunds', err);
										return reject(err);
									},
									ifOk: (objJoint) => {
										network.broadcastJoint(objJoint);
										console.error('_objJoint', objJoint);
										return resolve(objJoint);
									}
								};
								opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
								console.error('opts', opts);
								composer.composeJoint(opts);
							});
					}
				)
			});
		});
	}

	async transfer(amount) {
		dStart = Date.now();
		if (this.step !== 'waiting_transfers') {
			return {status: 'error', text: 'this.step !== "waiting_transfers"'};
		}
		let newMyAmount = this.myAmount - amount;
		let newPeerAmount = this.peerAmount + amount;
		this.transferAmount = amount;

		this.prevSharedAddress = this.objMyContract.shared_address;
		this.objMyContract = await this.create1Contract(newMyAmount, newPeerAmount);

		core.sendTechMessageToDevice(this.peerDeviceAddress, {
			step: 'transfer_start',
			amount,
			id: this.id,
			objMyContract: this.objMyContract
		});
		this.step = 'waiting_reverse_transfer';

		let objJoint = await this.signMyTransfer(newMyAmount, newPeerAmount, this.objMyContract);
		this.objJoint = objJoint;
		await this.updateInDb();
		return objJoint;
	}

	signMyTransfer(newMyAmount, newPeerAmount, objMyContract) {
		return new Promise(((resolve, reject) => {
			my_witnesses.readMyWitnesses((arrWitnesses) => {
				network.requestFromLightVendor(
					'light/get_parents_and_last_ball_and_witness_list_unit',
					{witnesses: arrWitnesses},
					async (ws, request, response) => {
						let opts = {};
						opts.lightProps = response;
						opts.paying_addresses = [this.channelAddress, this.addresses[0]];
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
								console.error('_err', err);
								return reject(err);
							},
							ifNotEnoughFunds: (err) => {
								console.error('_ifNotEnoughFunds', err);
								return reject(err);
							},
							ifOk: (objJoint, assocPrivatePayloads, unlock_callback) => {
								unlock_callback();
								console.error('_objJoint', objJoint);
								return resolve(objJoint);
							}
						};

						console.error('opts', opts);
						composer.composeJoint(opts);
					}
				)
			});
		}));
	}

	getInputs(fromAddress) {
		return new Promise(resolve => {
			my_witnesses.readMyWitnesses((arrWitnesses) => {
				network.requestFromLightVendor(
					'light/get_parents_and_last_ball_and_witness_list_unit',
					{witnesses: arrWitnesses},
					(ws, request, response) => {
						let lsmbm = response.last_stable_mc_ball_mci;
						composer.pickDivisibleCoinsForAmount(db, {asset: null}, [fromAddress], lsmbm, this.myAmount + this.peerAmount, false,
							(arrInputsWithProofs, total_input) => {
								composer.pickDivisibleCoinsForAmount(db, {asset: null}, [this.addresses[0]], lsmbm, 1000, false,
									(_arrInputsWithProofs, _total_input) => {
										return resolve({
											arrInputs: arrInputsWithProofs.concat(_arrInputsWithProofs),
											total_input: total_input + _total_input,
											response
										});
									});
							});
					}
				)
			});
		});
	}

	mutualClosure() {
		return new Promise((resolve, reject) => {
			this.getInputs(this.channelAddress).then(async (objInputs) => {
				if (!objInputs || !objInputs.arrInputs.length) {
					return reject('Insufficient funds');
				}
				core.sendTechMessageToDevice(this.peerDeviceAddress, {
					id: this.id,
					step: 'close'
				});
				let inputs = objInputs.arrInputs.map(function (objInputWithProof) { return objInputWithProof.input;});
				let myPayingAddresses = [this.channelAddress, this.addresses[0]];
				let opts = {};
				opts.lightProps = objInputs.response;
				opts.paying_addresses = myPayingAddresses;
				opts.inputs = inputs;
				opts.input_amount = objInputs.total_input;
				opts.outputs = [{
					address: this.peerAddress,
					amount: this.peerAmount
				}, {
					address: this.addresses[0],
					amount: 0
				}];
				opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
				opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress, this.peerDeviceAddress], libKeys.signWithLocalPrivateKey, false);
				opts.callbacks = {
					ifError: (err) => {
						console.error('_err', err);
						return reject(err);
					},
					ifNotEnoughFunds: (err) => {
						console.error('_ifNotEnoughFunds', err);
						return reject(err);
					},
					ifOk: async (objJoint) => {
						network.broadcastJoint(objJoint);
						console.error('_objJoint', objJoint);
						this.step = 'close';
						await this.updateInDb();
						return resolve(objJoint);
					}
				};
				opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
				console.error('opts', opts);
				composer.composeJoint(opts);
			});
		});
	}

	closeNow() {
		return new Promise((resolve, reject) => {
			if (this.objJoint) {
				let opts = {};
				opts.callbacks = {
					ifError: (err) => {
						console.error('_err', err);
						return reject(err);
					},
					ifNotEnoughFunds: (err) => {
						console.error('_ifNotEnoughFunds', err);
						return reject(err);
					},
					ifOk: async (objJoint) => {
						network.broadcastJoint(objJoint);
						console.error('_objJoint', objJoint);
						this.step = 'waiting_stable_unit_of_output';
						console.error('waiting_stable_unit_of_output');
						this.waitingUnit = objJoint.unit.unit;
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
					let inputs = objInputs.arrInputs.map(function (objInputWithProof) { return objInputWithProof.input;});
					let myPayingAddresses = [this.channelAddress, this.addresses[0]];
					let opts = {};
					opts.lightProps = objInputs.response;
					opts.paying_addresses = myPayingAddresses;
					opts.inputs = inputs;
					opts.input_amount = objInputs.total_input;
					opts.outputs = [{
						address: this.objMyContract.shared_address,
						amount: this.myAmount + this.peerAmount
					}, {
						address: this.addresses[0],
						amount: 0
					}];
					opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
					opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey, false);
					opts.callbacks = {
						ifError: (err) => {
							console.error('_err', err);
							return reject(err);
						},
						ifNotEnoughFunds: (err) => {
							console.error('_ifNotEnoughFunds', err);
							return reject(err);
						},
						ifOk: async (objJoint) => {
							network.broadcastJoint(objJoint);
							console.error('_objJoint', objJoint);
							this.step = 'waiting_stable_unit_of_output';
							console.error('waiting_stable_unit_of_output');
							this.waitingUnit = objJoint.unit.unit;
							await this.updateInDb();
							return resolve(objJoint);
						}
					};
					opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
					console.error('opts', opts);
					composer.composeJoint(opts);
				});
			}
		});
	}

	async waitingMCI(unit) {
		this.intervalMCI = setInterval(async () => {
			if (await Channel.checkMCIGreat(unit, this.age)) {
				if (this.intervalMCI) {
					console.error('check ok');
					clearInterval(this.intervalMCI);
				}
				await this.finalCloseNow();
			} else {
				console.error('check !ok');
			}
		}, 60000);
		if (await Channel.checkMCIGreat(unit, this.age)) {
			console.error('check ok');
			if (this.intervalMCI) {
				clearInterval(this.intervalMCI);
			}
			await this.finalCloseNow();
		} else {
			console.error('check !ok');
		}
	}

	finalCloseNow() {
		return new Promise((resolve, reject) => {
			console.error('objJ', typeof this.objJoint);
			this.getInputs(this.objMyContract.shared_address).then(async (objInputs) => {
				if (!objInputs || !objInputs.arrInputs.length) {
					return reject('Insufficient funds');
				}
				let inputs = objInputs.arrInputs.map(function (objInputWithProof) { return objInputWithProof.input;});
				let myPayingAddresses = [this.objMyContract.shared_address, this.addresses[0]];
				let opts = {};
				opts.lightProps = objInputs.response;
				opts.paying_addresses = myPayingAddresses;
				opts.inputs = inputs;
				opts.input_amount = objInputs.total_input;
				opts.outputs = [{
					address: this.peerAddress,
					amount: this.peerAmount
				}, {
					address: this.addresses[0],
					amount: this.myAmount
				}, {
					address: this.addresses[0],
					amount: 0
				}];
				opts.outputs = Channel.clearOutputs(opts.input_amount, opts.outputs);
				opts.signer = Wallet.getSigner(opts, [this.myDeviceAddress], libKeys.signWithLocalPrivateKey, false);
				opts.callbacks = {
					ifError: (err) => {
						console.error('_err', err);
						return reject(err);
					},
					ifNotEnoughFunds: (err) => {
						console.error('_ifNotEnoughFunds', err);
						return reject(err);
					},
					ifOk: async (objJoint) => {
						network.broadcastJoint(objJoint);
						console.error('_objJoint', objJoint);
						this.step = 'close';
						console.error('close!');
						this.waitingUnit = null;
						await this.updateInDb();
						return resolve(objJoint);
					}
				};
				opts.callbacks = composer.getSavingCallbacks(opts.callbacks);
				console.error('opts', opts);
				composer.composeJoint(opts);
			});
		});
	}

	static async checkMCIGreat(unit, greatValue) {
		let rows = await libToEs6.dbQuery("SELECT main_chain_index FROM units WHERE unit = ?", [unit]);
		console.error('testsetsetset');
		let MCIAndResponse = await Channel.getMCIAndResponse();
		console.error('MCIAndResponse', MCIAndResponse);
		if (MCIAndResponse.mci > (rows[0].main_chain_index + greatValue)) {
			return true;
		} else {
			return false;
		}
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
						console.error('response', response);
						let lsmbm = response.last_stable_mc_ball_mci;
						return resolve({mci: lsmbm, response});
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