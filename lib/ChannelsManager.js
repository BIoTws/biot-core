const core = require('../core');
const Channel = require('./Channel');
const libToEs6 = require('./toEs6');
const eventBus = require('byteballcore/event_bus');
const EventEmitter = require('events');

class ChannelsManager {
	constructor(walletId, timeout) {
		this.events = new EventEmitter();
		this.walletId = walletId;
		this.timeout = timeout || null;

		eventBus.on('text', (from_address, text) => {
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
						this.events.emit('newChannel', objMessage);
					}
				}
			}
		})
	}

	list() {
		return libToEs6.dbQuery("SELECT * FROM channels");
	}

	restoreChannel(row) {
		const device = require('byteballcore/device');
		let params = {
			walletId: this.walletId,
			myDeviceAddress: device.getMyDeviceAddress(),
			peerDeviceAddress: row.peerDeviceAddress,
			peerAddress: row.peerAddress,
			myAmount: row.myAmount,
			peerAmount: row.peerAmount,
			age: row.age,
			id: row.id,
			peerClosingAddress: row.peerClosingAddress,
			objRecovery: {
				channelAddress: row.address,
				step: row.step,
				myAddress: row.myAddress,
				objMyContract: ChannelsManager.parseJSON(row.objMyContract),
				objPeerContract: ChannelsManager.parseJSON(row.objPeerContract),
				waitingUnit: row.waitingUnit,
				objJoint: ChannelsManager.parseJSON(row.joint),
				myClosingAddress: row.myClosingAddress,
			}
		};
		if (this.timeout) {
			params.timeout = this.timeout;
		}
		return new Channel(params);
	}

	static parseJSON(json) {
		try {
			return JSON.parse(json);
		} catch (e) {
			return null;
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
			peerClosingAddress: objInfo.myClosingAddress
		};
		if (this.timeout) {
			params.timeout = this.timeout;
		}
		return new Channel(params);
	}
}

module.exports = ChannelsManager;