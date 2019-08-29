/*jslint node: true */
"use strict";
const db = require('ocore/db.js');

db.query("CREATE TABLE IF NOT EXISTS channels (  \n\
	aa_address CHAR(32) NOT NULL PRIMARY KEY, \n\
	salt VARCHAR(50) DEFAULT NULL,\n\
	definition TEXT,\n\
	asset CHAR(44) DEFAULT NULL,\n\
	peer_address CHAR(32) NOT NULL, \n\
	peer_device_address CHAR(33) DEFAULT NULL, \n\
	peer_url VARCHAR(100) DEFAULT NULL,\n\
	is_known_by_peer TINYINT DEFAULT 0,\n\
	is_peer_ready TINYINT DEFAULT 0,\n\
	amount_spent_by_peer INTEGER DEFAULT 0,\n\
	amount_spent_by_me INTEGER DEFAULT 0,\n\
	amount_deposited_by_peer INTEGER DEFAULT 0,\n\
	amount_deposited_by_me INTEGER DEFAULT 0,\n\
	amount_possibly_lost_by_me INTEGER DEFAULT 0,\n\
	overpayment_from_peer INTEGER DEFAULT 0,\n\
	auto_refill_threshold INTEGER DEFAULT 0,\n\
	auto_refill_amount INTEGER DEFAULT 0,\n\
	close_timestamp INTEGER,\n\
	timeout INTEGER NOT NULL,\n\
	period INTEGER DEFAULT 1,\n\
	last_message_from_peer TEXT,\n\
	last_event_id INTEGER DEFAULT 0,\n\
	is_definition_confirmed TINYINT DEFAULT 0,\n\
	closing_authored TINYINT DEFAULT 0,\n\
	status VARCHAR(30) DEFAULT 'created',\n\
	last_updated_mci INTEGER DEFAULT 0,\n\
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\
	UNIQUE (peer_address, salt)\n\
);");

db.query("CREATE TABLE IF NOT EXISTS my_deposits (\n\
	aa_address CHAR(32) NOT NULL, \n\
	amount INTEGER NOT NULL,\n\
	unit CHAR(44) NOT NULL,\n\
	is_confirmed_by_aa TINYINT DEFAULT 0,\n\
	UNIQUE (aa_address, unit)\n\
);");

db.query("CREATE TABLE IF NOT EXISTS unconfirmed_units_from_peer (\n\
	aa_address CHAR(32) NOT NULL, \n\
	amount INTEGER DEFAULT 0,\n\
	unit CHAR(44) NOT NULL,\n\
	close_channel TINYINT DEFAULT 0,\n\
	has_definition TINYINT DEFAULT 0,\n\
	is_bad_sequence TINYINT DEFAULT 0,\n\
	timestamp INTEGER NOT NULL,\n\
	UNIQUE(aa_address, unit)\n\
)");

db.query("CREATE TABLE IF NOT EXISTS channels_config (\n\
	my_address CHAR(32) \n\
	);");

