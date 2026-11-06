import { buildSDK } from '@builder';
import { IGasPriceSource } from '@services/gas/types';
import { IMetadataSource, BaseTokenMetadata } from '@services/metadata/types';
import { IPriceSource } from '@services/prices/types';
import { IProviderSource } from '@services/providers/types';
import { GasDataUnavailableError, IQuoteSourceList, QuoteRequest } from '@services/quotes';

const takerA = '0x0000000000000000000000000000000000000003';
const takerB = '0x0000000000000000000000000000000000000004';
const router = '0x0000000000000000000000000000000000000005';
const request: QuoteRequest = {
  chainId: 1,
  sellToken: '0x0000000000000000000000000000000000000001',
  buyToken: '0x0000000000000000000000000000000000000002',
  takerAddress: takerA,
  order: { type: 'sell', sellAmount: 1000n },
  slippagePercentage: 0.03,
  filters: { includeSources: ['paraswap', 'open-ocean'] },
};

function fixture(outcomes: ('fail' | 'ok')[], failParaswapFor?: string) {
  const failure = new Error('relay observation unavailable');
  const calls: URL[] = [];
  const sourceErrors: Record<string, Record<string, unknown>> = {};
  const gas = {
    supportedSpeeds: () => ({ 1: { standard: 'present' } }),
    getGasPrice: jest.fn(async () => {
      if (outcomes.shift() === 'fail') throw failure;
      return { standard: { maxFeePerGas: 2500000000n, maxPriorityFeePerGas: 100000000n } };
    }),
  } as unknown as IGasPriceSource<{ standard: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } }>;
  const metadata: IMetadataSource<BaseTokenMetadata> = {
    supportedProperties: () => ({ 1: { symbol: 'present', decimals: 'present' } }),
    getMetadata: async ({ tokens }) => ({ 1: Object.fromEntries(tokens.map(({ token }) => [token, { symbol: 'SYM', decimals: 18 }])) } as any),
  };
  const prices: IPriceSource = {
    supportedQueries: () => ({ 1: { getCurrentPrices: true, getHistoricalPrices: false, getChart: false } }),
    getCurrentPrices: async () => ({}),
    getHistoricalPrices: async () => ({}),
    getChart: async () => ({}),
  };
  const provider: IProviderSource = {
    supportedChains: () => [1],
    getViemTransport: () => {
      throw new Error('Unexpected RPC');
    },
  };
  const fetch: typeof global.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'api.paraswap.io') {
      if (url.searchParams.get('userAddress') === failParaswapFor) return new Response('venue down', { status: 503 });
      return Response.json({
        priceRoute: { srcAmount: '1000', destAmount: '1234', gasCost: '21000', tokenTransferProxy: router },
        txParams: { to: router, data: '0x1234', value: '0' },
      });
    }
    if (url.hostname === 'open-api.openocean.finance') {
      return Response.json({ data: { outAmount: '1250', minOutAmount: '1200', estimatedGas: '22000', to: router, data: '0xabcd', value: '0' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const sdk = buildSDK({
    fetch: { fetch },
    provider: { source: { type: 'custom', instance: provider } },
    gas: { source: { type: 'custom', instance: gas } },
    metadata: { source: { type: 'custom', instance: metadata } },
    price: { source: { type: 'custom', instance: prices } },
    quotes: {
      allowMissingOptionalGas: true,
      sourceList: {
        type: 'custom-with-underlying',
        underlyingSource: { type: 'local' },
        build: (underlying: IQuoteSourceList): IQuoteSourceList => ({
          ...underlying,
          supportedSources: () => underlying.supportedSources(),
          buildTxs: (args) => underlying.buildTxs(args),
          getQuotes: (args) => {
            const errors: Record<string, unknown> = (sourceErrors[args.takerAddress] = {});
            return Object.fromEntries(
              Object.entries(underlying.getQuotes(args)).map(([id, promise]) => [
                id,
                promise.catch((error) => {
                  errors[id] = error;
                  throw error;
                }),
              ])
            );
          },
        }),
      },
    },
  });
  const get = (takerAddress = takerA) =>
    sdk.quoteService.getAllQuotesWithTxs({ request: { ...request, takerAddress }, config: { ignoredFailed: false } });
  return { get, calls, sourceErrors, gas, failure };
}

describe('SDK optional gas compatibility', () => {
  it('returns the independent transaction and attributes the gas failure to OpenOcean', async () => {
    const f = fixture(['fail']);
    const results = await f.get();
    expect(results).toHaveLength(2);
    const [quote, failed] = results;
    expect(quote).toMatchObject({
      source: { id: 'paraswap' },
      gas: undefined,
      tx: { to: router, data: '0x1234' },
      buyAmount: { amount: 1234n },
    });
    expect(failed).toMatchObject({ failed: true, source: { id: 'open-ocean' }, error: 'Failed to fetch gas data' });
    expect(f.sourceErrors[takerA]['open-ocean']).toBeInstanceOf(GasDataUnavailableError);
    expect((f.sourceErrors[takerA]['open-ocean'] as GasDataUnavailableError).cause).toBe(f.failure);
    expect(f.gas.getGasPrice).toHaveBeenCalledTimes(1);
    expect(f.calls.map((url) => url.hostname)).toEqual(['api.paraswap.io']);
  });

  it('isolates overlapping failures and a later healthy request', async () => {
    const f = fixture(['fail', 'ok', 'ok'], takerB);
    const [a, b] = await Promise.all([f.get(takerA), f.get(takerB)]);
    expect(a.filter((result) => 'failed' in result).map((result) => result.source.id)).toEqual(['open-ocean']);
    expect(b.filter((result) => 'failed' in result).map((result) => result.source.id)).toEqual(['paraswap']);
    expect(f.sourceErrors[takerA]['open-ocean']).toBeInstanceOf(GasDataUnavailableError);
    expect(f.sourceErrors[takerB]['paraswap']).not.toBeInstanceOf(GasDataUnavailableError);
    expect(Object.keys(f.sourceErrors[takerB])).toEqual(['paraswap']);
    const later = await f.get();
    expect(later.every((result) => !('failed' in result))).toBe(true);
    expect(Object.keys(f.sourceErrors[takerA])).toEqual([]);
    expect(f.gas.getGasPrice).toHaveBeenCalledTimes(3);
    const oceanCalls = f.calls.filter((url) => url.hostname === 'open-api.openocean.finance');
    expect(oceanCalls).toHaveLength(2);
    expect(oceanCalls.every((url) => url.searchParams.get('gasPrice') === '2.5')).toBe(true);
    expect(f.calls.every((url) => ['api.paraswap.io', 'open-api.openocean.finance'].includes(url.hostname))).toBe(true);
  });
});
