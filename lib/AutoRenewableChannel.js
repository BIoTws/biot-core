const Channel = require('./Channel');
const eventBus = require('byteballcore/event_bus');
const mutex = require('byteballcore/mutex');
const EventEmitter = require('events');
const crypto = require('crypto');

class AutoRenewableChannel {
	constructor(walletId, peerDeviceAddress, timeout, maxOpenChannels) {
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
		this.index = 0;
		this.defaultParams = null;
		this.maxOpenChannels = maxOpenChannels;
		this.waitingChannelsClose = [];
		
		setInterval(() => {
			console.error(this.myAmount, this.peerAmount);
			this.channels.forEach(channel => {
				console.error(channel.id, channel.myAmount, channel.peerAmount);
			})
		}, 5000);
		
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
						}
					});
					channel.events.on('new_transfer', async (amount, message) => {
						this.myAmount += amount;
						this.peerAmount -= amount;
						this.events.emit('new_transfer', amount, message, channel.id);
					});
					this.channels.push(channel);
					objMessage.index = this.index++;
					this.events.emit('request_approve_channel', objMessage);
				} else if (objMessage.type === 'init') {
					this.step = 'waitingFirstChannel';
					this.peerId = objMessage.myId;
					this.peerDeviceAddress = from_address;
					this.sendMessage({type: 'init_ok', yourId: this.peerId, myId: this.id});
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
				myId: this.id
			});
		}
	}
	
	async approve(index) {
		if (this.channels[index]) {
			await this.channels[index].approve();
			return 'ok';
		} else {
			return 'channel not found';
		}
	}
	
	async reject(index) {
		if (this.channels[index]) {
			await this.channels[index].reject();
			return 'ok';
		} else {
			return 'channel not found';
		}
	}
	
	async openNewChannel(params) {
		const device = require('byteballcore/device');
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
			this.events.emit('changed_step', step, channel.id);
		});
		channel.events.on('new_transfer', async (amount, message) => {
			this.myAmount += amount;
			this.peerAmount -= amount;
			this.events.emit('new_transfer', amount, message, channel.id);
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
			this.waitingChannelsClose.push(channel);
			this.channels.splice(index, 1);
			await this.closeChannelFromList()
		}
	}
	
	async closeChannelFromList() {
		let unlock = await new Promise(resolve => {mutex.lock(["biot_ren_close"], (unlock) => {return resolve(unlock)});});
		if (!this.waitingChannelsClose.length) return;
		let channel = this.waitingChannelsClose[0];
		let closing = false;
		await channel.closeMutually();
		while (!closing) {
			for (let i = 0; i < 6; i++) {
				let result = await new Promise(resolve => {
					setTimeout(async () => {
						if (channel.step !== 'mutualClose' && i >= 6) {
							await channel.closeOneSide();
							this.waitingChannelsClose.splice(0, 1);
							closing = true;
							this.myAmount -= channel.myAmount;
							this.peerAmount -= channel.peerAmount;
							return resolve('ok');
						} else if (channel.step === 'mutualClose') {
							this.waitingChannelsClose.splice(0, 1);
							this.myAmount -= channel.myAmount;
							this.peerAmount -= channel.peerAmount;
							closing = true;
							return resolve('ok');
						}
						return resolve('!ok');
					}, 10000);
				});
				if (result == 'ok') {
					break;
				}
			}
		}
		unlock();
		if (this.waitingChannelsClose.length)
			this.closeChannelFromList();
	}
	
	closeAllChannels() {
		this.channels.forEach(channel => {
			this.waitingChannelsClose.push(channel);
		});
		this.closeChannelFromList();
		return 'ok';
	}
	
	async transfer(amount, message) {
		let unlock = await new Promise(resolve => {mutex.lock(["biot_ren_transfer"], (unlock) => {return resolve(unlock)});});
		let channel = this.channels.find((channel) => {
			return channel.myAmount > amount;
		});
		if (channel) {
			await channel.transfer(amount, message);
			this.myAmount -= amount;
			this.peerAmount += amount;
			unlock();
		} else {
			if (this.defaultParams) {
				if (amount > this.defaultParams.myAmount) {
					unlock();
					return {error: true, text: 'amount is too large'};
				} else {
					let newChannel = await this.openNewChannel(this.defaultParams);
					await new Promise(resolve => {this.events.once('start__' + newChannel.id, resolve)});
					await newChannel.transfer(amount, message);
					this.myAmount -= amount;
					this.peerAmount += amount;
					unlock();
				}
			} else {
				unlock();
				return {error: true, text: 'error creating new channel'};
			}
		}
	}
	
	sendMessage(message) {
		const device = require('byteballcore/device');
		message.app = 'BIoT';
		device.sendMessageToDevice(this.peerDeviceAddress, 'object', message);
		
	}
	
	getNewChannel(objInfo) {
		const device = require('byteballcore/device');
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