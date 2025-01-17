import type { AllEffect } from 'redux-saga/effects';
import { call, put, takeLeading, fork, all } from 'redux-saga/effects';
import { fetchAssetsFromTaxi, taxiURL } from '../../utils/taxi';
import {
  RESET,
  RESET_APP,
  RESET_CONNECT,
  RESET_TAXI,
  RESET_WALLET,
  UPDATE_TAXI_ASSETS,
} from '../actions/action-types';
import { setTaxiAssets } from '../actions/taxi';
import type { SagaGenerator } from './utils';
import { selectNetworkSaga, newSagaSelector } from './utils';
import { updateAfterEachLoginAction, watchUpdateTask } from './updater';
import { watchRestoreTask } from './deep-restorer';
import type { NetworkString } from 'ldk';
import { selectTaxiAssetsForNetwork } from '../selectors/taxi.selector';

function* fetchAndSetTaxiAssets(): SagaGenerator<void, string[]> {
  yield* fetchTaxiAssetsForNetwork('liquid');
  yield* fetchTaxiAssetsForNetwork('testnet');

  const network = yield* selectNetworkSaga();

  if (network === 'regtest') {
    try {
      yield* fetchTaxiAssetsForNetwork('regtest');
    } catch {
      console.warn(
        'fail to update your taxi assets for regtest network, please check if taxi is running locally on localhost:8000'
      );
    }
  }
}

function* fetchTaxiAssetsForNetwork(network: NetworkString): SagaGenerator<void, string[]> {
  try {
    const assets = yield call(fetchAssetsFromTaxi, taxiURL[network]);
    const currentTaxiAssets = yield* newSagaSelector(selectTaxiAssetsForNetwork(network))();
    const sortAndJoin = (a: string[]) => a.sort().join('');
    if (sortAndJoin(assets) !== sortAndJoin(currentTaxiAssets)) {
      yield put(setTaxiAssets(network, assets));
    }
  } catch (err: unknown) {
    console.warn(`fetch taxi assets error: ${(err as Error).message || 'unknown'}`);
    // ignore errors
  }
}

// watch for every UPDATE_TAXI_ASSETS actions
// wait that previous update is done before begin the new one
function* watchUpdateTaxi(): SagaGenerator<void, void> {
  yield takeLeading(UPDATE_TAXI_ASSETS, fetchAndSetTaxiAssets);
}

function* reset(): Generator<AllEffect<any>> {
  const actionsTypes = [RESET_APP, RESET_WALLET, RESET_CONNECT, RESET_TAXI];
  yield all(actionsTypes.map((type) => put({ type })));
}

// watch for every RESET actions
// run reset saga in order to clean the redux state
function* watchReset(): SagaGenerator<void, void> {
  yield takeLeading(RESET, reset);
}

function* mainSaga(): SagaGenerator<void, void> {
  yield fork(watchReset);
  yield fork(watchUpdateTaxi);
  yield fork(watchUpdateTask);
  yield fork(updateAfterEachLoginAction);
  yield fork(watchRestoreTask);
}

export default mainSaga;
