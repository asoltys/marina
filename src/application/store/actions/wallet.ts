import {
  AddressInterface,
  EsploraIdentityRestorer,
  IdentityOpts,
  IdentityType,
  fetchUtxos,
  fromXpub,
  Mnemonic,
  MasterPublicKey,
  Outpoint,
  toOutpoint,
  tryToUnblindUtxo,
  UtxoInterface,
} from 'ldk';
import {
  INIT_WALLET,
  WALLET_CREATE_FAILURE,
  WALLET_CREATE_SUCCESS,
  WALLET_DERIVE_ADDRESS_FAILURE,
  WALLET_DERIVE_ADDRESS_SUCCESS,
  WALLET_RESTORE_FAILURE,
  WALLET_RESTORE_SUCCESS,
  WALLET_SET_UTXOS_FAILURE,
  WALLET_SET_UTXOS_SUCCESS,
  WALLET_GET_ALL_BALANCES_SUCCESS,
  WALLET_GET_ALL_BALANCES_FAILURE,
} from './action-types';
import { Action, IAppState, Thunk } from '../../../domain/common';
import { encrypt, hash } from '../../utils/crypto';
import IdentityRestorerFromState from '../../utils/restorer';
import { IWallet } from '../../../domain/wallet/wallet';
import {
  Address,
  MasterBlindingKey,
  MasterXPub,
  Mnemonic as Mnemo,
  Password,
} from '../../../domain/wallet/value-objects';

export function initWallet(wallet: IWallet): Thunk<IAppState, Action> {
  return (dispatch, getState) => {
    const { wallets } = getState();
    if (wallets.length <= 0) {
      dispatch([INIT_WALLET, { ...wallet }]);
    }
  };
}

export function createWallet(
  password: Password,
  mnemonic: Mnemo,
  onSuccess: () => void,
  onError: (err: Error) => void
): Thunk<IAppState, Action> {
  return async (dispatch, getState, repos) => {
    const { app, wallets } = getState();
    if (wallets.length > 0 && wallets[0].encryptedMnemonic) {
      throw new Error(
        'Wallet already exists. Remove the extension from the browser first to create a new one'
      );
    }

    try {
      const chain = app.network.value;
      const mnemonicWallet = new Mnemonic({
        chain,
        type: IdentityType.Mnemonic,
        value: { mnemonic: mnemonic.value },
      } as IdentityOpts);

      const masterXPub = MasterXPub.create(mnemonicWallet.masterPublicKey);
      const masterBlindingKey = MasterBlindingKey.create(mnemonicWallet.masterBlindingKey);
      const encryptedMnemonic = encrypt(mnemonic, password);
      const passwordHash = hash(password);
      const confidentialAddresses: Address[] = [];
      const utxoMap = new Map<Outpoint, UtxoInterface>();

      await repos.wallet.getOrCreateWallet({
        masterXPub,
        masterBlindingKey,
        encryptedMnemonic,
        passwordHash,
        confidentialAddresses,
        utxoMap,
      });

      // Update React state
      dispatch([
        WALLET_CREATE_SUCCESS,
        {
          confidentialAddresses,
          encryptedMnemonic,
          masterXPub,
          masterBlindingKey,
          passwordHash,
          utxoMap,
        },
      ]);

      onSuccess();
    } catch (error) {
      dispatch([WALLET_CREATE_FAILURE, { error }]);
      onError(error);
    }
  };
}

export function restoreWallet(
  password: Password,
  mnemonic: Mnemo,
  onSuccess: () => void,
  onError: (err: Error) => void
): Thunk<IAppState, Action> {
  return async (dispatch, getState, repos) => {
    const { app, wallets } = getState();
    if (wallets.length > 0 && wallets[0].encryptedMnemonic) {
      throw new Error(
        'Wallet already exists. Remove the extension from the browser first to create a new one'
      );
    }

    const chain = app.network.value;
    let restorer = Mnemonic.DEFAULT_RESTORER;
    if (chain === 'regtest') {
      restorer = new EsploraIdentityRestorer('http://localhost:3001');
    }

    // Restore wallet from mnemonic
    try {
      const mnemonicWallet = new Mnemonic({
        chain,
        restorer,
        type: IdentityType.Mnemonic,
        value: { mnemonic: mnemonic.value },
        initializeFromRestorer: true,
      } as IdentityOpts);

      const masterXPub = MasterXPub.create(mnemonicWallet.masterPublicKey);
      const masterBlindingKey = MasterBlindingKey.create(mnemonicWallet.masterBlindingKey);
      const encryptedMnemonic = encrypt(mnemonic, password);
      const passwordHash = hash(password);
      const isRestored = await mnemonicWallet.isRestored;
      if (!isRestored) {
        throw new Error('Failed to restore wallet');
      }
      const confidentialAddresses: Address[] = mnemonicWallet
        .getAddresses()
        .map(({ confidentialAddress }) => Address.create(confidentialAddress));

      const utxoMap = new Map<Outpoint, UtxoInterface>();

      await repos.wallet.getOrCreateWallet({
        masterXPub,
        masterBlindingKey,
        encryptedMnemonic,
        passwordHash,
        confidentialAddresses,
        utxoMap,
      });

      dispatch([
        WALLET_RESTORE_SUCCESS,
        {
          masterXPub,
          masterBlindingKey,
          encryptedMnemonic,
          passwordHash,
          confidentialAddresses,
          utxoMap,
        },
      ]);
      onSuccess();
    } catch (error) {
      dispatch([WALLET_RESTORE_FAILURE, { error }]);
      onError(error);
    }
  };
}

export function deriveNewAddress(
  change: boolean,
  onSuccess: (confidentialAddress: string) => void,
  onError: (err: Error) => void
): Thunk<IAppState, Action> {
  return async (dispatch, getState, repos) => {
    const { app, wallets } = getState();
    if (!wallets?.[0].masterXPub || !wallets?.[0].masterBlindingKey) {
      throw new Error('Cannot derive new address');
    }

    const chain = app.network.value;
    const { confidentialAddresses, masterBlindingKey, masterXPub } = wallets[0];
    const restorer = new IdentityRestorerFromState(confidentialAddresses.map((addr) => addr.value));
    // Restore wallet from MasterPublicKey
    try {
      const pubKeyWallet = new MasterPublicKey({
        chain,
        restorer,
        type: IdentityType.MasterPublicKey,
        value: {
          masterPublicKey: fromXpub(masterXPub.value, chain),
          masterBlindingKey: masterBlindingKey.value,
        },
        initializeFromRestorer: true,
      });
      const isRestored = await pubKeyWallet.isRestored;
      if (!isRestored) {
        throw new Error('Failed to restore wallet');
      }

      let nextAddress: string;
      if (change) {
        nextAddress = pubKeyWallet.getNextChangeAddress().confidentialAddress;
      } else {
        nextAddress = pubKeyWallet.getNextAddress().confidentialAddress;
      }

      const address = Address.create(nextAddress);
      await repos.wallet.addDerivedAddress(address);

      // Update React state
      dispatch([WALLET_DERIVE_ADDRESS_SUCCESS, { address }]);
      onSuccess(address.value);
    } catch (error) {
      dispatch([WALLET_DERIVE_ADDRESS_FAILURE, { error }]);
      onError(error);
    }
  };
}

/**
 * Extract balances from all unblinded utxos in state
 * @param onSuccess
 * @param onError
 */
export function getAllBalances(
  onSuccess: (balances: { [assetHash: string]: number }) => void,
  onError: (err: Error) => void
): Thunk<IAppState, Action> {
  return (dispatch, getState) => {
    const { wallets } = getState();
    const balances = Array.from(wallets[0].utxoMap.values()).reduce((acc, curr) => {
      if (!curr.asset || !curr.value) {
        dispatch([WALLET_GET_ALL_BALANCES_FAILURE]);
        onError(new Error(`Missing utxo info. Asset: ${curr.asset}, Value: ${curr.value}`));
        return acc;
      }
      acc = { ...acc, [curr.asset]: curr.value };
      return acc;
    }, {} as { [assetHash: string]: number });
    dispatch([WALLET_GET_ALL_BALANCES_SUCCESS]);
    onSuccess(balances);
  };
}

/**
 * Check that utxoMapStore and fetchedUtxos have the same set of utxos
 * @param utxoMapStore
 * @param fetchedUtxos
 * @returns boolean - true if utxo sets are equal, false if not
 */
export function compareUtxos(
  utxoMapStore: Map<Outpoint, UtxoInterface>,
  fetchedUtxos: UtxoInterface[]
) {
  if (utxoMapStore?.size !== fetchedUtxos?.length) return false;
  for (const outpoint of utxoMapStore.keys()) {
    // At least one outpoint in utxoMapStore is present in fetchedUtxos
    const isEqual = fetchedUtxos.some(
      (utxo) => utxo.txid === outpoint.txid && utxo.vout === outpoint.vout
    );
    if (!isEqual) return false;
  }
  return true;
}

export function setUtxos(
  addressesWithBlindingKeys: AddressInterface[],
  onSuccess: () => void,
  onError: (err: Error) => void
): Thunk<IAppState, Action> {
  return async (dispatch, getState, repos) => {
    try {
      // Fetch utxos and return with corresponding blinding key
      const fetchedUtxosWithBlindingPrivateKey = (await Promise.all(
        addressesWithBlindingKeys.map(async (o) => ({
          utxos: await fetchUtxos(o.confidentialAddress, 'http://localhost:3001'),
          blindingPrivateKey: o.blindingPrivateKey,
        }))
      )) as {
        utxos: UtxoInterface[];
        blindingPrivateKey: AddressInterface['blindingPrivateKey'];
      }[];

      // Extract utxos of all key pairs in flat array
      const allUtxos = fetchedUtxosWithBlindingPrivateKey.reduce(
        (acc, curr) => [...acc, ...curr.utxos],
        [] as UtxoInterface[]
      );

      const { wallets } = getState();
      // If utxo sets not equal, create utxoMap and update stores
      if (!compareUtxos(wallets[0].utxoMap, allUtxos)) {
        const unblindedOrNotUtxos = await Promise.all(
          fetchedUtxosWithBlindingPrivateKey.map(async (keyPairData) => {
            return await Promise.all(
              keyPairData.utxos.map(
                async (utxo) =>
                  await tryToUnblindUtxo(
                    utxo,
                    keyPairData.blindingPrivateKey,
                    'http://localhost:3001'
                  )
              )
            );
          })
        );
        const utxoMap = new Map<Outpoint, UtxoInterface>();
        unblindedOrNotUtxos.forEach((keyPairUtxos) =>
          keyPairUtxos.forEach((utxo) => utxoMap.set(toOutpoint(utxo), utxo))
        );
        await repos.wallet.setUtxos(utxoMap);
        dispatch([WALLET_SET_UTXOS_SUCCESS, { utxoMap }]);
      }
      onSuccess();
    } catch (error) {
      dispatch([WALLET_SET_UTXOS_FAILURE, { error }]);
      onError(error);
    }
  };
}