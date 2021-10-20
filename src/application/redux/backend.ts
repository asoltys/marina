import { RootReducerState } from '../../domain/common';
import { defaultPrecision } from '../utils/constants';
import axios from 'axios';
import browser from 'webextension-polyfill';
import {
  address as addressLDK,
  networks,
  isBlindedUtxo,
  BlindingKeyGetter,
  address,
  fetchAndUnblindTxsGenerator,
  fetchAndUnblindUtxosGenerator,
  masterPubKeyRestorerFromEsplora,
  MasterPublicKey,
  utxoWithPrevout,
  IdentityType,
  AddressInterface,
} from 'ldk';
import {
  fetchAssetsFromTaxi,
  getStateRestorerOptsFromAddresses,
  taxiURL,
  toDisplayTransaction,
  toStringOutpoint,
} from '../utils';
import { setDeepRestorerError, setDeepRestorerIsLoading, setWalletData } from './actions/wallet';
import { createAddress } from '../../domain/address';
import { setTaxiAssets, updateTaxiAssets } from './actions/taxi';
import { addUtxo, deleteUtxo, updateUtxos } from './actions/utxos';
import { addAsset } from './actions/asset';
import { ThunkAction } from 'redux-thunk';
import { AnyAction, Dispatch } from 'redux';
import { IAssets } from '../../domain/assets';
import { addTx, updateTxs } from './actions/transaction';
import { getExplorerURLSelector } from './selectors/app.selector';
import {
  RESET_APP,
  RESET_CONNECT,
  RESET_TAXI,
  RESET_TXS,
  RESET_WALLET,
} from './actions/action-types';
import { flushTx } from './actions/connect';
import { Account } from '../../domain/account';
import {
  selectMainAccount,
  selectUnspentsAndTransactions,
} from './selectors/wallet.selector';

const UPDATE_ALARM = 'UPDATE_ALARM';

type AccountSelector = (state: RootReducerState) => Account;

/**
 * fetch the asset infos from explorer (ticker, precision etc...)
 */
async function fetchAssetInfos(
  assetHash: string,
  explorerUrl: string,
  assetsState: IAssets,
  dispatch: Dispatch
) {
  if (assetsState[assetHash] !== undefined) return; // do not update

  const assetInfos = (await axios.get(`${explorerUrl}/asset/${assetHash}`)).data;
  const name = assetInfos?.name ? assetInfos.name : 'Unknown';
  const ticker = assetInfos?.ticker ? assetInfos.ticker : assetHash.slice(0, 4).toUpperCase();
  const precision = assetInfos.precision !== undefined ? assetInfos.precision : defaultPrecision;

  dispatch(addAsset(assetHash, { name, ticker, precision }));
}

async function getAddressesFromAccount(account: Account): Promise<AddressInterface[]> {
  return (await account.getWatchIdentity()).getAddresses();
}

// fetch and unblind the utxos and then refresh it.
export function makeUtxosUpdaterThunk(
  selectAccount: AccountSelector
): ThunkAction<void, RootReducerState, any, AnyAction> {
  return async (dispatch, getState) => {
    try {
      const state = getState();
      const { app } = state;
      if (!app.isAuthenticated) return;

      const account = selectAccount(state);
      const explorer = getExplorerURLSelector(getState());
      const utxosMap = selectUnspentsAndTransactions(account.accountID)(state).utxosMap;

      const currentOutpoints = Object.values(utxosMap || {}).map(({ txid, vout }) => ({
        txid,
        vout,
      }));

      const skippedOutpoints: string[] = []; // for deleting

      // Fetch utxo(s). Return blinded utxo(s) if unblinding has been skipped
      const utxos = fetchAndUnblindUtxosGenerator(
        await getAddressesFromAccount(account),
        explorer,
        // Skip unblinding if utxo exists in current state
        (utxo) => {
          const outpoint = toStringOutpoint(utxo);
          const skip = utxosMap[outpoint] !== undefined;

          if (skip) skippedOutpoints.push(toStringOutpoint(utxo));

          return skip;
        }
      );

      let utxoIterator = await utxos.next();
      while (!utxoIterator.done) {
        let utxo = utxoIterator?.value;
        if (!isBlindedUtxo(utxo)) {
          if (utxo.asset) {
            const assets = getState().assets;
            await fetchAssetInfos(utxo.asset, explorer, assets, dispatch).catch(console.error);
          }

          if (!utxo.prevout) {
            utxo = await utxoWithPrevout(utxo, explorer);
          }

          dispatch(addUtxo(account.accountID, utxo));
        }
        utxoIterator = await utxos.next();
      }

      if (utxoIterator.done) {
        console.info(`number of utxos fetched: ${utxoIterator.value.numberOfUtxos}`);
        if (utxoIterator.value.errors.length > 0) {
          console.warn(
            `${utxoIterator.value.errors.length} errors occurs during utxos updater generator`
          );
        }
      }

      for (const outpoint of currentOutpoints) {
        if (skippedOutpoints.includes(toStringOutpoint(outpoint))) continue;
        // if not skipped, it means the utxo has been spent
        dispatch(deleteUtxo(outpoint.txid, outpoint.vout));
      }
    } catch (error) {
      console.error(`fetchAndUpdateUtxos error: ${error}`);
    }
  };
}

/**
 * use fetchAndUnblindTxsGenerator to update the tx history
 */
export function makeTxsUpdaterThunk(
  selectAccount: AccountSelector
): ThunkAction<void, RootReducerState, any, AnyAction> {
  return async (dispatch, getState) => {
    try {
      const state = getState();
      const { app } = state;
      if (!app.isAuthenticated) return;

      const account = selectAccount(state);
      const txsHistory = selectUnspentsAndTransactions(account.accountID)(state).transactions[
        app.network
      ];

      // Initialize txs to txsHistory shallow clone
      const addressInterfaces = await getAddressesFromAccount(account);
      const walletScripts = addressInterfaces.map((a) =>
        address.toOutputScript(a.confidentialAddress).toString('hex')
      );

      const explorer = getExplorerURLSelector(getState());

      const identityBlindKeyGetter: BlindingKeyGetter = (script: string) => {
        try {
          const address = addressLDK.fromOutputScript(
            Buffer.from(script, 'hex'),
            networks[app.network]
          );
          return addressInterfaces.find(
            (addr) =>
              addressLDK.fromConfidential(addr.confidentialAddress).unconfidentialAddress ===
              address
          )?.blindingPrivateKey;
        } catch (_) {
          return undefined;
        }
      };

      const txsGen = fetchAndUnblindTxsGenerator(
        addressInterfaces.map((a) => a.confidentialAddress),
        identityBlindKeyGetter,
        explorer,
        // Check if tx exists in React state
        (tx) => txsHistory[tx.txid] !== undefined
      );

      let it = await txsGen.next();

      // If no new tx already in state then return txsHistory of current network
      if (it.done) {
        return;
      }

      while (!it.done) {
        const tx = it.value;
        // Update all txsHistory state at each single new tx
        const toAdd = toDisplayTransaction(tx, walletScripts, networks[app.network]);
        dispatch(addTx(account.accountID, toAdd, app.network));
        it = await txsGen.next();
      }
    } catch (error) {
      console.error(`fetchAndUnblindTxs: ${error}`);
    }
  };
}

/**
 * fetch assets from taxi daemon endpoint (make a grpc call)
 * and then set assets in store.
 */
export function fetchAndSetTaxiAssets(): ThunkAction<void, RootReducerState, any, AnyAction> {
  return async (dispatch, getState) => {
    const state = getState();
    const assets = await fetchAssetsFromTaxi(taxiURL[state.app.network]);

    const currentAssets = state.taxi.taxiAssets;
    const sortAndJoin = (a: string[]) => a.sort().join('');

    if (sortAndJoin(currentAssets) === sortAndJoin(assets)) {
      return; // skip if same assets state
    }

    dispatch(setTaxiAssets(assets));
  };
}

// Start the periodic updater (for utxos and txs fetching)
export function startAlarmUpdater(): ThunkAction<void, RootReducerState, any, AnyAction> {
  return (dispatch) => {
    dispatch(updateUtxos());

    browser.alarms.onAlarm.addListener((alarm) => {
      switch (alarm.name) {
        case UPDATE_ALARM:
          dispatch(updateTxs());
          dispatch(updateUtxos());
          dispatch(updateTaxiAssets());
          break;

        default:
          break;
      }
    });

    browser.alarms.create(UPDATE_ALARM, {
      when: Date.now(),
      periodInMinutes: 1,
    });
  };
}

// Using to generate addresses and use the explorer to test them
export function deepRestorer(): ThunkAction<void, RootReducerState, any, AnyAction> {
  return async (dispatch, getState) => {
    const state = getState();
    const { isLoading, gapLimit } = state.wallet.deepRestorer;
    const toRestore = new MasterPublicKey({
      chain: state.app.network,
      type: IdentityType.MasterPublicKey,
      opts: {
        masterPublicKey: state.wallet.mainAccount.masterXPub,
        masterBlindingKey: state.wallet.mainAccount.masterBlindingKey,
      },
    });
    const explorer = getExplorerURLSelector(getState());
    if (isLoading) return;

    try {
      dispatch(setDeepRestorerIsLoading(true));
      const opts = { gapLimit, esploraURL: explorer };
      const publicKey = await masterPubKeyRestorerFromEsplora(toRestore)(opts);
      const addresses = (await publicKey.getAddresses()).map((a) =>
        createAddress(a.confidentialAddress, a.derivationPath)
      );

      const restorerOpts = getStateRestorerOptsFromAddresses(addresses);

      dispatch(
        setWalletData({
          ...state.wallet.mainAccount,
          restorerOpts,
          confidentialAddresses: addresses,
          passwordHash: state.wallet.passwordHash,
        })
      );

      dispatch(updateUtxos());
      dispatch(makeTxsUpdaterThunk(selectMainAccount));
      dispatch(fetchAndSetTaxiAssets());

      dispatch(setDeepRestorerError(undefined));
    } catch (err: any) {
      dispatch(setDeepRestorerError(err.message || err));
    } finally {
      dispatch(setDeepRestorerIsLoading(false));
    }
  };
}

// reset all the reducers except the `assets` reducer (shared data).
export function resetAll(): ThunkAction<void, RootReducerState, any, AnyAction> {
  return (dispatch) => {
    dispatch({ type: RESET_TAXI });
    dispatch({ type: RESET_TXS });
    dispatch({ type: RESET_APP });
    dispatch({ type: RESET_WALLET });
    dispatch({ type: RESET_CONNECT });
    dispatch(flushTx());
  };
}
