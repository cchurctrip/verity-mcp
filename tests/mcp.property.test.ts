// Property-based fuzz tests for src/mcp.ts validateEnvelope.
//
// Gate 4 property target 3 of 3 from VRT-146a spec. Validates the JSON-RPC 2.0
// envelope predicate against arbitrary inputs:
//
//   For any input body the validator satisfies:
//     1. Canonical envelopes ({ jsonrpc: '2.0', id, method, params? }, where
//        id is string | number | null and method is a string) classify as
//        'valid' AND echo the id and method unchanged.
//     2. Inputs that are not plain objects (string, number, boolean, null,
//        array) classify as 'invalid' with id = null.
//     3. Objects missing the jsonrpc field, with jsonrpc !== '2.0', missing
//        method, with a non-string method, missing id, or with a non
//        primitive id classify as 'invalid'.
//     4. When the invalid envelope still has a well-typed id (string, number,
//        null), the validator echoes that id back so the caller can return
//        a -32600 response carrying the original id (per JSON-RPC 2.0 § 5).
//     5. Idempotent classifier: same input twice yields equal results.
//
// The oracle is hand-written, not regex-derived from the production code.
// PR #2 lesson: a property test whose oracle re-implements the same regex
// as the function under test will pass tautologically. Here the oracle
// independently expresses the four field requirements as imperative checks.

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { validateEnvelope } from '../src/mcp';

// Hand-written oracle. Returns true iff the input is a well-formed JSON-RPC
// 2.0 envelope by the spec's definition: object, jsonrpc === '2.0', id is
// one of string | number | null, method is a string. Params is not
// constrained by the validator.
function isValidEnvelopeOracle(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  if (Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (b['jsonrpc'] !== '2.0') return false;
  if (!('id' in b)) return false;
  const idType = typeof b['id'];
  if (idType !== 'string' && idType !== 'number' && b['id'] !== null) return false;
  if (typeof b['method'] !== 'string') return false;
  return true;
}

// Arbitrary JSON-RPC id (the legal subset).
const validId: fc.Arbitrary<string | number | null> = fc.oneof(
  fc.string({ maxLength: 32 }),
  fc.integer(),
  fc.constant(null),
);

// Arbitrary canonical envelope. params can be anything JSON-encodable.
const canonicalEnvelope = fc.record({
  jsonrpc: fc.constant('2.0' as const),
  id: validId,
  method: fc.string({ minLength: 1, maxLength: 32 }),
  params: fc.option(
    fc.oneof(
      fc.dictionary(fc.string({ maxLength: 8 }), fc.anything(), { maxKeys: 4 }),
      fc.array(fc.anything(), { maxLength: 4 }),
    ),
    { nil: undefined },
  ),
});

// Arbitrary "anything that is NOT a plain non-array object". Used to fuzz the
// non-object rejection path.
const nonObjectBody = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.anything()),
);

describe('validateEnvelope property: canonical envelopes are accepted', () => {
  it('every canonical envelope classifies as valid and echoes id + method', () => {
    fc.assert(
      fc.property(canonicalEnvelope, (env) => {
        const r = validateEnvelope(env);
        if (r.kind !== 'valid') return false;
        if (r.envelope.id !== env.id) return false;
        if (r.envelope.method !== env.method) return false;
        if (r.envelope.jsonrpc !== '2.0') return false;
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

describe('validateEnvelope property: non-object bodies are rejected', () => {
  it('strings, numbers, booleans, null, and arrays return invalid with id = null', () => {
    fc.assert(
      fc.property(nonObjectBody, (body) => {
        const r = validateEnvelope(body);
        return r.kind === 'invalid' && r.id === null;
      }),
      { numRuns: 300 },
    );
  });
});

describe('validateEnvelope property: required fields enforced', () => {
  it('removing any required field flips classification to invalid', () => {
    fc.assert(
      fc.property(canonicalEnvelope, fc.constantFrom('jsonrpc', 'id', 'method'), (env, field) => {
        const mutated: Record<string, unknown> = { ...env };
        delete mutated[field];
        return validateEnvelope(mutated).kind === 'invalid';
      }),
      { numRuns: 300 },
    );
  });

  it('jsonrpc !== "2.0" is rejected regardless of value type', () => {
    fc.assert(
      fc.property(
        canonicalEnvelope,
        fc.oneof(
          fc.string().filter((s) => s !== '2.0'),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(2.0),
        ),
        (env, badJsonrpc) => {
          const mutated = { ...env, jsonrpc: badJsonrpc };
          return validateEnvelope(mutated).kind === 'invalid';
        },
      ),
      { numRuns: 300 },
    );
  });

  it('non-string method is rejected', () => {
    fc.assert(
      fc.property(
        canonicalEnvelope,
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.anything()), fc.dictionary(fc.string(), fc.anything())),
        (env, badMethod) => {
          const mutated = { ...env, method: badMethod };
          return validateEnvelope(mutated).kind === 'invalid';
        },
      ),
      { numRuns: 300 },
    );
  });

  it('non-primitive id is rejected', () => {
    fc.assert(
      fc.property(
        canonicalEnvelope,
        fc.oneof(fc.boolean(), fc.array(fc.anything()), fc.dictionary(fc.string(), fc.anything()), fc.constant(undefined)),
        (env, badId) => {
          const mutated = { ...env, id: badId };
          // undefined still satisfies 'in' check; but typeof undefined is 'undefined'
          // which is neither 'string' nor 'number' and value is not null, so it's invalid.
          return validateEnvelope(mutated).kind === 'invalid';
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('validateEnvelope property: invalid envelopes echo recoverable id', () => {
  it('when only jsonrpc is wrong but id is well-typed, invalid response carries the id back', () => {
    fc.assert(
      fc.property(canonicalEnvelope, fc.string().filter((s) => s !== '2.0'), (env, badJsonrpc) => {
        const mutated = { ...env, jsonrpc: badJsonrpc };
        const r = validateEnvelope(mutated);
        if (r.kind !== 'invalid') return false;
        return r.id === env.id;
      }),
      { numRuns: 300 },
    );
  });

  it('when the id is unparseable, the invalid response uses null', () => {
    fc.assert(
      fc.property(
        canonicalEnvelope,
        fc.oneof(fc.boolean(), fc.array(fc.anything()), fc.dictionary(fc.string(), fc.anything())),
        (env, badId) => {
          const mutated = { ...env, jsonrpc: 'wrong', id: badId };
          const r = validateEnvelope(mutated);
          if (r.kind !== 'invalid') return false;
          return r.id === null;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('validateEnvelope property: idempotence', () => {
  it('classifying the same input twice yields equal results', () => {
    const arbitraryBody = fc.oneof(canonicalEnvelope, nonObjectBody, fc.dictionary(fc.string(), fc.anything()));
    fc.assert(
      fc.property(arbitraryBody, (body) => {
        const a = validateEnvelope(body);
        const b = validateEnvelope(body);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 500 },
    );
  });
});

describe('validateEnvelope property: oracle agreement on broad fuzzing', () => {
  it('matches the hand-written oracle on arbitrary dictionaries', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.anything(), { maxKeys: 6 }), (body) => {
        const actual = validateEnvelope(body).kind === 'valid';
        const oracle = isValidEnvelopeOracle(body);
        return actual === oracle;
      }),
      { numRuns: 1000 },
    );
  });
});
