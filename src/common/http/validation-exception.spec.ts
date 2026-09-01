import type { ValidationError } from 'class-validator';
import {
  flattenValidationErrors,
  validationExceptionFactory,
} from './validation-exception';

describe('validation-exception', () => {
  const errors: ValidationError[] = [
    {
      property: 'z',
      constraints: { isString: 'must be a string' },
      children: [],
      target: {},
      value: 1,
    },
    {
      property: 'items',
      constraints: {},
      children: [
        {
          property: '0',
          constraints: { isNotEmpty: 'must not be empty' },
          children: [],
          target: {},
          value: '',
        },
      ],
      target: {},
      value: [],
    },
    {
      property: 'a',
      constraints: { isDefined: 'is required' },
      children: [],
      target: {},
      value: undefined,
    },
  ];

  it('flattens nested paths and sorts issues deterministically', () => {
    expect(flattenValidationErrors(errors)).toEqual([
      { field: 'a', message: 'a: is required' },
      { field: 'items[0]', message: 'items[0]: must not be empty' },
      { field: 'z', message: 'z: must be a string' },
    ]);
  });

  it('replaces constraint messages that echo the rejected value', () => {
    const sentinel = 'validation-secret-sentinel';
    const errors: ValidationError[] = [
      {
        property: 'displayName',
        constraints: {
          custom: `displayName contains ${sentinel}`,
        },
        children: [
          {
            property: 'nested',
            constraints: { custom: 'rejected value: $value' },
            children: [],
            target: { nested: sentinel },
            value: sentinel,
          },
        ],
        target: { displayName: sentinel },
        value: sentinel,
      },
    ];

    const flattened = flattenValidationErrors(errors);
    expect(JSON.stringify(flattened)).not.toContain(sentinel);
    expect(flattened).toEqual([
      { field: 'displayName', message: 'displayName: Invalid value.' },
      {
        field: 'displayName.nested',
        message: 'displayName.nested: Invalid value.',
      },
    ]);

    const exception = validationExceptionFactory(errors);
    expect(JSON.stringify(exception.getResponse())).not.toContain(sentinel);
  });

  it('creates a transport-safe BadRequestException', () => {
    const exception = validationExceptionFactory(errors);
    const response = exception.getResponse() as {
      message: string[];
      validationIssues: unknown;
    };

    expect(response.message).toEqual([
      'a: is required',
      'items[0]: must not be empty',
      'z: must be a string',
    ]);
    expect(response.validationIssues).toEqual([
      { field: 'a', message: 'a: is required' },
      { field: 'items[0]', message: 'items[0]: must not be empty' },
      { field: 'z', message: 'z: must be a string' },
    ]);
  });
});
