import type { AddressInterface } from 'ldk';
import { fetchAndUnblindUtxos, IdentityType, networks } from 'ldk';
import * as ecc from 'tiny-secp256k1';
import type { CustomScriptIdentityOpts } from '../src/domain/customscript-identity';
import { CustomScriptIdentity } from '../src/domain/customscript-identity';
import { makeRandomMnemonic } from './test.utils';
import * as synthAssetArtifact from './fixtures/customscript/synthetic_asset.ionio.json';
import * as transferWithCaptchaArtifact from './fixtures/customscript/transfer_with_captcha.ionio.json';
import { APIURL, broadcastTx, faucet } from './_regtest';
import type { Signer } from '@ionio-lang/ionio';
import type { CustomScriptAccountData } from '../src/domain/account';
import {
  accountFromMnemonicAndData,
  AccountType,
  initialCustomRestorerOpts,
} from '../src/domain/account';

const TEST_NAMESPACE = 'test';

jest.setTimeout(15000);

const failingArgs: { name: string; opts: CustomScriptIdentityOpts }[] = [
  {
    name: 'no mnemonic',
    opts: {
      mnemonic: '',
      namespace: TEST_NAMESPACE,
    },
  },
  {
    name: 'no namespace',
    opts: {
      mnemonic: makeRandomMnemonic().mnemonic,
      namespace: '',
    },
  },
  {
    name: 'wrong template',
    opts: {
      mnemonic: makeRandomMnemonic().mnemonic,
      namespace: TEST_NAMESPACE,
      template: 'this is a bad template',
    },
  },
  {
    name: 'wrong changeTemplate',
    opts: {
      mnemonic: makeRandomMnemonic().mnemonic,
      namespace: TEST_NAMESPACE,
      changeTemplate: 'this is a bad template',
      template: JSON.stringify(synthAssetArtifact),
    },
  },
];

function makeRandomCustomScriptIdentity(template?: string): CustomScriptIdentity {
  const mnemo = makeRandomMnemonic();
  return new CustomScriptIdentity({
    type: IdentityType.Mnemonic,
    chain: 'regtest',
    opts: { mnemonic: mnemo.mnemonic, namespace: TEST_NAMESPACE, template },
    ecclib: ecc,
  });
}

describe('CustomScriptIdentity', () => {
  const getUnspents = async (addr: AddressInterface) => {
    return await fetchAndUnblindUtxos(ecc, [addr], APIURL);
  };

  for (const failingArg of failingArgs) {
    test(`fails with ${failingArg.name}`, () => {
      expect(
        () =>
          new CustomScriptIdentity({
            type: IdentityType.Mnemonic,
            chain: 'regtest',
            opts: failingArg.opts,
            ecclib: ecc,
          })
      ).toThrow();
    });
  }

  test('should be able to instantiate a custom script identity without template', () => {
    const random = makeRandomCustomScriptIdentity();
    expect(random.contract.namespace).toBe(TEST_NAMESPACE);
    expect(random.contract.template).toBeUndefined();
  });

  test('should be able to instantiate a contract identity and import template as Ionio artifact', async () => {
    const template = JSON.stringify(synthAssetArtifact);
    const random = makeRandomCustomScriptIdentity(template);
    expect(random.contract.namespace).toBe(TEST_NAMESPACE);
    expect(random.contract.template).toBeDefined();

    const addr = await random.getNextAddress({
      borrowAsset: '2c5dfb37a33fe2acf5c5412b1ddbd58f6f3353578904f3ede0173b2867362463',
      borrowAmount: 1000_00000000,
      collateralAsset: '5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225',
      collateralAmount: 1_50000000,
      payoutAmount: 1500000,
      oraclePk: '0x0000000000000000000000000000000000000000000000000000000000000000',
      issuerPk: '0x0000000000000000000000000000000000000000000000000000000000000000',
      issuerScriptProgram: '0x0000000000000000000000000000000000000000000000000000000000000000',
      priceLevel: numberToString(20000),
      setupTimestamp: numberToString(1656686483),
    });

    expect(addr.confidentialAddress).toBeDefined();
    expect(addr.blindingPrivateKey).toBeDefined();
    expect(addr.derivationPath).toBeDefined();
    expect(addr.publicKey).toBeDefined();
    expect(addr.descriptor).toBeDefined();
    expect(addr.contract).toBeDefined();
    expect(addr.constructorParams).toBeDefined();
  });

  test('should be abloe to instantiate a contract identity with change template', async () => {
    const template = JSON.stringify(synthAssetArtifact);
    const changeTemplate = JSON.stringify(transferWithCaptchaArtifact);
    const random = new CustomScriptIdentity({
      type: IdentityType.Mnemonic,
      chain: 'regtest',
      opts: {
        mnemonic: makeRandomMnemonic().mnemonic,
        namespace: TEST_NAMESPACE,
        template,
        changeTemplate,
      },
      ecclib: ecc,
    });
    expect(random.contract.namespace).toBe(TEST_NAMESPACE);
    expect(random.contract.template).toBeDefined();
    expect(random.contract.changeTemplate).toBeDefined();

    const addr = await random.getNextChangeAddress({ sum: 7 });
    expect(addr.confidentialAddress).toBeDefined();
    expect(addr.blindingPrivateKey).toBeDefined();
    expect(addr.derivationPath).toBeDefined();
    expect(addr.publicKey).toBeDefined();
    expect(addr.descriptor).toBeDefined();
    expect(addr.contract).toBeDefined();
    expect(addr.constructorParams).toBeDefined();
  });

  test('should be able to instantiate a contract identity, fund the contract and spend those funds', async () => {
    const template = JSON.stringify(transferWithCaptchaArtifact);
    const random = makeRandomCustomScriptIdentity(template);
    expect(random.contract.namespace).toBe(TEST_NAMESPACE);
    expect(random.contract.template).toBeDefined();

    const addr = await random.getNextAddress({ sum: 7 });

    expect(addr.confidentialAddress).toBeDefined();
    expect(addr.blindingPrivateKey).toBeDefined();
    expect(addr.derivationPath).toBeDefined();
    expect(addr.publicKey).toBeDefined();
    expect(addr.descriptor).toBeDefined();
    expect(addr.contract).toBeDefined();
    expect(addr.constructorParams).toBeDefined();

    await faucet(addr.confidentialAddress, 0.01);

    const [utxo] = await getUnspents(addr);

    const instance = addr.contract.from(utxo.txid, utxo.vout, utxo.prevout, utxo.unblindData);
    const signer: Signer = {
      signTransaction: async (psetBase64: string): Promise<string> => {
        return random.signPset(psetBase64);
      },
    };
    const recipient =
      'el1qq20mpyk7ya3939tm0keheapgaympvcv2m4zr6dcnp6uqxjs7q4t2324gru07umsz8ymmetutvj2sfhusx4fl6gjgsk9l8e2rm';
    const feeAmount = 5000;
    const amount = 1000000 - feeAmount;
    const tx = instance.functions
      .transferWithSum(3, 4, signer)
      .withRecipient(recipient, amount, networks.regtest.assetHash)
      .withFeeOutput(feeAmount);

    const signedTx = await tx.unlock();
    const hex = signedTx.psbt.extractTransaction().toHex();
    const txid = await broadcastTx(hex);
    expect(txid).toBeDefined();
  });

  test('it should instanciate custom script account from custom script account data', async () => {
    const customScriptAccountData: CustomScriptAccountData = {
      type: AccountType.CustomScriptAccount,
      contractTemplate: {
        namespace: 'test',
        template: JSON.stringify(transferWithCaptchaArtifact),
        changeTemplate: JSON.stringify(synthAssetArtifact),
        isSpendableByMarina: false,
      },
      masterBlindingKey: 'd4422429e8f06ba093524b31b0ef6d69e2d26e0dd87fade4ab5c875fba2e85d1',
      masterXPub:
        'vpub5SLqN2bLY4WeYFQ5AFRZPCrhemcgnMPFCcM3L4aepayNa38B7xfjtfan5mNJevzBuUWA98y1CWab2L8dpefgywg3D7dvuNtY1X9UjUKgHvC',
      restorerOpts: {
        liquid: initialCustomRestorerOpts,
        regtest: initialCustomRestorerOpts,
        testnet: initialCustomRestorerOpts,
      },
    };
    const account = accountFromMnemonicAndData(
      'f343ad95c7be4b07b213ea489d6135b3fb7d659dfb4c9dc2ee9c9e7202100043b5fba308dd2f5d23cd3061452b644653b7c33d79704261feaefd220e9ef9a39784d593bb887f484dccd85b1eb7d53aba',
      customScriptAccountData
    );
    const id = await account.getWatchIdentity('liquid');
    expect(id).toBeDefined();
    const addr = await id.getNextAddress({ sum: 7 });
    expect(addr).toBeDefined();
    const addrChange = await id.getNextChangeAddress({
      borrowAsset: '2c5dfb37a33fe2acf5c5412b1ddbd58f6f3353578904f3ede0173b2867362463',
      borrowAmount: 1000_00000000,
      collateralAsset: '5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225',
      collateralAmount: 1_50000000,
      payoutAmount: 1500000,
      oraclePk: '0x0000000000000000000000000000000000000000000000000000000000000000',
      issuerPk: '0x0000000000000000000000000000000000000000000000000000000000000000',
      issuerScriptProgram: '0x0000000000000000000000000000000000000000000000000000000000000000',
      priceLevel: numberToString(20000),
      setupTimestamp: numberToString(1656686483),
    });
    expect(addrChange).toBeDefined();
  });
});

function numberToString(n: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return '0x'.concat(buf.toString('hex'));
}
