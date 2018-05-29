const core = require('../core');
const Channel = require('./Channel');
const libToEs6 = require('./toEs6');
const eventBus = require('byteballcore/event_bus');
const EventEmitter = require('events');

class ChannelsManager {
	constructor(walletId) {
		this.events = new EventEmitter();
		this.walletId = walletId;

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
		return new Channel(this.walletId, device.getMyDeviceAddress(), row.peerDeviceAddress, row.peerAddress,
			row.myAmount, row.peerAmount, row.age, row.id, {
				channelAddress: row.address,
				step: row.step,
				addresses: ChannelsManager.parseJSON(row.myAddresses),
				objMyContract: ChannelsManager.parseJSON(row.objMyContract),
				objPeerContract: ChannelsManager.parseJSON(row.objPeerContract),
				waitingUnit: row.waitingUnit,
				objJoint: ChannelsManager.parseJSON(row.joint)
			});
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
		return new Channel(this.walletId, device.getMyDeviceAddress(), objInfo.peerDeviceAddress, objInfo.myAddress,
			objInfo.peerAmount, objInfo.myAmount, objInfo.age, objInfo.id, {needConfirmation: !!objInfo.needConfirmation});
	}
}

module.exports = ChannelsManager;