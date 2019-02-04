const core = require('../core');
const Channel = require('./Channel');
const libToEs6 = require('./toEs6');
const eventBus = require('ocore/event_bus');
const EventEmitter = require('events');

class ChannelsManager {
	constructor(walletId, timeout) {
		this.events = new EventEmitter();
		this.walletId = walletId;
		this.timeout = timeout || null;
		
		eventBus.on('object', (from_address, objMessage) => {
			if (objMessage.app === 'BIoT') {
				if (objMessage.step === 'get1Contract') {
					objMessage.peerDeviceAddress = from_address;
					this.events.emit('newChannel', objMessage);
				}
			}
		})
	}
	
	list() {
		return libToEs6.dbQuery("SELECT * FROM channels WHERE walletId = ?", [this.walletId]);
	}
	
	static listByWalletId(walletId) {
		return libToEs6.dbQuery("SELECT * FROM channels WHERE walletId = ?", [walletId]);
	}
	
	newChannel(params) {
		if (!params.walletId) params.walletId = this.walletId;
		if (!params.timeout) params.timeout = this.timeout;
		return new Channel(params);
	}
	
	restoreChannel(row) {
		const device = require('ocore/device');
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
			peerUnilateralAddress: row.peerUnilateralAddress,
			peerDestinationAddress: row.peerDestinationAddress,
			objRecovery: {
				channelAddress: row.address,
				step: row.step,
				myAddress: row.myAddress,
				objMyContract: ChannelsManager.parseJSON(row.objMyContract),
				objPeerContract: ChannelsManager.parseJSON(row.objPeerContract),
				waitingUnit: row.waitingUnit,
				objJoint: ChannelsManager.parseJSON(row.joint),
				myUnilateralAddress: row.myUnilateralAddress,
				myDestinationAddress: row.myDestinationAddress
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
		return new Channel(params);
	}
}

module.exports = ChannelsManager;