import { AnyAction } from 'redux';
import { ConnectData } from '../../../domain/connect';
import { Network } from '../../../domain/network';
import {
  DISABLE_WEBSITE,
  ENABLE_WEBSITE,
  FLUSH_MSG,
  FLUSH_SELECTED_HOSTNAME,
  FLUSH_TX,
  SELECT_HOSTNAME,
  SET_MSG,
  SET_TX,
} from './action-types';

export function enableWebsite(hostname: string, network: Network): AnyAction {
  return {
    type: ENABLE_WEBSITE,
    payload: { hostname, network },
  };
}

export function disableWebsite(hostname: string, network: Network): AnyAction {
  return {
    type: DISABLE_WEBSITE,
    payload: { hostname, network },
  };
}

export function setMsg(hostname: string, message: string): AnyAction {
  return {
    type: SET_MSG,
    payload: { hostname, message },
  };
}

export function flushMsg(): AnyAction {
  return {
    type: FLUSH_MSG,
  };
}

export function flushTx(): AnyAction {
  return {
    type: FLUSH_TX,
  };
}

export function setTx(hostname: string, pset: string): AnyAction {
  return {
    type: SET_TX,
    payload: { hostname, pset } as ConnectData['tx'],
  };
}

export function setTxData(
  hostname: string,
  recipient: string,
  amount: string,
  assetHash: string,
  network: Network
): AnyAction {
  return {
    type: SET_TX,
    payload: { hostname, recipient, amount, assetHash, network } as ConnectData['tx'],
  };
}

export function selectHostname(hostname: string, network: Network): AnyAction {
  return {
    type: SELECT_HOSTNAME,
    payload: { hostname, network },
  };
}

export function flushSelectedHostname(network: Network): AnyAction {
  return {
    type: FLUSH_SELECTED_HOSTNAME,
    payload: { network },
  };
}