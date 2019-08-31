const objectHash = require('ocore/object_hash.js');
const constants = require('ocore/constants.js');


function getAaAddress(addressA, addressB, timeout, asset, salt){
	return objectHash.getChash160( getAaArrDefinition(addressA, addressB, timeout, asset, salt));
}


function getAaArrDefinition(addressA, addressB, timeout, asset, salt){
return 	['autonomous agent', {
	init: `{
		$close_timeout = ${timeout};
		${salt ? "$salt='" + salt +"';": ""}
		$asset = '${asset}';
		$addressA = '${addressA}';
		$addressB = '${addressB}';
		$bFromA = (trigger.address == $addressA);
		$bFromB = (trigger.address == $addressB);
		$bFromParties = ($bFromA OR $bFromB);
		if ($bFromParties)
			$party = $bFromA ? 'A' : 'B';
	}`,
	messages: {
		cases: [
			{ // one party fills or refills the AA
				if: `{ $bFromParties AND ($asset!='base' AND trigger.output[[asset=$asset]] > 0 OR $asset=='base' AND trigger.output[[asset=base]] > ${constants.MIN_BYTES_BOUNCE_FEE})}`,
				init: `{
					if (var['close_initiated_by']){
						$refused=1;
					} else {
					if (!var['period'])
						$period = 1;
					else
						$period = var['period'];
					}
				}`,
				messages: [{
					if:"{!$refused}", //we broadcast an unit indicating the new state of AA if deposit is accepted
					app: 'data',
					payload: {
						open: 1,
						period: "{$period}",
						"{$addressA}":"{var['balanceA'] + ($party == 'A' ? trigger.output[[asset=$asset]] : 0)}",
						"{$addressB}":"{var['balanceB'] + ($party == 'B' ? trigger.output[[asset=$asset]] : 0)}",
						event_id :"{var['event_id'] otherwise 1}",
						trigger_unit: "{trigger.unit}"
					}
				},
				{
					if:"{$refused}", //we add data to inform that deposit is refused
					app: 'data',
					payload: {
						refused: 1,
						trigger_unit: "{trigger.unit}",
						event_id :"{var['event_id'] otherwise 1}",
					}
				},
				{
					if:"{$refused}", //we refund sender if deposit is refused
					app: 'payment',
					payload: {
						asset: "{$asset}",
						outputs: [
							{address: "{trigger.address}", amount: "{$asset == 'base' ? (trigger.output[[asset=base]] - 10000) : trigger.output[[asset=$asset]]}"}
						]
					}
				},
					{
						app: 'state',
						state: `{
							if (!var['event_id'])
								var['event_id'] = 2;
							else
								var['event_id'] += 1;
							if (!$refused){
								if (!var['period'])
								var['period'] = 1;
								$key = 'balance' || $party;
								var[$key] += trigger.output[[asset=$asset]];
							}
						}`
					}
				]
			},
			{ // start closing
				if: `{ $bFromParties AND trigger.data.close AND !var['close_initiated_by'] }`,
				init: `{
					if (trigger.data.period != var['period'])
						bounce('wrong period');
					$transferredFromMe = trigger.data.transferredFromMe otherwise 0;
					if ($transferredFromMe < 0)
								bounce('bad amount spent by me: ' || $transferredFromMe);
					if (trigger.data.sentByPeer){
						if (trigger.data.sentByPeer.signed_message.aa_address  != this_address)
							bounce('signed for another channel');
						if (trigger.data.sentByPeer.signed_message.period != var['period'])
							bounce('signed for a different period of this channel');
						if (!is_valid_signed_package(trigger.data.sentByPeer, $bFromB ? $addressA : $addressB))
							bounce('invalid signature by peer');
						$transferredFromPeer = trigger.data.sentByPeer.signed_message.amount_spent;
						if ((!$transferredFromPeer AND $transferredFromPeer !=0) OR $transferredFromPeer < 0)
							bounce('bad amount spent by peer: ' || $transferredFromPeer);
					}
					else
						$transferredFromPeer = 0;
				}`,
				messages: [
						{
							app: 'data', //we broadcast an unit indicating the channel has received a closing request
							payload: {
								closing: 1,
								period: "{var['period']}",
								initiated_by: "{trigger.address}",
								"{$addressA}": "{ $bFromA ? $transferredFromMe : $transferredFromPeer}",
								"{$addressB}": "{ $bFromB ? $transferredFromMe : $transferredFromPeer}",
								event_id :"{var['event_id'] otherwise 1}",
								trigger_unit: "{trigger.unit}"
							}
						},
						{
						app: 'state',
						state: `{
							var['spentByA'] = $bFromA ? $transferredFromMe : $transferredFromPeer;
							var['spentByB'] = $bFromB ? $transferredFromMe : $transferredFromPeer;
							var['close_initiated_by'] = $party;
							var['close_start_ts'] = timestamp;
							if (!var['event_id'])
								var['event_id'] = 2;
							else
								var['event_id'] += 1;
						}`
					},
				]
			},
			{ // confirm closure
				if: `{ trigger.data.confirm AND var['close_initiated_by'] }`,
				init: `{
					if (!($bFromParties AND var['close_initiated_by'] != $party OR timestamp > var['close_start_ts'] + $close_timeout))
						bounce('too early');
					if (trigger.data.period != var['period'])
						bounce('wrong period');
					$additionnalTransferredFromMe = trigger.data.additionnalTransferredFromMe otherwise 0;
					$additionalSpentByA = $party == 'A' ? $additionnalTransferredFromMe : 0;
					$additionalSpentByB = $party == 'B' ? $additionnalTransferredFromMe : 0;
					$balanceA = var['balanceA'] - var['spentByA'] + var['spentByB'] + $additionalSpentByB - $additionalSpentByA;
					$balanceB = var['balanceB'] - var['spentByB'] + var['spentByA'] + $additionalSpentByA - $additionalSpentByB;
					$finalBalanceA = $balanceA > 0 ? $balanceA : 0; // balance could be < 0 if an unconfirmed deposit were lost 
					$finalBalanceB = $balanceB > 0 ? $balanceB : 0;
				}`,
				messages: [
					{
						if:"{$asset == 'base'}",
						app: 'payment',
						payload: {
							asset: "base",
							outputs: [
								// fees are paid by the larger party, its output is send-all
								// this party also collects the accumulated 10Kb bounce fees minus 10Kb to prevent abuse of confirmation bounce fees
								{address: "{$addressA}", amount: "{ $finalBalanceA < $finalBalanceB ? ($finalBalanceA + 10000) : '' }"},
								{address: "{$addressB}", amount: "{ $finalBalanceA >= $finalBalanceB ? ($finalBalanceB + 10000) : '' }"},
							]
						}
					},
					{
						if:"{$asset != 'base'}",
						app: 'payment',
						payload: {
							asset: "base",
							outputs: [
								// fees are paid by the larger party, its output is send-all
								// this party also collects the accumulated 10Kb bounce fees minus 10Kb to prevent abuse of confirmation bounce fees
								{address: "{$addressA}", amount: "{ $finalBalanceA <  $finalBalanceB ? 10000 : '' }"},
								{address: "{$addressB}", amount: "{ $finalBalanceA >= $finalBalanceB ? 10000 : '' }"},
							]
						}
					},
					{
						if:"{$asset != 'base'}",
						app: 'payment',
						payload: {
							asset: "{$asset}",
							outputs: [
								{address: "{$addressA}", amount: "{ $finalBalanceA < $finalBalanceB ? $finalBalanceA : '' }"},
								{address: "{$addressB}", amount: "{ $finalBalanceA >= $finalBalanceB ? $finalBalanceB : '' }"},
							]
						}
					},
					{
						app: 'data',  //we add data to indicate the channel is effectively closed
						payload: {
							closed: 1,
							period: "{var['period']}",
							event_id :"{var['event_id']}"
						}
					},
					{
						app: 'state',
						state: `{
							var['period'] += 1;
							var['close_initiated_by'] = false;
							var['close_start_ts'] = false;
							var['balanceA'] = false;
							var['balanceB'] = false;
							var['spentByA'] = false;
							var['spentByB'] = false;
							var['event_id'] += 1;
						}`
					},
				]
			},
			{ // fraud proof
				if: `{ trigger.data.fraud_proof AND var['close_initiated_by'] AND trigger.data.sentByPeer }`,
				init: `{
					$bInitiatedByA = (var['close_initiated_by'] == 'A');
					if (trigger.data.sentByPeer.signed_message.aa_address  != this_address)
						bounce('signed for another channel');
					if (trigger.data.sentByPeer.signed_message.period != var['period'])
						bounce('signed for a different period of this channel');
					if (!is_valid_signed_package(trigger.data.sentByPeer, $bInitiatedByA ? $addressA : $addressB))
						bounce('invalid signature by peer');
					$transferredFromPeer = trigger.data.sentByPeer.signed_message.amount_spent;
					if ($transferredFromPeer < 0)
						bounce('bad amount spent by peer: ' || $transferredFromPeer);
					$transferredFromPeerAsClaimedByPeer = var['spentBy' || ($bInitiatedByA ? 'A' : 'B')];
					if ($transferredFromPeer <= $transferredFromPeerAsClaimedByPeer)
						bounce("the peer didn't lie in his favor");
				}`,
				messages: [
					{
						app: 'payment',
						payload: {
							asset: "base",
							outputs: [
								// send all
								{address: "{trigger.address}"},
							]
						}
					},
					{ if: "{$asset != 'base'}",
						app: 'payment',
						payload: {
							asset: "{$asset}",
							outputs: [
								// send all
								{address: "{trigger.address}"},
							]
						}
					},
					{
						app: 'data',  //we add data to indicate the channel has been closed with a fraud proof submitted
						payload: {
							closed: 1,
							fraud_proof: 1,
							period: "{var['period']}",
							event_id :"{var['event_id']}"
						},
					},
					{
						app: 'state',
						state: `{
							var['period'] += 1;
							var['close_initiated_by'] = false;
							var['close_start_ts'] = false;
							var['balanceA'] = false;
							var['balanceB'] = false;
							var['spentByA'] = false;
							var['spentByB'] = false;
							if (!var['event_id'])
								var['event_id'] = 1;
							else
								var['event_id'] += 1;
						}`
					},

				]
			},
		]
	}
}];
}
exports.getAaAddress = getAaAddress;
exports.getAaArrDefinition = getAaArrDefinition;