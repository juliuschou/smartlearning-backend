import checkNames from '../tools/openapi/check-names.cjs';

const { findViolations } = checkNames;

describe('OpenAPI glossary name check', () => {
  const rules = [
    { avoid: '場次', preferred: '教學活動' },
    { avoid: 'Teaching Session', preferred: 'Teaching Activity' },
    { avoid: 'Activity Session', preferred: 'Teaching Activity' },
    { avoid: 'Instructor', preferred: 'Teacher', allow: ['Instructor-Led'] },
  ];

  it('accepts an empty paths object', () => {
    expect(findViolations({ paths: {} }, rules)).toEqual([]);
  });

  it('reports the JSON location and preferred term for a disallowed route', () => {
    const violations = findViolations(
      {
        paths: {
          '/場次': {
            get: { operationId: 'getTeachingSession' },
          },
        },
      },
      rules,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: 'paths./場次',
          avoid: '場次',
          preferred: '教學活動',
        }),
        expect.objectContaining({
          location: 'paths./場次.get.operationId',
          avoid: 'Teaching Session',
          preferred: 'Teaching Activity',
        }),
      ]),
    );
  });

  it('does not flag a plural form that is not the avoided phrase', () => {
    expect(
      findViolations(
        {
          paths: {
            '/activity-sessions': {
              get: { operationId: 'getActivitySessions' },
            },
          },
        },
        rules,
      ),
    ).toEqual([]);
  });

  it('honors the glossary exception for Instructor-Led', () => {
    expect(
      findViolations(
        {
          paths: {
            '/instructor-led': {
              get: { operationId: 'getInstructorLedMode' },
            },
          },
        },
        rules,
      ),
    ).toEqual([]);
  });

  it('checks parameters and schema properties', () => {
    const violations = findViolations(
      {
        paths: {
          '/activities': {
            get: { parameters: [{ name: '場次Id' }] },
          },
        },
        components: {
          schemas: {
            Activity: {
              properties: {
                場次名稱: { type: 'string' },
                details: {
                  type: 'object',
                  properties: { 場次說明: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      rules,
    );

    expect(violations.map(({ location }) => location)).toEqual([
      'paths./activities.get.parameters[0].name',
      'components.schemas.Activity.properties.場次名稱',
      'components.schemas.Activity.properties.details.properties.場次說明',
    ]);
  });
});
