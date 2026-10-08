import { createHmac } from 'node:crypto';
import { Addresses, Uint } from '@shared/constants';
import { FailedToGenerateQuoteError } from '@services/quotes/errors';
import { TimeoutError } from '@shared/timeouts';
import { jsonResponse, okxFixture, OKX_CONFIG } from './fixtures/okx';
import swap from './fixtures/okx-swap.json';
import approval from './fixtures/okx-approval.json';
import deprecation from './fixtures/okx-deprecation.json';

describe('OKX V6 offline quote source', () => {
  it('maps a successful swap and builds its exact transaction without another request', async () => {
    const { source, params, fetch } = okxFixture();
    const quote = await source.quote(params);
    expect(quote).toEqual({
      type: 'sell',
      sellAmount: 900719925474099312345n,
      maxSellAmount: 900719925474099312345n,
      buyAmount: 900719925474099312345n,
      minBuyAmount: 896216325846728815783n,
      estimatedGas: 210000n,
      allowanceTarget: '0x0000000000000000000000000000000000000006',
      customData: { tx: { to: '0x0000000000000000000000000000000000000005', calldata: '0x12345678', value: 0n } },
    });
    expect(
      await source.buildTx({
        ...params,
        request: {
          ...params.request,
          ...quote,
          accounts: { takeFrom: params.request.accounts.takeFrom, recipient: '0x0000000000000000000000000000000000000004' },
        },
      })
    ).toEqual(quote.customData.tx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, '0'],
    [0.03, '0.03'],
    [0.5, '0.5'],
    [1, '1'],
    [100, '100'],
    [0.0000001, '0.0000001'],
    [0.0000001234567890123456, '0.0000001234567890123456'],
  ])('sends %s percent unchanged, exact integer amounts and a distinct recipient', async (slippage, expectedSlippage) => {
    const { source, params, fetch } = okxFixture();
    await source.quote({ ...params, request: { ...params.request, config: { ...params.request.config, slippagePercentage: slippage } } });
    const urls = fetch.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.pathname).sort()).toEqual(['/api/v6/dex/aggregator/approve-transaction', '/api/v6/dex/aggregator/swap']);
    const swapUrl = urls.find((url) => url.pathname.endsWith('/swap'));
    expect(Object.fromEntries(swapUrl?.searchParams ?? [])).toEqual({
      chainIndex: '1',
      amount: '900719925474099312345',
      fromTokenAddress: params.request.sellToken,
      toTokenAddress: params.request.buyToken,
      slippagePercent: expectedSlippage,
      userWalletAddress: '0x0000000000000000000000000000000000000003',
      swapReceiverAddress: '0x0000000000000000000000000000000000000004',
    });
    const approvalUrl = urls.find((url) => url.pathname.endsWith('/approve-transaction'));
    expect(Object.fromEntries(approvalUrl?.searchParams ?? [])).toEqual({
      chainIndex: '1',
      tokenContractAddress: params.request.sellToken,
      approveAmount: Uint.MAX_256.toString(),
    });
  });

  it('leaves an omitted recipient to the documented taker default', async () => {
    const { source, params, fetch } = okxFixture();
    await source.quote({ ...params, request: { ...params.request, accounts: { takeFrom: params.request.accounts.takeFrom } } });
    const url = new URL(String(fetch.mock.calls.find(([input]) => String(input).includes('/swap?'))?.[0]));
    expect(url.searchParams.has('swapReceiverAddress')).toBe(false);
    expect(url.searchParams.get('userWalletAddress')).toBe(params.request.accounts.takeFrom);
  });

  it('signs the exact V6 path and query sent on both requests with the matching ISO timestamp', async () => {
    const { source, params, fetch } = okxFixture();
    await source.quote(params);
    fetch.mock.calls.forEach(([input, init]) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const timestamp = headers.get('OK-ACCESS-TIMESTAMP');
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(headers.get('OK-ACCESS-KEY')).toBe('key');
      expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe('pwd');
      expect(headers.get('OK-ACCESS-SIGN')).toBe(
        createHmac('sha256', 'sec').update(`${timestamp}GET${url.pathname}${url.search}`).digest('base64')
      );
      expect(init?.timeout).toBe('5s');
    });
  });

  it('skips approval for a native sell and preserves the exact native transaction value', async () => {
    const { source, params, fetch } = okxFixture(() =>
      jsonResponse({ ...swap, data: [{ ...swap.data[0], tx: { ...swap.data[0].tx, value: '900719925474099312345' } }] })
    );
    const quote = await source.quote({ ...params, request: { ...params.request, sellToken: Addresses.NATIVE_TOKEN } });
    expect(quote.allowanceTarget).toBe(Addresses.ZERO_ADDRESS);
    expect(quote.customData.tx.value).toBe(900719925474099312345n);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/api/v6/dex/aggregator/swap?');
  });

  it.each([undefined, null])('preserves the zero default for transaction value %s', async (value) => {
    const { source, params } = okxFixture((url) =>
      jsonResponse(url.pathname.endsWith('/swap') ? { ...swap, data: [{ ...swap.data[0], tx: { ...swap.data[0].tx, value } }] } : approval)
    );
    expect((await source.quote(params)).customData.tx.value).toBe(0n);
  });

  const invalidEnvelopes = (success: { code: string; data: unknown[] }) =>
    [
      ['V5 deprecation', deprecation],
      ['nonzero application code with usable data', { ...success, code: '51000' }],
      ['missing code', { data: success.data }],
      ['numeric code', { ...success, code: 0 }],
      ['empty data', { ...success, data: [] }],
      ['missing data', { code: '0' }],
      ['object data', { ...success, data: {} }],
      ['null body', null],
      ['null entry', { ...success, data: [null] }],
    ] as const;

  it.each(invalidEnvelopes(swap))('isolates %s on the swap response as a source failure', async (_, body) => {
    const { source, params } = okxFixture((url) => jsonResponse(url.pathname.endsWith('/swap') ? body : approval));
    await expect(source.quote(params)).rejects.toBeInstanceOf(FailedToGenerateQuoteError);
  });

  it.each(invalidEnvelopes(approval))('isolates %s on the approval response as a source failure', async (_, body) => {
    const { source, params } = okxFixture((url) => jsonResponse(url.pathname.endsWith('/swap') ? swap : body));
    await expect(source.quote(params)).rejects.toBeInstanceOf(FailedToGenerateQuoteError);
  });

  it.each([
    ['missing router result', { tx: swap.data[0].tx }],
    ['missing transaction', { routerResult: swap.data[0].routerResult }],
    ['missing destination', { ...swap.data[0], tx: { ...swap.data[0].tx, to: undefined } }],
    ['empty calldata', { ...swap.data[0], tx: { ...swap.data[0].tx, data: '' } }],
    ['missing calldata', { ...swap.data[0], tx: { ...swap.data[0].tx, data: undefined } }],
    ['invalid destination', { ...swap.data[0], tx: { ...swap.data[0].tx, to: 'not-an-address' } }],
    ['invalid calldata', { ...swap.data[0], tx: { ...swap.data[0].tx, data: '0xzz' } }],
    ['odd-length calldata', { ...swap.data[0], tx: { ...swap.data[0].tx, data: '0x123' } }],
    ['missing gas', { ...swap.data[0], tx: { ...swap.data[0].tx, gas: undefined } }],
    ['fractional gas', { ...swap.data[0], tx: { ...swap.data[0].tx, gas: '21000.5' } }],
    ['negative value', { ...swap.data[0], tx: { ...swap.data[0].tx, value: '-1' } }],
    ['missing minimum amount', { ...swap.data[0], tx: { ...swap.data[0].tx, minReceiveAmount: undefined } }],
    ['malformed buy amount', { ...swap.data[0], routerResult: { toTokenAmount: 'NaN' } }],
    ['numeric buy amount', { ...swap.data[0], routerResult: { toTokenAmount: 9007199254740993 } }],
  ])('rejects %s before returning a quote', async (_, entry) => {
    const { source, params } = okxFixture((url) => jsonResponse(url.pathname.endsWith('/swap') ? { ...swap, data: [entry] } : approval));
    await expect(source.quote(params)).rejects.toBeInstanceOf(FailedToGenerateQuoteError);
  });

  it.each([undefined, '', 'bad-address', 123])('rejects invalid approval target %s', async (dexContractAddress) => {
    const { source, params } = okxFixture((url) =>
      jsonResponse(url.pathname.endsWith('/swap') ? swap : { ...approval, data: [{ dexContractAddress }] })
    );
    await expect(source.quote(params)).rejects.toBeInstanceOf(FailedToGenerateQuoteError);
  });

  it.each(['swap', 'approve-transaction'])('removes credentials and request details from every %s error path', async (endpoint) => {
    for (const mode of ['http', 'application', 'malformed', 'transport', 'aggregate', 'timeout', 'aggregate-timeout', 'non-error', 'json']) {
      const signatures: string[] = [];
      const urls: string[] = [];
      const { source, params } = okxFixture((url, init) => {
        if (!url.pathname.endsWith(`/${endpoint}`)) return jsonResponse(endpoint === 'swap' ? approval : swap);
        const signature = new Headers(init?.headers).get('OK-ACCESS-SIGN') ?? '';
        signatures.push(signature);
        urls.push(url.href);
        const leak = JSON.stringify({ ...OKX_CONFIG, signature, url: url.href, headers: Object.fromEntries(new Headers(init?.headers)) });
        if (mode === 'transport') throw new Error(leak);
        if (mode === 'aggregate') throw Object.assign(new AggregateError([new Error(leak)], leak), { cause: new Error(leak) });
        if (mode === 'timeout') throw new TimeoutError(leak, '5s');
        if (mode === 'aggregate-timeout') throw new AggregateError([new TimeoutError(leak, '5s')], leak);
        if (mode === 'non-error') throw leak;
        if (mode === 'json') return new Response(`invalid JSON ${leak}`);
        if (mode === 'http') return new Response(leak, { status: 401 });
        if (mode === 'application') return jsonResponse({ code: '50050', msg: leak, data: [] });
        return jsonResponse({ code: '0', msg: leak, data: [{ routerResult: { toTokenAmount: leak } }] });
      });
      const error: unknown = await source.quote(params).catch((failure: unknown) => failure);
      if (mode === 'timeout') {
        expect(error).toBeInstanceOf(TimeoutError);
        expect(String(error)).toBe('Error: OKX request timeouted at 5s');
      } else if (['transport', 'aggregate', 'aggregate-timeout', 'non-error'].includes(mode)) {
        expect(error).toBeInstanceOf(AggregateError);
        if (error instanceof AggregateError) expect(error.errors).toEqual([]);
      } else {
        expect(error).toBeInstanceOf(FailedToGenerateQuoteError);
      }
      expect(error).not.toHaveProperty('cause');
      const text = String(error);
      [...Object.values(OKX_CONFIG), ...signatures, ...urls, 'web3.okx.com', 'OK-ACCESS', 'chainIndex=', 'tokenContractAddress='].forEach(
        (sensitive) => expect(text).not.toContain(sensitive)
      );
    }
  });

  it('uses FetchService’s default timeout when a direct timeout has no configured duration', async () => {
    const { source, params } = okxFixture(() => {
      throw new TimeoutError('sensitive URL', '5m');
    });
    await expect(
      source.quote({ ...params, request: { ...params.request, config: { ...params.request.config, timeout: undefined } } })
    ).rejects.toThrow(new TimeoutError('OKX request', '5m'));
  });
});
