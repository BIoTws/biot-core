const Channel = require('./Channel');
const eventBus = require('byteballcore/event_bus');
const EventEmitter = require('events');

class AutoRenewableChannel {
	constructor(walletId, timeout, amountToOpenNewChannel) {
		if (!amountToOpenNewChannel) throw Error("Require amountToOpenNewChannel");
		this.events = new EventEmitter();
		this.walletId = walletId;
		this.timeout = timeout || null;
		this.currentChannel = null;
		this.nextChannel = null;
		this.amountToOpenNewChannel = amountToOpenNewChannel;
		this.defaultParams = null;
		this.needNextChannel = true;
		this.lastChannelTransferId = null;
		
		eventBus.on('text', async (from_address, text) => {
			let objMessage = null;
			try {
				objMessage = JSON.parse(text);
			} catch (e) {
				console.error('incorrect tech message', text);
			}
			if (objMessage) {
				if (objMessage.app === 'BIoT') {
					if (objMessage.step === 'get1Contract') {
						objMessage.peerDeviceAddress = from_address;
						if (this.currentChannel === null) {
							this.defaultParams = objMessage;
							this.currentChannel = this.getNewChannel(objMessage);
							await this.currentChannel.init();
							this.currentChannel.events.on('error', error => {
								this.events.emit('error', error, this.currentChannel.id);
							});
							this.currentChannel.events.on('start', async () => {
								this.events.emit('start', this.currentChannel.id);
							});
							this.currentChannel.events.on('changed_step', (step) => {
								if (step === 'mutualClose') this.needNextChannel = true;
								this.events.emit('changed_step', step, this.currentChannel.id);
							});
							this.currentChannel.events.on('new_transfer', async (amount, message) => {
								this.events.emit('new_transfer', amount, message, this.currentChannel.id);
								this.lastChannelTransferId = this.currentChannel.id;
							});
							this.events.emit('request_approve_channel', objMessage);
						} else if (this.needNextChannel) {
							this.nextChannel = this.getNewChannel(objMessage);
							await this.nextChannel.init();
							this.nextChannel.events.on('error', error => {
								this.events.emit('error', error, this.nextChannel.id);
							});
							this.nextChannel.events.on('start', async () => {
								this.events.emit('start_next', this.nextChannel.id);
							});
							this.nextChannel.events.on('changed_step', (step) => {
								if (step === 'mutualClose') this.needNextChannel = true;
								this.events.emit('changed_step', step, this.nextChannel.id);
							});
							this.nextChannel.events.on('new_transfer', async (amount, message) => {
								if (this.nextChannel.id !== this.lastChannelTransferId && this.lastChannelTransferId !== null) {
									this.currentChannel = this.nextChannel;
									this.needNextChannel = true;
								}
								this.lastChannelTransferId = this.nextChannel.id;
								this.events.emit('new_transfer', amount, message, this.nextChannel.id);
							});
							if (objMessage.myAmount === this.defaultParams.myAmount && objMessage.peerAmount === this.defaultParams.peerAmount
								&& objMessage.age === this.defaultParams.age) {
								await this.nextChannel.approve();
							} else {
								await this.nextChannel.reject();
							}
						}
					}
				}
			}
		})
	}
	
	
	init(params) {
		if (!params.walletId) params.walletId = this.walletId;
		if (!params.timeout) params.timeout = this.timeout;
		this.defaultParams = params;
		this.currentChannel = new Channel(params);
		this.currentChannel.init();
		this.currentChannel.events.on('error', error => {
			this.events.emit('error', error, this.currentChannel.id);
		});
		this.currentChannel.events.on('start', async () => {
			this.events.emit('start', this.currentChannel.id);
		});
		this.currentChannel.events.on('changed_step', (step) => {
			this.events.emit('changed_step', step, this.currentChannel.id);
		});
		this.currentChannel.events.on('new_transfer', async (amount, message) => {
			this.events.emit('new_transfer', amount, message, this.currentChannel.id);
		});
	}
	
	approve() {
		this.currentChannel.approve();
	}
	
	reject() {
		this.currentChannel.reject();
	}
	
	openNewChannel() {
		this.nextChannel = new Channel(this.defaultParams);
		this.nextChannel.init();
		this.nextChannel.events.on('error', error => {
			this.events.emit('error', error, this.nextChannel.id);
		});
		this.nextChannel.events.on('start', async () => {
			this.events.emit('start_next', this.nextChannel.id);
		});
		this.nextChannel.events.on('changed_step', (step) => {
			this.events.emit('changed_step', step, this.nextChannel.id);
		});
		this.nextChannel.events.on('new_transfer', async (amount, message) => {
			this.events.emit('new_transfer', amount, message, this.nextChannel.id);
		});
	}
	
	async transfer(amount, message) {
		if (this.currentChannel.myAmount < amount) {
			await this.currentChannel.closeMutually();
			this.currentChannel = this.nextChannel;
			this.needNextChannel = true;
			return await this.currentChannel.transfer(amount, message);
		} else {
			if (this.needNextChannel && this.currentChannel.myAmount < this.amountToOpenNewChannel) {
				await this.openNewChannel();
				this.needNextChannel = false;
			}
			return await this.currentChannel.transfer(amount, message);
		}
	}
	
	async closeMutually() {
		if (this.currentChannel.id === this.nextChannel.id) {
			await this.currentChannel.closeMutually();
		} else {
			await this.currentChannel.closeMutually();
			await this.nextChannel.closeMutually();
		}
	}
	
	async closeOneSide() {
		if (this.currentChannel.id === this.nextChannel.id) {
			await this.currentChannel.closeOneSide();
		} else {
			await this.currentChannel.closeOneSide();
			await this.nextChannel.closeOneSide();
		}
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
		return new Channel(params);
	}
}

module.exports = AutoRenewableChannel;