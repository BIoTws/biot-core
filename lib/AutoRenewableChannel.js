const Channel = require('./Channel');
const eventBus = require('ocore/event_bus');
const mutex = require('ocore/mutex');
const EventEmitter = require('events');
const crypto = require('crypto');

class AutoRenewableChannel {
	constructor(walletId, peerDeviceAddress, timeout, maxOpenChannels, timeForMutualClosingChannel = 60000, maxAmountInTransfer = Infinity) {
		if (!maxOpenChannels) throw Error("Require maxOpenChannels");
		this.channels = [];
		this.id = crypto.createHash("sha256").update(walletId + '_' + timeout + '_' + maxOpenChannels + '_' + Date.now(), "utf8").digest("base64");
		this.peerDeviceAddress = peerDeviceAddress;
		this.peerId = null;
		this.events = new EventEmitter();
		this.walletId = walletId;
		this.timeout = timeout || null;
		this.myAmount = 0;
		this.peerAmount = 0;
		this.step = null;
		this.defaultParams = null;
		this.maxOpenChannels = maxOpenChannels;
		this.waitingClosingChannels = [];
		this.timeForMutualClosingChannel = timeForMutualClosingChannel;
		this.maxAmountInTransfer = maxAmountInTransfer;
		
		eventBus.on('object', async (from_address, objMessage) => {
			if (objMessage.app === 'BIoT') {
				if (objMessage.step === 'get1Contract' && objMessage.messageOnOpening === this.peerId) {
					objMessage.peerDeviceAddress = from_address;
					let channel = this.getNewChannel(objMessage);
					await channel.init();
					channel.events.on('error', error => {
						this.events.emit('error', error, channel.id);
					});
					channel.events.on('start', async () => {
						this.myAmount += channel.myAmount;
						this.peerAmount += channel.peerAmount;
						this.events.emit('start', channel.id);
					});
					channel.events.on('changed_step', (step) => {
						this.events.emit('changed_step', step, channel.id);
						if (step === 'mutualClose') {
							this.channels.splice(this.channels.findIndex(_ch => _ch.id === channel.id), 1);
							eventBus.emit('mutualClose-' + channel.id);
						}
					});
					channel.events.on('new_transfer', async (amount, message) => {
						this.myAmount += amount;
						this.peerAmount -= amount;
						this.events.emit('new_transfer', amount, message, channel.id);
						if (amount > this.maxAmountInTransfer) {
							this.events.emit('warning', 'amount greater than the maximum');
						}
					});
					this.channels.push(channel);
					this.events.emit('request_approve_channel', objMessage);
				} else if (objMessage.type === 'init') {
					this.step = 'waitingFirstChannel';
					this.peerId = objMessage.myId;
					this.peerDeviceAddress = from_address;
					this.timeForMutualClosingChannel = objMessage.timeForMutualClosingChannel;
					this.maxAmountInTransfer = objMessage.maxAmountInTransfer;
					this.sendMessage({type: 'init_ok', yourId: this.peerId, myId: this.id});
					this.events.emit('init', {
						peerId: this.peerId,
						device_address: from_address,
						timeForMutualClosingChannel: timeForMutualClosingChannel,
						maxAmountInTransfer: maxAmountInTransfer
					});
					this.step = 'init_ok';
				} else if (objMessage.type === 'init_ok' && objMessage.yourId === this.id) {
					this.peerId = objMessage.myId;
					this.step = 'init_ok';
				}
			}
		});
	}
	
	init() {
		if (this.peerDeviceAddress) {
			this.step = 'init';
			this.sendMessage({
				type: 'init',
				myId: this.id,
				timeForMutualClosingChannel: this.timeForMutualClosingChannel,
				maxAmountInTransfer: this.maxAmountInTransfer
			});
		}
	}
	
	async approve(id) {
		let channel = this.channels.find(channel => channel.id === id);
		if (channel) {
			await channel.approve();
			return 'ok';
		} else {
			return 'channel not found';
		}
	}
	
	async reject(id) {
		let channel = this.channels.find(channel => channel.id === id);
		if (channel) {
			await channel.reject();
			return 'ok';
		} else {
			return 'channel not found';
		}
	}
	
	async openNewChannel(params) {
		const device = require('ocore/device');
		if (params) {
			this.defaultParams = params;
		} else if (this.defaultParams) {
			params = this.defaultParams;
		} else {
			return {error: true, text: 'required params'};
		}
		params.walletId = this.walletId;
		params.timeout = this.timeout;
		params.peerDeviceAddress = this.peerDeviceAddress;
		params.myDeviceAddress = device.getMyDeviceAddress();
		params.messageOnOpening = this.id;
		let channel = new Channel(params);
		await channel.init();
		channel.events.on('error', error => {
			this.events.emit('error', error, channel.id);
		});
		channel.events.on('start', async () => {
			this.myAmount += channel.myAmount;
			this.peerAmount += channel.peerAmount;
			this.events.emit('start', channel.id);
			this.events.emit('start__' + channel.id, true);
		});
		channel.events.on('changed_step', (step) => {
			if (step === 'mutualClose') {
				eventBus.emit('mutualClose-' + channel.id);
			}
			this.events.emit('changed_step', step, channel.id);
		});
		channel.events.on('new_transfer', async (amount, message) => {
			this.myAmount += amount;
			this.peerAmount -= amount;
			this.events.emit('new_transfer', amount, message, channel.id);
			if (amount > this.maxAmountInTransfer) {
				this.events.emit('warning', 'amount greater than the maximum');
			}
		});
		this.channels.push(channel);
		this.checkOpenChannels();
		return channel;
	}
	
	async checkOpenChannels() {
		if (this.channels.length > this.maxOpenChannels) {
			let min = Number.POSITIVE_INFINITY;
			let channel = null;
			let index;
			this.channels.forEach((_channel, _index) => {
				if (_channel.myAmount < min) {
					min = _channel.myAmount;
					channel = _channel;
					index = _index;
				}
			});
			this.waitingClosingChannels.push(channel);
			this.channels.splice(index, 1);
			await this.closeChannelFromList()
		}
	}
	
	async closeChannelFromList() {
		let unlock = await new Promise(resolve => {mutex.lock(["biot_ren_close"], (unlock) => {return resolve(unlock)});});
		if (!this.waitingClosingChannels.length) return;
		let channel = this.waitingClosingChannels[0];
		
		await channel.closeMutually();
		await new Promise(resolve => {
			let tmr = setTimeout(async () => {
				await channel.closeOneSide();
				this.waitingClosingChannels.splice(0, 1);
				this.myAmount -= channel.myAmount;
				this.peerAmount -= channel.peerAmount;
				unlock();
				return resolve();
			}, this.timeForMutualClosingChannel);
			
			eventBus.once('mutualClose-' + channel.id, () => {
				clearTimeout(tmr);
				this.waitingClosingChannels.splice(0, 1);
				this.myAmount -= channel.myAmount;
				this.peerAmount -= channel.peerAmount;
				unlock();
				return resolve();
			});
		});
		if (this.waitingClosingChannels.length)
			this.closeChannelFromList();
	}
	
	closeAllChannels() {
		this.channels.forEach(channel => {
			this.waitingClosingChannels.push(channel);
		});
		this.closeChannelFromList();
		return 'ok';
	}
	
	async transfer(amount, message) {
		if (amount <= this.maxAmountInTransfer) {
			let unlock = await new Promise(resolve => {mutex.lock(["biot_ren_transfer"], (unlock) => {return resolve(unlock)});});
			let channel = this.channels.find((channel) => {
				return channel.myAmount > amount;
			});
			if (channel) {
				let transfer = await channel.transfer(amount, message);
				this.myAmount -= amount;
				this.peerAmount += amount;
				unlock();
				return {ok: true, transfer};
			} else {
				if (this.defaultParams) {
					let newChannel = await this.openNewChannel(this.defaultParams);
					await new Promise(resolve => {this.events.once('start__' + newChannel.id, resolve)});
					let transfer = await newChannel.transfer(amount, message);
					this.myAmount -= amount;
					this.peerAmount += amount;
					unlock();
					return {ok: true, transfer};
				} else {
					unlock();
					return {error: true, text: 'error creating new channel'};
				}
			}
		} else {
			return {error: true, text: 'amount greater than the maximum'};
		}
	}
	
	sendMessage(message) {
		const device = require('ocore/device');
		message.app = 'BIoT';
		device.sendMessageToDevice(this.peerDeviceAddress, 'object', message);
		
	}
	
	getNewChannel(objInfo) {
		const device = require('ocore/device');
		let params = {
			walletId: this.walletId,
			myDeviceAddress: device.getMyDeviceAddress(),
			peerDeviceAddress: objInfo.peerDeviceAddress,
			peerAddress: objInfo.myAddress,
			myAmount: objInfo.peerAmount,
			peerAmount: objInfo.myAmount,
			age: objInfo.age,
			id: objInfo.id,
			peerUnilateralAddress: objInfo.myUnilateralAddress,
			peerDestinationAddress: objInfo.myDestinationAddress
		};
		if (this.timeout) {
			params.timeout = this.timeout;
		}
		this.defaultParams = params;
		return new Channel(params);
	}
}

module.exports = AutoRenewableChannel;