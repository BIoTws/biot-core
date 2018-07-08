const libToEs6 = require('./toEs6');

const CURRENT_VERSION = 0;

async function migrateDb() {
	let arrTables = ['channels', 'address_passes', 'peer_addresses', 'biot_params'];
	let rows = await libToEs6.dbQuery("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?)", [arrTables]);

	if (rows.length !== arrTables.length) {
		let arrTableNames = rows.map(row => row.name);
		if (arrTableNames.indexOf('channels') === -1) {
			await libToEs6.dbQuery("CREATE TABLE channels (id CHAR(44) NOT NULL, address CHAR(32) NULL, peerDeviceAddress CHAR(33) NOT NULL,\n\
				peerAddress CHAR(32) NULL, myAmount BIGINT NOT NULL, peerAmount BIGINT NOT NULL, age SMALLINT NOT NULL, step VARCHAR(255) NOT NULL,\n\
				myAddress CHAR(32) NULL, objMyContract TEXT NULL, objPeerContract TEXT NULL, waitingUnit CHAR(44) NULL, \n\
				myUnilateralAddress CHAR(32) NULL, peerUnilateralAddress CHAR(32) NULL, \n\
				myDestinationAddress CHAR(32) NULL, peerDestinationAddress CHAR(32) NULL, \n\
				joint TEXT NULL, creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, change_date TIMESTAMP DEFAULT NULL, PRIMARY KEY(id))");
			await libToEs6.dbQuery("CREATE UNIQUE INDEX IF NOT EXISTS channel_id ON channels (id)");
			console.error('Create table channels and index');
		}
		if (arrTableNames.indexOf('address_passes') === -1) {
			await libToEs6.dbQuery("CREATE TABLE address_passes(id CHAR(44) NOT NULL, address CHAR(32) NOT NULL, pass CHAR(20) NULL, hash CHAR(44),\n\
				PRIMARY KEY(id, address))");
			await libToEs6.dbQuery("CREATE UNIQUE INDEX IF NOT EXISTS _address_pass ON address_passes (id, address)");
			console.error('Create table address_passes');
		}
		if (arrTableNames.indexOf('peer_addresses') === -1) {
			await libToEs6.dbQuery("CREATE TABLE peer_addresses(address CHAR(32) NOT NULL, device_address CHAR(33) NOT NULL, definition TEXT NOT NULL,\n\
				PRIMARY KEY(address, device_address))");
			await libToEs6.dbQuery("CREATE UNIQUE INDEX IF NOT EXISTS _peer_addresses ON peer_addresses (address)");
			console.error('Create table peer_addresses');
		}
		if (arrTableNames.indexOf('biot_params') === -1) {
			await libToEs6.dbQuery("CREATE TABLE biot_params (version INT DEFAULT 0, PRIMARY KEY(version))");
			await libToEs6.dbQuery("INSERT INTO biot_params (version) VALUES (0)");
			console.error('Create table biot_params');
		}
	}

	let rowsParams = await libToEs6.dbQuery("SELECT version FROM biot_params");
	let version = rowsParams[0].version;

	if (version < CURRENT_VERSION) {
		let newVersion = 0;


		await libToEs6.dbQuery("UPDATE biot_params SET version = ?", [newVersion]);
	}

	return true;
}

exports.migrateDb = migrateDb;