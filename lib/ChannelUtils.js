const objectHash = require('byteballcore/object_hash');

exports.checkSharedAddress = (channel, shared_address, arrDefinition) => {
	if (shared_address !== objectHash.getChash160(arrDefinition)) {
		return {status: false, code: 0}
	}

	if (arrDefinition[1][0][1][0][1] !== channel.peerAddress) {
		return {status: false, code: 1};
	}

	if (arrDefinition[1][0][1][1][1] !== channel.addresses[0]) {
		return {status: false, code: 2};
	}

	if (arrDefinition[1][1][1][0][1] !== channel.peerAddress) {
		return {status: false, code: 3};
	}

	if (arrDefinition[1][2][1][0][1] !== channel.addresses[0]) {
		return {status: false, code: 4};
	}

	if (arrDefinition[1][1][1][1][1].address !== channel.objPeerContract.shared_address) {
		return {status: false, code: 5};
	}

	if (arrDefinition[1][2][1][1][1].address !== channel.objMyContract.shared_address) {
		return {status: false, code: 6};
	}

	if (arrDefinition[1][1][1][1][1].amount !== (channel.myAmount + channel.peerAmount)) {
		return {status: false, code: 7};
	}

	if (arrDefinition[1][2][1][1][1].amount !== (channel.myAmount + channel.peerAmount)) {
		return {status: false, code: 8};
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

	if (arrDefinition[1][0][1][0][1][1][1] !== channel.addresses[0]) {
		return {status: false, code: 2};
	}

	if (arrDefinition[1][0][1][1][1][1] !== channel.age) {
		return {status: false, code: 3};
	}

	if (arrDefinition[1][0][1][2][1].address !== channel.peerAddress) {
		return {status: false, code: 4};
	}

	if (arrDefinition[1][0][1][3][1].address !== channel.addresses[0]) {
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

	if (arrDefinition[1][1][1][0][1] !== channel.addresses[0]) {
		return {status: false, code: 8};
	}

	if (arrDefinition[1][1][1][1][0] !== "hash") {
		return {status: false, code: 9};
	}

	return {status: true};
};

exports.checkPaymentToSharedAddress = (channel, outputs) => {
	if (!outputs || outputs.length !== 3) {
		return {status: false, code: 0};
	}

	let channelOutput = outputs.find(output => {
		return output.address === channel.channelAddress;
	});

	let myOutput = outputs.find(output => {
		return output.address === channel.addresses[0];
	});

	let peerOutput = outputs.find(output => {
		return output.address === channel.peerAddress;
	});

	if (!channelOutput) {
		return {status: false, code: 1};
	}

	if (channelOutput.amount !== (channel.myAmount + channel.peerAmount)) {
		return {status: false, code: 2};
	}

	if (!myOutput) {
		return {status: false, code: 3};
	}

	if (myOutput.amount !== (channel.total_input - channel.myAmount - 450)) {
		return {status: false, code: 4};
	}

	if (!peerOutput) {
		return {status: false, code: 5};
	}

	return {status: true};
};

exports.checkTransferPayment = (channel, outputs) => {
	if (!outputs || outputs.length !== 2) {
		return {status: false, code: 0};
	}

	let channelOutput = outputs.find(output => {
		return output.address === channel.objPeerContract.shared_address;
	});

	let peerOutput = outputs.find(output => {
		return output.address === channel.peerAddress;
	});

	if (!channelOutput) {
		return {status: false, code: 1};
	}

	if (channelOutput.amount !== (channel.myAmount + channel.peerAmount)) {
		return {status: false, code: 2};
	}

	if (!peerOutput) {
		return {status: false, code: 3};
	}

	return {status: true};
};

exports.checkClosingPayment = (channel, outputs) => {
	if (!outputs || outputs.length !== 2) {
		return {status: false, code: 0};
	}

	let myOutput = outputs.find(output => {
		return output.address === channel.addresses[0];
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

exports.isClosingPayment = (channel, authors) => {
	return !!authors.find(author => author.address === channel.channelAddress);
};