/*jslint node: true */
'use strict';

const db = require('ocore/db.js');

function getUnitsForTransactionsWallet(walletId, asset, cb) {
	let strFilterAsset = asset;
	
	let arrQuerySql = [
		"SELECT inputs.unit",
		"FROM inputs, outputs, units",
		"WHERE (( units.unit IN (SELECT DISTINCT unit FROM inputs JOIN my_addresses USING(address)" +
		"WHERE my_addresses.wallet = ? " + getStrSqlFilterAssetForSingleTypeOfTransactions(strFilterAsset) + " ORDER BY inputs.ROWID DESC))",
		"OR ( units.unit IN (SELECT DISTINCT unit FROM outputs JOIN my_addresses USING(address)" +
		"WHERE my_addresses.wallet = ? " + getStrSqlFilterAssetForSingleTypeOfTransactions(strFilterAsset) + " ORDER BY outputs.ROWID DESC)))",
		"AND inputs.unit = outputs.unit",
		getStrSqlFilterAssetForTransactions(strFilterAsset),
		"AND units.unit = inputs.unit",
		"GROUP BY inputs.unit",
		"ORDER BY units.ROWID DESC"
	];
	
	db.query(
		arrQuerySql.join(" \n"),
		[walletId, walletId],
		function (rows) {
			cb(
				rows.map(function (row) {
					return row.unit;
				})
			);
		}
	);
}

function getWalletTransactions(walletId, asset) {
	return new Promise(resolve => {
		getUnitsForTransactionsWallet(walletId, asset, function (arrUnits) {
			if (arrUnits.length) {
				let arrQuerySql = [
					"SELECT inputs.unit, units.creation_date, inputs.address, outputs.address AS addressTo, outputs.amount, inputs.asset, outputs.asset AS assetTo, outputs.output_id, outputs.message_index, outputs.output_index, inputs.type, " + db.getUnixTimestamp("units.creation_date") + " AS timestamp",
					"FROM inputs, outputs, units",
					"WHERE units.unit IN (?) AND outputs.unit = inputs.unit",
					getStrSqlFilterAssetForTransactions(asset),
					"AND units.unit = inputs.unit",
					"ORDER BY units.main_chain_index DESC"
				];
				
				db.query(
					arrQuerySql.join(" \n"),
					[arrUnits],
					function (rowsTransactions) {
						let key, objTransactions = {};
						if (rowsTransactions.length) {
							rowsTransactions.forEach(function (row) {
								key = row.unit + '_' + row.asset;
								if (!objTransactions[key]) objTransactions[key] = {
									unit: row.unit,
									date: row.timestamp,
									from: [],
									to: {},
									spent: false,
									asset: row.asset,
									output_id: row.output_id
								};
								if (objTransactions[key].from.indexOf(row.address) === -1) objTransactions[key].from.push(row.address);
								if (!objTransactions[key].to[row.output_id + '_' + row.message_index + '_' + row.output_index]) {
									objTransactions[key].to[row.output_id + '_' + row.message_index + '_' + row.output_index] = {
										address: row.addressTo,
										amount: row.amount,
										spent: 0
									};
								}
							});
							
							resolve(objTransactions);
						} else {
							resolve(null);
						}
					}
				);
			} else {
				resolve(null);
			}
		});
	});
}

function getStrSqlFilterAssetForTransactions(strFilterAsset) {
	if (typeof strFilterAsset === 'undefined' || strFilterAsset === 'all') {
		return "AND (( inputs.asset IS NULL AND outputs.asset IS NULL ) OR (inputs.asset = outputs.asset))";
	} else if (strFilterAsset === 'bytes') {
		return "AND inputs.asset IS NULL AND outputs.asset IS NULL";
	} else {
		let strEscapedFilterAsset = db.escape(strFilterAsset);
		return "AND inputs.asset = " + strEscapedFilterAsset + " AND outputs.asset = " + strEscapedFilterAsset;
	}
}

function getStrSqlFilterAssetForSingleTypeOfTransactions(strFilterAsset) {
	if (typeof strFilterAsset === 'undefined' || strFilterAsset === 'all') {
		return "";
	} else if (strFilterAsset === 'bytes') {
		return "AND asset IS NULL";
	} else {
		return "AND asset = " + db.escape(strFilterAsset);
	}
}

exports.getWalletTransactions = getWalletTransactions;