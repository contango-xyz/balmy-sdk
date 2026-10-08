import qs from 'qs';
import CryptoJS from 'crypto-js';
import { Chains } from '@chains';
import { IQuoteSource, QuoteParams, QuoteSourceMetadata, SourceQuoteResponse, SourceQuoteTransaction, BuildTxParams } from './types';
import { failed } from './utils';
import { IFetchService } from '@services/fetch';
import { Address, ChainId, TimeString } from '@types';
import { Addresses, Uint } from '@shared/constants';
import { isSameAddress } from '@shared/utils';
import { ValidateFunction } from 'ajv';
import { isOKXApprovalResponse, isOKXSwapResponse } from './okx-dex-response';

// Live chain support remains unverified; see docs/okx-v6-offline.md.
const SUPPORTED_CHAINS = [
  Chains.ETHEREUM,
  Chains.OPTIMISM,
  Chains.POLYGON,
  Chains.BNB_CHAIN,
  Chains.OKC,
  Chains.AVALANCHE,
  Chains.FANTOM,
  Chains.ARBITRUM,
  Chains.LINEA,
  Chains.BASE,
  Chains.SCROLL,
  Chains.BLAST,
  Chains.POLYGON_ZKEVM,
  Chains.FANTOM,
  Chains.MANTLE,
  Chains.METIS_ANDROMEDA,
  Chains.ZK_SYNC_ERA,
  Chains.SONIC,
];

const OKX_DEX_METADATA: QuoteSourceMetadata<OKXDexSupport> = {
  name: 'OKX Dex',
  supports: {
    chains: SUPPORTED_CHAINS.map(({ chainId }) => chainId),
    swapAndTransfer: true,
    buyOrders: false,
  },
  logoURI: 'ipfs://QmarS9mPPLegvNaazZ8Kqg1gLvkbsvQE2tkdF6uZCvBrFn',
};
type OKXDexConfig = { apiKey: string; secretKey: string; passphrase: string };
type OKXDexSupport = { buyOrders: false; swapAndTransfer: true };
type OKXDexData = { tx: SourceQuoteTransaction };
export class OKXDexQuoteSource implements IQuoteSource<OKXDexSupport, OKXDexConfig> {
  getMetadata() {
    return OKX_DEX_METADATA;
  }

  async quote({ components, request, config }: QuoteParams<OKXDexSupport, OKXDexConfig>): Promise<SourceQuoteResponse<OKXDexData>> {
    const [approvalTarget, quoteResponse] = await Promise.all([
      calculateApprovalTarget({ components, request, config }),
      calculateQuote({ components, request, config }),
    ]);
    const {
      data: [
        {
          routerResult: { toTokenAmount },
          tx: { minReceiveAmount, to, value, data, gas },
        },
      ],
    } = quoteResponse;
    return {
      sellAmount: request.order.sellAmount,
      maxSellAmount: request.order.sellAmount,
      buyAmount: BigInt(toTokenAmount),
      minBuyAmount: BigInt(minReceiveAmount),
      estimatedGas: BigInt(gas),
      allowanceTarget: approvalTarget,
      type: 'sell',
      customData: {
        tx: {
          calldata: data,
          to,
          value: BigInt(value ?? 0),
        },
      },
    };
  }

  async buildTx({ request }: BuildTxParams<OKXDexConfig, OKXDexData>): Promise<SourceQuoteTransaction> {
    return request.customData.tx;
  }

  isConfigAndContextValidForQuoting(config: Partial<OKXDexConfig> | undefined): config is OKXDexConfig {
    return !!config?.apiKey && !!config?.passphrase && !!config?.secretKey;
  }

  isConfigAndContextValidForTxBuilding(config: Partial<OKXDexConfig> | undefined): config is OKXDexConfig {
    return true;
  }
}

async function calculateApprovalTarget({
  components: { fetchService },
  request: {
    chainId,
    sellToken,
    buyToken,
    config: { timeout },
  },
  config,
}: QuoteParams<OKXDexSupport, OKXDexConfig>) {
  if (isSameAddress(sellToken, Addresses.NATIVE_TOKEN)) {
    return Addresses.ZERO_ADDRESS;
  }
  const queryParams = {
    chainIndex: chainId.toString(),
    tokenContractAddress: sellToken,
    approveAmount: Uint.MAX_256.toString(),
  };
  const queryString = qs.stringify(queryParams, { skipNulls: true, arrayFormat: 'comma' });
  const path = `/api/v6/dex/aggregator/approve-transaction?${queryString}`;
  const response = await fetch({
    sellToken,
    buyToken,
    chainId,
    path,
    timeout,
    config,
    fetchService,
    validate: isOKXApprovalResponse,
  });
  return response.data[0].dexContractAddress;
}

async function calculateQuote({
  components: { fetchService },
  request: {
    chainId,
    sellToken,
    buyToken,
    order,
    config: { slippagePercentage, timeout },
    accounts: { takeFrom, recipient },
  },
  config,
}: QuoteParams<OKXDexSupport, OKXDexConfig>) {
  const queryParams = {
    chainIndex: chainId.toString(),
    amount: order.sellAmount.toString(),
    fromTokenAddress: sellToken,
    toTokenAddress: buyToken,
    slippagePercent: slippagePercentage.toString(),
    userWalletAddress: takeFrom,
    swapReceiverAddress: recipient,
  };
  const queryString = qs.stringify(queryParams, { skipNulls: true, arrayFormat: 'comma' });
  const path = `/api/v6/dex/aggregator/swap?${queryString}`;
  return fetch({
    sellToken,
    buyToken,
    chainId,
    path,
    timeout,
    config,
    fetchService,
    validate: isOKXSwapResponse,
  });
}

async function fetch<T>({
  sellToken,
  buyToken,
  chainId,
  path,
  fetchService,
  config,
  timeout,
  validate,
}: {
  sellToken: Address;
  buyToken: Address;
  chainId: ChainId;
  path: string;
  timeout?: TimeString;
  config: OKXDexConfig;
  fetchService: IFetchService;
  validate: ValidateFunction<T>;
}) {
  const timestamp = new Date().toISOString();
  const toHash = timestamp + 'GET' + path;
  const signed = CryptoJS.HmacSHA256(toHash, config.secretKey);
  const base64 = signed.toString(CryptoJS.enc.Base64);

  const headers: HeadersInit = {
    ['OK-ACCESS-KEY']: config.apiKey,
    ['OK-ACCESS-PASSPHRASE']: config.passphrase,
    ['OK-ACCESS-TIMESTAMP']: timestamp,
    ['OK-ACCESS-SIGN']: base64,
  };

  const url = `https://web3.okx.com${path}`;
  const response = await fetchService
    .fetch(url, { timeout, headers })
    .catch(() => failed(OKX_DEX_METADATA, chainId, sellToken, buyToken, 'OKX request failed'));
  if (!response.ok) {
    failed(OKX_DEX_METADATA, chainId, sellToken, buyToken, 'OKX HTTP request failed');
  }
  const body: unknown = await response.json().catch(() => failed(OKX_DEX_METADATA, chainId, sellToken, buyToken, 'Invalid OKX JSON response'));
  if (!validate(body)) {
    failed(OKX_DEX_METADATA, chainId, sellToken, buyToken, 'Invalid OKX response');
  }
  return body;
}
