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
