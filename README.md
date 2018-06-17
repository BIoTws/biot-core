# biot-core

## Unstable! Use testnet only.

##### How to experience it?
```sh
$ npm install
$ cd examples
$ node balance.js
```


##### Docs
```sh
$ npm run docs
```

### Steps of channel work.

#### Opening of channel 
1) **A:** await_get1Contract
2) **B:** get1Contract
3) **B:** await_get1Contract
4) **A:** await_getInputsAndAddresses
5) **B:** await_createChannel
6) **A:** waiting_transfers
7) **B:** waiting_transfers


#### Transfer
1) **A:** waiting_reverse_transfer
2) **B:** waiting_transfer
3) **B:** waiting_reverse_transfer
4) **A:** waiting_transfer
5) **A:** waiting_transfers
6) **B:** waiting_transfers


#### closeOneSide
1) **A:** waiting_mci
2) **A:** close


#### closeMutually
1) **B:** await_closing
2) **A:** mutualClose
3) **B:** mutualClose