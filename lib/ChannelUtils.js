const objectHash = require('byteballcore/object_hash');
const constants = require('./constants');

exports.checkSharedAddress = (channel, shared_address, arrDefinition) => {
	if (shared_address !== objectHash.getChash160(arrDefinition)) {
		return {status: false, code: 0}
	}

	if (arrDefinition[1][0][1][0][1] !== channel.peerClosingAddress) {
		return {status: false, code: 1};
	}

	if (arrDefinition[1][0][1][1][1] !== channel.myClosingAddress) {
		return {status: false, code: 2};
	}

	if (arrDefinition[1][1][1][0][1] !== channel.peerClosingAddress) {
		return {status: false, code: 3};
	}

	if (arrDefinition[1][2][1][0][1] !== channel.myClosingAddress) {
		return {status: false, code: 4};
	}

	if (arrDefinition[1][1][1][1][1].address !== channel.objPeerContract.shared_address) {
		return {status: false, code: 5};
	}

	if (arrDefinition[1][2][1][1][1].address !== channel.objMyContract.shared_address) {
		return {status: false, code: 6};
	}

	return {status: true};
};

exports.check1Contract = (channel, shared_address, arrDefinition, transferAmount = 0, isRecipient) => {
	if (shared_address !== objectHash.getChash160(arrDefinition)) {
		return {status: false, code: 0}
	}

	if (arrDefinition[1][0][1][0][1][0][1] !== channel.peerAddress) {
		return {status: false, code: 1};
	}

	if (arrDefinition[1][0][1][0][1][1][1] !== channel.myAddress) {
		return {status: false, code: 2};
	}

	if (arrDefinition[1][0][1][1][1][1] !== channel.age) {
		return {status: false, code: 3};
	}

	if (arrDefinition[1][0][1][2][1].address !== channel.peerClosingAddress) {
		return {status: false, code: 4};
	}

	if (arrDefinition[1][0][1][3][1].address !== channel.myClosingAddress) {
		return {status: false, code: 5};
	}

	let peerAmount = isRecipient ? (channel.peerAmount + transferAmount) : (channel.peerAmount - transferAmount);
	if (arrDefinition[1][0][1][2][1].amount !== peerAmount) {
		return {status: false, code: 6};
	}

	let myAmount = isRecipient ? (channel.myAmount - transferAmount) : (channel.myAmount + transferAmount);
	if (arrDefinition[1][0][1][3][1].amount !== myAmount) {
		return {status: false, code: 7};
	}

	if (arrDefinition[1][1][1][0][1] !== channel.myAddress) {
		return {status: false, code: 8};
	}

	if (arrDefinition[1][1][1][1][0] !== "hash") {
		return {status: false, code: 9};
	}

	return {status: true};
};

exports.checkPaymentToChannelContract = (channel, outputs, myAddresses) => {
	if (!channel.total_input) {
		return {status: false, code: -1};
	}

	let myAmount = (channel.total_input - channel.myAmount - constants.FEES_FOR_CREATE_CHANNEL) - (constants.FEES_FOR_CHANNEL_OPERATIONS * 2);

	if (!outputs || ((myAmount === 0 && outputs.length !== 2) && (myAmount !== 0 && outputs.length !== 3))) {
		return {status: false, code: 0};
	}

	let channelOutput = outputs.find(output => {
		return output.address === channel.channelAddress;
	});

	if (!channelOutput) {
		return {status: false, code: 1};
	}

	if (channelOutput.amount !== (channel.myAmount + channel.peerAmount + (constants.FEES_FOR_CHANNEL_OPERATIONS * 4))) {
		return {status: false, code: 2};
	}

	let myOutput = null;
	if (myAmount !== 0) {
		let myOutput = outputs.find(output => {
			return myAddresses.indexOf(output.address) !== -1;
		});

		if (!myOutput) {
			return {status: false, code: 3};
		}

		if (myOutput.amount !== (channel.total_input - channel.myAmount - constants.FEES_FOR_CREATE_CHANNEL) - (constants.FEES_FOR_CHANNEL_OPERATIONS * 2)) {
			return {status: false, code: 4};
		}
	}

	let peerOutput = outputs.find(output => {
		return output.address !== channelOutput.address && !(myOutput && output.address !== myOutput.address);
	});

	if (!peerOutput) {
		return {status: false, code: 5};
	}

	return {status: true};
};

exports.checkTransferPayment = (channel, outputs) => {
	if (!outputs || outputs.length !== 1) {
		return {status: false, code: 0};
	}

	let peer_shared_address_output = outputs.find(output => {
		return output.address === channel.objPeerContract.shared_address;
	});

	if (!peer_shared_address_output) {
		return {status: false, code: 1};
	}

	return {status: true};
};

exports.checkClosingPayment = (channel, outputs) => {
	if (!outputs || outputs.length !== 2) {
		return {status: false, code: 0};
	}

	let myOutput = outputs.find(output => {
		return output.address === channel.myAddress;
	});

	let peerOutput = outputs.find(output => {
		return output.address === channel.peerAddress;
	});

	if (!myOutput) {
		return {status: false, code: 1};
	}

	if (myOutput.amount !== (channel.myAmount)) {
		return {status: false, code: 2};
	}

	if (!peerOutput) {
		return {status: false, code: 3};
	}

	return {status: true};
};

exports.getHash = (arrDefinition) => {
	return arrDefinition[1][1][1][1][1].hash;
};