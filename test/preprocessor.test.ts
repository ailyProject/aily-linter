import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSourceWithDefines } from '../src/utils/AnalyzeFile';

test('tracks nested conditional branches and active macros', () => {
  const defines = new Map();
  const result = analyzeSourceWithDefines(`
#define BOARD 2
#if BOARD == 2
  #include "active.h"
  #if 0
    #include "nested-inactive.h"
  #elif defined(BOARD)
    #define FEATURE 1
    #include FEATURE_HEADER
  #endif
#else
  #include "inactive.h"
#endif
`, new Map([
    ['FEATURE_HEADER', { name: 'FEATURE_HEADER', value: '"feature.h"', isDefined: true }]
  ]));

  assert.deepEqual(result.includes, ['active.h', 'feature.h']);
  assert.equal(result.defines.get('FEATURE')?.value, '1');
});

test('applies include callback macro changes at the include location', () => {
  const defines = new Map();
  const result = analyzeSourceWithDefines(`
#include "config.h"
#ifdef FROM_CONFIG
#include "selected.h"
#endif
`, defines, {
    onInclude(includePath) {
      if (includePath === 'config.h') {
        defines.set('FROM_CONFIG', { name: 'FROM_CONFIG', value: '1', isDefined: true });
      }
    }
  });

  assert.deepEqual(result.includes, ['config.h', 'selected.h']);
});

test('ignores commented directives and supports logical line continuation', () => {
  const result = analyzeSourceWithDefines(`
/* #include "comment.h" */
// #define WRONG 1
#define SUM(a, b) ((a) + (b))
#if SUM(1, \\
  2) == 3
#include "continued.h" // active
#endif
`, new Map());

  assert.deepEqual(result.includes, ['continued.h']);
  assert.equal(result.defines.has('WRONG'), false);
});