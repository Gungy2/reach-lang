import * as stdlib_loader from '@reach-sh/stdlib/loader.mjs';
import * as backend from './build/index.main.mjs';
import algosdk from 'algosdk';
import ethers from 'ethers';
import * as fs from 'fs';

const shouldFail = async (fp) => {
  let worked = undefined;
  try {
    await fp();
    worked = true;
  } catch (e) {
    worked = false;
  }
  console.log(`\tshouldFail = ${worked}`);
  if (worked !== false) {
    throw Error(`shouldFail`);
  }
};

(async () => {
  const stdlib = await stdlib_loader.loadStdlib();
  const conn = stdlib_loader.getConnector();

  const startingBalance = stdlib.parseCurrency(10);
  const myGasLimit = 5000000;

  const ETH_launchToken = async (name, sym) => {
    console.log(`Creator launching ETH token, ${name} (${sym})`);
    const accCreator = await stdlib.newTestAccount(startingBalance);
    accCreator.setGasLimit(myGasLimit);
    const compiled = JSON.parse(await fs.readFileSync('./build/token.sol.json'));
    const remoteCtc = compiled["contracts"]["contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol:ERC20PresetMinterPauser"];
    const remoteABI = remoteCtc["abi"];
    const remoteBytecode = remoteCtc["bin"];
    const factory = new ethers.ContractFactory(remoteABI, remoteBytecode, accCreator.networkAccount);
    console.log(`Creator: deploy`);
    const contract = await factory.deploy(name, sym, { gasLimit: myGasLimit });
    console.log(`Creator: wait for deploy: ${contract.deployTransaction.hash}`);
    const deploy_r = await contract.deployTransaction.wait();
    console.log(`Creator: saw deploy: ${deploy_r.blockNumber}`);
    const id = contract.address;
    console.log(`Creator: deployed: ${id}`);
    const mint = async (accTo, amt) => {
      const to = accTo.networkAccount.address;
      console.log(`Creator: minting ${amt} ${sym} for ${to}`);
      const fn = await contract["mint"](to, amt, { gasLimit: myGasLimit });
      console.log(`Creator: mint: wait`);
      await fn.wait();
    };
    const balanceOf = async (acc) => {
      const addr = acc.networkAccount.address;
      const res = await contract["balanceOf"](addr);
      return res;
    };
    return { name, sym, id, mint, balanceOf };
  };
  const ALGO_launchToken = async (name, sym) => {
    console.log(`${sym} launching ALGO token, ${name} (${sym})`);
    const accCreator = await stdlib.newTestAccount(startingBalance);
    const addr = (acc) => acc.networkAccount.addr;
    const caddr = addr(accCreator);
    const zaddr = caddr;
    // ^ XXX should be nothing; docs say can be "", but doesn't actually work
    const algod = await stdlib.getAlgodClient();
    const dotxn = async (mktxn, acc = accCreator) => {
      const sk = acc.networkAccount.sk;
      const params = await stdlib.getTxnParams();
      const t = mktxn(params);
      const s = t.signTxn(sk);
      const r = (await algod.sendRawTransaction(s).do());
      await stdlib.waitForConfirmation(r.txId);
      return await algod.pendingTransactionInformation(r.txId).do();
    };
    const ctxn_p = await dotxn((params) =>
      algosdk.makeAssetCreateTxnWithSuggestedParams(
        caddr, undefined, Math.pow(2,48), 6,
        false, zaddr, zaddr, zaddr, zaddr,
        sym, name, '', '', params,
      ));
    const id = ctxn_p["asset-index"];
    console.log(`${sym}: asset is ${id}`);

    const mint = async (accTo, amt) => {
      console.log(`${sym}: minting ${amt} ${sym} for ${addr(accTo)}`);
      await stdlib.transfer(accCreator, accTo, amt, id);
    };
    const optOut = async (accFrom, accTo = accCreator) => {
      await dotxn((params) =>
        algosdk.makeAssetTransferTxnWithSuggestedParams(
          addr(accFrom), addr(accTo), addr(accTo), undefined,
          0, undefined, id, params
      ), accFrom);
    };
    const balanceOf = async (accFrom) => {
      const taddr = addr(accFrom);
      console.log(`${sym}: balanceOf of ${taddr}`);
      const {assets} = await algod.accountInformation(taddr).do();
      for ( const ai of assets ) {
        if ( ai['asset-id'] === id ) {
          return ai['amount'];
        }
      }
      return false;
    };
    return { name, sym, id, mint, balanceOf, optOut };
  };
  const launchTokens = {
    'ETH': ETH_launchToken,
    'ALGO': ALGO_launchToken,
  };
  const launchToken = launchTokens[conn];

  const zorkmid = await launchToken("zorkmid", "ZMD");
  const gil = await launchToken("gil", "GIL");

  const accAlice = await stdlib.newTestAccount(startingBalance);
  const accBob = await stdlib.newTestAccount(startingBalance);
  if ( conn === 'ETH' ) {
    console.log(`Setting gasLimit on ETH`);
    accAlice.setGasLimit(myGasLimit);
    accBob.setGasLimit(myGasLimit);
  } else if ( conn == 'ALGO' ) {
    console.log(`Demonstrating need to opt-in on ALGO`);
    await shouldFail(async () => await zorkmid.mint(accAlice, startingBalance));
    console.log(`Opt-ing in on ALGO`);
    await stdlib.transfer(accAlice, accAlice, 0, zorkmid.id);
    await stdlib.transfer(accAlice, accAlice, 0, gil.id);
    await stdlib.transfer(accBob, accBob, 0, zorkmid.id);
    await stdlib.transfer(accBob, accBob, 0, gil.id);
  }

  await zorkmid.mint(accAlice, startingBalance);
  await zorkmid.mint(accAlice, startingBalance);
  await gil.mint(accBob, startingBalance);

  if ( conn == 'ALGO' ) {
    console.log(`Demonstrating opt-out on ALGO`);
    console.log(`\tAlice opts out`);
    await zorkmid.optOut(accAlice);
    console.log(`\tAlice can't receive mint`);
    await shouldFail(async () => await zorkmid.mint(accAlice, startingBalance));
    console.log(`\tAlice re-opts-in`);
    await stdlib.transfer(accAlice, accAlice, 0, zorkmid.id);
    console.log(`\tAlice can receive mint`);
    await zorkmid.mint(accAlice, startingBalance);
  }

  const fmt = (x) => stdlib.formatCurrency(x, 4);
  const doSwap = async (tokenA, amtA, tokenB, amtB, trusted) => {
    console.log(`\nPerforming swap of ${fmt(amtA)} ${tokenA.sym} for ${fmt(amtB)} ${tokenB.sym}`);

    const getBalance = async (tokenX, who) => {
      const amt = await tokenX.balanceOf(who);
      return `${fmt(amt)} ${tokenX.sym}`; };
    const getBalances = async (who) =>
      `${await getBalance(tokenA, who)} & ${await getBalance(tokenB, who)}`;

    const beforeAlice = await getBalances(accAlice);
    const beforeBob = await getBalances(accBob);
    console.log(`Alice has ${beforeAlice}`);
    console.log(`Bob has ${beforeBob}`);

    if ( trusted ) {
      console.log(`Alice transfers to Bob honestly`);
      await stdlib.transfer(accAlice, accBob, amtA, tokenA.id);
      console.log(`Bob transfers to Alice honestly`);
      await stdlib.transfer(accBob, accAlice, amtB, tokenB.id);
    } else {
      console.log(`Alice will deploy the Reach DApp.`);
      const ctcAlice = accAlice.deploy(backend);
      console.log(`Bob attaches to the Reach DApp.`);
      const ctcBob = accBob.attach(backend, ctcAlice.getInfo());

      await Promise.all([
        backend.Alice(ctcAlice, {
          getSwap: () => {
            console.log(`Alice proposes swap`);
            return [ tokenA.id, amtA, tokenB.id, amtB, 10 ]; },
        }),
        backend.Bob(ctcBob, {
          accSwap: (...v) => {
            console.log(`Bob accepts swap of ${JSON.stringify(v)}`);
            return true; },
        }),
      ]);
    }

    const afterAlice = await getBalances(accAlice);
    const afterBob = await getBalances(accBob);
    console.log(`Alice went from ${beforeAlice} to ${afterAlice}`);
    console.log(`Bob went from ${beforeBob} to ${afterBob}`);
  };

  const amtA = stdlib.parseCurrency(1);
  const amtB = stdlib.parseCurrency(2);

  await doSwap(zorkmid, amtA, gil, amtB, false);
  await doSwap(gil, amtB, zorkmid, amtA, false);
  await doSwap(zorkmid, amtA, gil, amtB, true);

  // It would be cool to support ETH without going through WETH
  // const eth = { addr: false, sym: 'ETH', balanceOf: stdlib.balanceOf };
  // await doSwap(eth, amtA, gil, amtB);
  // await doSwap(zorkmid, amtA, eth, amtB);

})();
