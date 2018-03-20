const validationUtils = require('byteballcore/validation_utils');
const toEs6 = require('./toEs6');

async function getAddressBalance(address) {
	if (validationUtils.isValidAddress(address)) {
		if ((await toEs6.dbQuery("SELECT address AS count FROM my_addresses WHERE address = ?", [address])).length) {
			let rows = await toEs6.dbQuery(
				"SELECT asset, is_stable, SUM(amount) AS balance \n\
				FROM outputs JOIN units USING(unit) \n\
				WHERE is_spent=0 AND address=? AND sequence='good' AND asset IS NULL \n\
				GROUP BY is_stable", [address]);

			let balance = {
				base: {
					stable: 0,
					pending: 0
				}
			};

			rows.forEach(row => {
				balance.base[row.is_stable ? 'stable' : 'pending'] = row.balance;
			});

			return Promise.resolve(balance);
		} else {
			return Promise.reject('address not found');
		}
	} else {
		return Promise.reject('invalid address');
	}
}

async function myAddressInfo(address) {
	let rows = await toEs6.dbQuery("SELECT account, is_change, address_index FROM my_addresses, wallets \n\
		WHERE address=? and wallets.wallet = my_addresses.wallet", address);

	if (rows.length) {
		return rows[0];
	} else {
		return null;
	}
}

function issueChangeAddress(wallet_id) {
	return new Promise(resolve => {
		let walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js');
		walletDefinedByKeys.issueOrSelectNextChangeAddress(wallet_id, function (objAddr) {
			resolve(objAddr.address);
		});
	})
}

exports.getAddressBalance = getAddressBalance;
exports.myAddressInfo = myAddressInfo;
exports.issueChangeAddress = issueChangeAddress;