// it's unstable!!!

const libToEs6 = require('./toEs6');

async function migrateDb() {
	let rows = await libToEs6.dbQuery("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?)", [['channels', 'address_pass']]);
	if (rows.length === 2) {
		return true
	} else {
		let arrTableNames = rows.map(row => row.name);
		if (arrTableNames.indexOf('channels') === -1) {
			await libToEs6.dbQuery("CREATE TABLE channels (id CHAR(44) NOT NULL, address CHAR(32) NULL, peerDeviceAddress CHAR(33) NOT NULL,\n\
				peerAddress CHAR(32) NULL, myAmount BIGINT NOT NULL, peerAmount BIGINT NOT NULL, age SMALLINT NOT NULL, step VARCHAR(255) NOT NULL,\n\
				myAddresses TEXT NULL, objMyContract TEXT NULL, objPeerContract TEXT NULL, waitingUnit CHAR(44) NULL, \n\
				joint TEXT NULL, creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, change_date TIMESTAMP DEFAULT NULL, PRIMARY KEY(id))");
			await libToEs6.dbQuery("CREATE UNIQUE INDEX IF NOT EXISTS channel_id ON channels (id)");
			console.error('Create table channels and index');
		}
		if (arrTableNames.indexOf('address_pass') === -1) {
			await libToEs6.dbQuery("CREATE TABLE address_pass(id CHAR(44) NOT NULL, address CHAR(32) NOT NULL, pass CHAR(20) NULL, hash CHAR(44),\n\
				PRIMARY KEY(id, address))");
			await libToEs6.dbQuery("CREATE UNIQUE INDEX IF NOT EXISTS _address_pass ON address_pass (id, address)");
			console.error('Create table address_pass');
		}
		return true;
	}
}

exports.migrateDb = migrateDb;