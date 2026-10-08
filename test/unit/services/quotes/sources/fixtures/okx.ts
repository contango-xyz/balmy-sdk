import { OKXDexQuoteSource } from '@services/quotes/quote-sources/okx-dex-quote-source';
import { IFetchService } from '@services/fetch';
import swap from './okx-swap.json';
import approval from './okx-approval.json';

export const OKX_CONFIG = { apiKey: 'key', secretKey: 'sec', passphrase: 'pwd' };

type Params = Parameters<OKXDexQuoteSource['quote']>[0];
type Respond = (url: URL, init?: Parameters<IFetchService['fetch']>[1]) => Response | Promise<Response>;

export function okxFixture(respond: Respond = (url) => jsonResponse(url.pathname.endsWith('/swap') ? swap : approval)) {
  const fetch = jest.fn<ReturnType<IFetchService['fetch']>, Parameters<IFetchService['fetch']>>(async (input, init) =>
    respond(new URL(String(input)), init)
  );
  const params: Params = {
    components: {
      fetchService: { fetch },
      providerService: {
        supportedChains: () => [1],
        getViemPublicClient: () => {
          throw new Error('Offline OKX fixtures must not call a provider');
        },
        getViemTransport: () => {
          throw new Error('Offline OKX fixtures must not call a provider');
        },
      },
    },
    config: OKX_CONFIG,
    request: {
      chainId: 1,
      sellToken: '0x0000000000000000000000000000000000000001',
      buyToken: '0x0000000000000000000000000000000000000002',
      order: { type: 'sell', sellAmount: 900719925474099312345n },
      config: { slippagePercentage: 0.5, timeout: '5s' },
      accounts: {
        takeFrom: '0x0000000000000000000000000000000000000003',
        recipient: '0x0000000000000000000000000000000000000004',
      },
      external: {
        tokenData: {
          request: () => {
            throw new Error('Offline OKX fixtures must not fetch token metadata');
          },
        },
        gasPrice: {
          request: () => {
            throw new Error('Offline OKX fixtures must not fetch gas prices');
          },
        },
      },
    },
  };
  return { source: new OKXDexQuoteSource(), params, fetch };
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
