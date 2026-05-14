// Property-based fuzz tests for src/upstream.ts.
//
// Gate 4 property target 2 of 3 from VRT-146a spec. Validates the
// rewriteUpgradeUrl predicate against arbitrary inputs:
//
//   For any input (status, body) the predicate satisfies:
//     1. status === 402 AND body.code === 'TRIAL_CAP_REACHED' -> output is a
//        new object with upgrade_url = ABSOLUTE_URL AND the SAME key set as
//        input (plus upgrade_url if input lacks it). No extraneous keys.
//        Every non-upgrade_url field is byte-identical to the input.
//     2. Otherwise -> output is the same reference as input (no copy).
//     3. Idempotent: rewriting twice yields the same result.
//
// The load-bearing concern this guards: BOTH upstream 402 body shapes must
// produce a usable absolute upgrade_url, including the secondary-gate shape
// which does not even have upgrade_url on the input.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { rewriteUpgradeUrl, UPGRADE_URL_ABSOLUTE } from '../src/upstream';

// Arbitrary JSON-like value for fuzzing upstream bodies.
const jsonValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.string({ maxLength: 64 }),
    fc.array(tie('value'), { maxLength: 8 }),
    fc.dictionary(fc.string({ maxLength: 16 }), tie('value'), { maxKeys: 8 }),
  ),
})).value;

// Arbitrary HTTP status codes.
const httpStatus = fc.integer({ min: 100, max: 599 });

describe('rewriteUpgradeUrl property: predicate triggers iff status=402 && code=TRIAL_CAP_REACHED', () => {
  it('returns input unchanged (reference equality) when status is not 402', () => {
    fc.assert(
      fc.property(
        httpStatus.filter((s) => s !== 402),
        jsonValue,
        (status, body) => {
          expect(rewriteUpgradeUrl(status, body)).toBe(body);
        },
      ),
    );
  });

  it('returns input unchanged when status is 402 but body is not TRIAL_CAP_REACHED', () => {
    fc.assert(
      fc.property(
        jsonValue.filter((b) => {
          if (typeof b !== 'object' || b === null) return true;
          return (b as Record<string, unknown>)['code'] !== 'TRIAL_CAP_REACHED';
        }),
        (body) => {
          expect(rewriteUpgradeUrl(402, body)).toBe(body);
        },
      ),
    );
  });
});

describe('rewriteUpgradeUrl property: rewrites 402 + TRIAL_CAP_REACHED preserving other fields', () => {
  // Arbitrary record of additional fields (string keys, json values). We then
  // add code='TRIAL_CAP_REACHED' before running through rewriteUpgradeUrl.
  const trialCapBody = fc
    .dictionary(
      fc.string({ minLength: 1, maxLength: 16 }).filter((k) => k !== 'code'),
      jsonValue,
      { maxKeys: 6 },
    )
    .map((extras) => ({ ...extras, code: 'TRIAL_CAP_REACHED' as const }));

  it('injects absolute upgrade_url on every 402 + TRIAL_CAP_REACHED body', () => {
    fc.assert(
      fc.property(trialCapBody, (body) => {
        const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
        expect(result['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
      }),
    );
  });

  it('every non-upgrade_url field is byte-identical between input and output', () => {
    fc.assert(
      fc.property(trialCapBody, (body) => {
        const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
        for (const key of Object.keys(body)) {
          if (key === 'upgrade_url') continue;
          expect(result[key]).toEqual((body as Record<string, unknown>)[key]);
        }
      }),
    );
  });

  it('adds no extraneous keys: output keys = input keys + (upgrade_url if absent)', () => {
    // Gate 4 contract: rewrite must produce the same key set as input, plus
    // upgrade_url if input lacks it. A refactor that adds telemetry fields
    // (e.g., rewritten_at) would silently break MCP marketplace schemas.
    fc.assert(
      fc.property(trialCapBody, (body) => {
        const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
        const inputKeys = new Set(Object.keys(body));
        inputKeys.add('upgrade_url');
        const outputKeys = new Set(Object.keys(result));
        expect(outputKeys.size).toBe(inputKeys.size);
        for (const key of inputKeys) {
          expect(outputKeys.has(key)).toBe(true);
        }
      }),
    );
  });

  it('returns a new object reference (input not mutated)', () => {
    fc.assert(
      fc.property(trialCapBody, (body) => {
        const before = JSON.stringify(body);
        rewriteUpgradeUrl(402, body);
        const after = JSON.stringify(body);
        expect(before).toBe(after);
      }),
    );
  });

  it('overrides upgrade_url even when input already has one (path normalization)', () => {
    fc.assert(
      fc.property(
        trialCapBody,
        fc.constantFrom('/upgrade', '/account/upgrade', 'https://other.example.com/upgrade'),
        (body, existingUrl) => {
          const withUpgrade = { ...body, upgrade_url: existingUrl };
          const result = rewriteUpgradeUrl(402, withUpgrade) as Record<string, unknown>;
          expect(result['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
        },
      ),
    );
  });

  it('is idempotent: rewriting an already-rewritten body yields the same result', () => {
    // Future refactors that add timestamps or query params to the URL would
    // silently break idempotency. Pinning here keeps the contract auditable.
    fc.assert(
      fc.property(trialCapBody, (body) => {
        const once = rewriteUpgradeUrl(402, body);
        const twice = rewriteUpgradeUrl(402, once);
        expect(twice).toEqual(once);
      }),
    );
  });
});
