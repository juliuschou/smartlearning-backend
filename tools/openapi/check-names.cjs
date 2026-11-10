const fs = require('node:fs');
const path = require('node:path');

function collectContractNames(document) {
  const entries = [];
  const add = (value, location) => {
    if (typeof value === 'string') entries.push({ value, location });
  };

  for (const [route, pathItem] of Object.entries(document.paths ?? {})) {
    add(route, `paths.${route}`);
    for (const [index, parameter] of (pathItem?.parameters ?? []).entries()) {
      add(parameter?.name, `paths.${route}.parameters[${index}].name`);
    }
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!operation || typeof operation !== 'object') continue;
      const base = `paths.${route}.${method}`;
      add(operation.operationId, `${base}.operationId`);
      for (const [index, tag] of (operation.tags ?? []).entries()) {
        add(tag, `${base}.tags[${index}]`);
      }
      for (const [index, parameter] of (operation.parameters ?? []).entries()) {
        add(parameter?.name, `${base}.parameters[${index}].name`);
      }
    }
  }

  const visitSchema = (schema, location) => {
    if (!schema || typeof schema !== 'object') return;
    for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
      const propertyLocation = `${location}.properties.${propertyName}`;
      add(propertyName, propertyLocation);
      visitSchema(propertySchema, propertyLocation);
    }
    if (schema.items) visitSchema(schema.items, `${location}.items`);
    for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
      for (const [index, nestedSchema] of (schema[keyword] ?? []).entries()) {
        visitSchema(nestedSchema, `${location}.${keyword}[${index}]`);
      }
    }
  };

  const schemas = document.components?.schemas ?? {};
  for (const [schemaName, schema] of Object.entries(schemas)) {
    const location = `components.schemas.${schemaName}`;
    add(schemaName, location);
    visitSchema(schema, location);
  }
  return entries;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createMatcher(term) {
  if (/^[a-z][a-z0-9 _-]*$/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term).replace(/[ _-]+/g, '[_ -]*')}($|[^a-z0-9])`, 'i');
  }
  return new RegExp(escapeRegExp(term));
}

function findViolations(document, rules) {
  if (!document || typeof document !== 'object' || !document.paths || typeof document.paths !== 'object') {
    throw new Error('OpenAPI document must contain a paths object.');
  }
  if (!Array.isArray(rules)) throw new Error('Glossary rules must be an array.');

  const names = collectContractNames(document);
  const violations = [];
  for (const rule of rules) {
    if (!rule || typeof rule.avoid !== 'string' || typeof rule.preferred !== 'string') {
      throw new Error('Each glossary rule must include avoid and preferred strings.');
    }
    const matcher = createMatcher(rule.avoid);
    const allowedMatchers = (rule.allow ?? []).map(createMatcher);
    for (const entry of names) {
      const searchableValue = entry.value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      if (allowedMatchers.some((allowedMatcher) => allowedMatcher.test(searchableValue))) {
        continue;
      }
      if (matcher.test(searchableValue)) {
        violations.push({ ...entry, avoid: rule.avoid, preferred: rule.preferred });
      }
    }
  }
  return violations;
}

function main() {
  const specPath = path.resolve(process.argv[2] ?? 'dist/openapi.json');
  const rulesPath = path.resolve(process.argv[3] ?? 'tools/openapi/glossary-rules.json');
  const document = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const glossary = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const violations = findViolations(document, glossary.rules);

  if (violations.length > 0) {
    for (const item of violations) {
      process.stderr.write(`${item.location}: "${item.value}" uses avoid term "${item.avoid}"; use "${item.preferred}".\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`OpenAPI names comply with ${glossary.rules.length} curated glossary rules.\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`OpenAPI name check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { collectContractNames, findViolations };
