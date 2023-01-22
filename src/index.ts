import { GelatoRelay, RelayResponse } from "@gelatonetwork/relay-sdk";
import { BigNumber, BigNumberish, BytesLike, ethers } from "ethers";

import {
  EIP712_SAFE_TX_TYPE,
  FALLBACK_HANDLER_ADDRESS,
  GNOSIS_SAFE,
  GNOSIS_SAFE_PROXY_FACTORY,
  SALT,
  ZERO_ADDRESS,
} from "./constants";
import {
  GnosisSafeProxyFactory__factory,
  GnosisSafe__factory,
  MultiCall__factory,
} from "./contracts/types";
import { GnosisSafeInterface } from "./contracts/types/GnosisSafe";
import { GnosisSafeProxyFactoryInterface } from "./contracts/types/GnosisSafeProxyFactory";
import { MultiCallInterface, Multicall2 } from "./contracts/types/MultiCall";
import { adjustVInSignature, getMultiCallContractAddress } from "./utils";

export interface SmartWalletConfig {
  apiKey: string;
}
export class GelatoSmartWallet {
  readonly #provider: ethers.providers.Web3Provider;
  #gelatoRelay: GelatoRelay;
  #address: string | undefined;
  #chainId: number | undefined;
  #apiKey: string;
  #isInitialized = false;

  // Contract Interfaces
  readonly #gnosisSafeInterface: GnosisSafeInterface =
    GnosisSafe__factory.createInterface();
  readonly #gnosisSafeProxyFactoryInterface: GnosisSafeProxyFactoryInterface =
    GnosisSafeProxyFactory__factory.createInterface();
  readonly #multiCallInterface: MultiCallInterface =
    MultiCall__factory.createInterface();

  constructor(
    eoaProvider:
      | ethers.providers.ExternalProvider
      | ethers.providers.JsonRpcFetchFunc,
    config: SmartWalletConfig
  ) {
    this.#gelatoRelay = new GelatoRelay();
    this.#provider = new ethers.providers.Web3Provider(eoaProvider);
    this.#apiKey = config.apiKey;
  }

  public async init() {
    this.#address = await this._calculateSmartWalletAddress();
    this.#chainId = (await this.#provider.getNetwork()).chainId;
    if (!this.#address || !this.#chainId) {
      throw new Error(
        `GelatoSmartWallet could not be initialized: address[${
          this.#address
        }] chainId[${this.#chainId}]`
      );
    }
    this.#isInitialized = true;
  }

  public isInitialized(): boolean {
    return this.#isInitialized;
  }

  public getAddress() {
    return this.#address;
  }

  public async isDeployed() {
    return await this._checkIfDeployed();
  }

  public async sendTransaction(
    to: string,
    data: string,
    value: BigNumberish = 0
  ): Promise<RelayResponse> {
    if (!this.isInitialized() || !this.#address || !this.#chainId) {
      throw new Error("GelatoSmartWallet is not initialized");
    }
    if (await this._checkIfDeployed()) {
      return await this.#gelatoRelay.sponsoredCall(
        {
          chainId: this.#chainId,
          target: this.#address,
          data: await this._getExecTransactionData(to, data, value),
        },
        this.#apiKey
      );
    }
    const calls: Multicall2.CallStruct[] = [
      {
        target: GNOSIS_SAFE_PROXY_FACTORY,
        callData: await this._getCreateProxyData(),
      },
      {
        target: this.#address,
        callData: await this._getExecTransactionData(to, data, value),
      },
    ];
    const multiCallData = this.#multiCallInterface.encodeFunctionData(
      "aggregate",
      [calls]
    );
    return await this.#gelatoRelay.sponsoredCall(
      {
        chainId: this.#chainId,
        target: getMultiCallContractAddress(this.#chainId),
        data: multiCallData,
      },
      this.#apiKey
    );
  }

  private async _getExecTransactionData(
    to: string,
    data: string,
    value: BigNumberish
  ) {
    const signature = await this._getSignedTransactionHash(to, data, value);
    return this.#gnosisSafeInterface.encodeFunctionData("execTransaction", [
      to,
      value,
      data as BytesLike,
      0,
      0,
      0,
      0,
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      signature,
    ]);
  }

  private async _getSignedTransactionHash(
    to: string,
    data: string,
    value: BigNumberish
  ) {
    if (!this.isInitialized() || !this.#address || !this.#chainId) {
      throw new Error("GelatoSmartWallet is not initialized");
    }
    const nonce = (await this.isDeployed())
      ? (
          await GnosisSafe__factory.connect(
            this.#address,
            this.#provider
          ).nonce()
        ).toNumber()
      : 0;
    const transactionHash = await this._getTransactionHash(
      to,
      data,
      value,
      nonce
    );
    const signedMessage = await this.#provider
      .getSigner()
      .signMessage(ethers.utils.arrayify(transactionHash));
    return adjustVInSignature(signedMessage);
  }

  private async _getTransactionHash(
    to: string,
    data: string,
    value: BigNumberish,
    nonce: number
  ) {
    const safeTx = {
      to,
      value,
      data,
      operation: 0,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce,
    };
    return ethers.utils._TypedDataEncoder.hash(
      { verifyingContract: this.#address, chainId: this.#chainId },
      EIP712_SAFE_TX_TYPE,
      safeTx
    );
  }

  private async _getCreateProxyData(): Promise<string> {
    return this.#gnosisSafeProxyFactoryInterface.encodeFunctionData(
      "createProxyWithNonce",
      [GNOSIS_SAFE, await this._getSafeInitializer(), BigNumber.from(SALT)]
    );
  }

  private async _checkIfDeployed(): Promise<boolean> {
    if (!this.isInitialized() || !this.#address || !this.#chainId) {
      throw new Error("GelatoSmartWallet is not initialized");
    }
    try {
      await GnosisSafe__factory.connect(
        this.#address,
        this.#provider
      ).deployed();
      return true;
    } catch (error) {
      return false;
    }
  }

  private async _calculateSmartWalletAddress(): Promise<string> {
    const deploymentCode = ethers.utils.solidityPack(
      ["bytes", "uint256"],
      [
        await GnosisSafeProxyFactory__factory.connect(
          GNOSIS_SAFE_PROXY_FACTORY,
          this.#provider
        ).proxyCreationCode(),
        GNOSIS_SAFE,
      ]
    );
    const salt = ethers.utils.solidityKeccak256(
      ["bytes32", "uint256"],
      [
        ethers.utils.solidityKeccak256(
          ["bytes"],
          [await this._getSafeInitializer()]
        ),
        SALT,
      ]
    );
    return ethers.utils.getCreate2Address(
      GNOSIS_SAFE_PROXY_FACTORY,
      salt,
      ethers.utils.keccak256(deploymentCode)
    );
  }

  private async _getSafeInitializer(): Promise<string> {
    const owner = await this.#provider.getSigner().getAddress();
    return this.#gnosisSafeInterface.encodeFunctionData("setup", [
      [owner],
      BigNumber.from(1),
      ZERO_ADDRESS,
      "0x",
      FALLBACK_HANDLER_ADDRESS,
      ZERO_ADDRESS,
      BigNumber.from(0),
      ZERO_ADDRESS,
    ]);
  }
}
