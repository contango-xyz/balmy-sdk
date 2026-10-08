import Ajv, { JSONSchemaType } from 'ajv';

type OKXEnvelope<T> = { code: string; data: T[] };
type OKXSwap = {
  routerResult: { toTokenAmount: string };
  tx: { minReceiveAmount: string; to: string; data: string; gas: string; value?: string | null };
};
type OKXApproval = { dexContractAddress: string };

const uintString = { type: 'string', pattern: '^[0-9]+$' } as const;
const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } as const;
const envelope = {
  type: 'object',
  properties: { code: { type: 'string', const: '0' } },
  required: ['code', 'data'],
} as const;

const swapSchema: JSONSchemaType<OKXEnvelope<OKXSwap>> = {
  ...envelope,
  properties: {
    ...envelope.properties,
    data: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          routerResult: {
            type: 'object',
            properties: { toTokenAmount: uintString },
            required: ['toTokenAmount'],
          },
          tx: {
            type: 'object',
            properties: {
              minReceiveAmount: uintString,
              to: address,
              data: { type: 'string', pattern: '^0x([0-9a-fA-F]{2})+$' },
              gas: uintString,
              value: { ...uintString, nullable: true },
            },
            required: ['minReceiveAmount', 'to', 'data', 'gas'],
          },
        },
        required: ['routerResult', 'tx'],
      },
    },
  },
};

const approvalSchema: JSONSchemaType<OKXEnvelope<OKXApproval>> = {
  ...envelope,
  properties: {
    ...envelope.properties,
    data: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { dexContractAddress: address },
        required: ['dexContractAddress'],
      },
    },
  },
};

const ajv = new Ajv();
export const isOKXSwapResponse = ajv.compile(swapSchema);
export const isOKXApprovalResponse = ajv.compile(approvalSchema);
