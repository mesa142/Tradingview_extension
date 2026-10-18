/**
 * tests/test_all.js — Master Comprehensive Test Runner
 * Executes all Phase 1, 2, 3, 4 & 5 test suites sequentially and outputs a unified report.
 */

'use strict';

const { execSync } = require('child_process');

console.log('==============================================================================');
console.log('   TRADINGVIEW ADVANCED MULTI-CONDITION ALERT EXTENSION — MASTER TEST RUNNER  ');
console.log('==============================================================================\n');

const suites = [
  { name: 'Phase 1: Local PC Service & SQLite Condition Engine', file: 'tests/test_phase1.js' },
  { name: 'Phase 2: MV3 Scraper, Discovered Series & Offscreen Audio', file: 'tests/test_phase2.js' },
  { name: 'Phase 3: Visual Nested Rule Builder & Extension Popup UI', file: 'tests/test_phase3.js' },
  { name: 'Phase 4 & 5: Intrabar Reversal Resilience & Multi-Channel Dispatch', file: 'tests/test_phase4.js' },
];

let totalPassed = 0;
let totalFailed = 0;
const startTime = Date.now();

for (const suite of suites) {
  console.log(`\n▶ Running ${suite.name}...`);
  try {
    const output = execSync(`node ${suite.file}`, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write(output);
    totalPassed++;
  } catch (err) {
    console.error(`❌ Suite failed: ${suite.name}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    totalFailed++;
  }
}

const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

console.log('\n==============================================================================');
console.log(`   MASTER TEST SUMMARY: ${totalPassed}/${suites.length} Suites Passed (${elapsedSec}s)`);
if (totalFailed === 0) {
  console.log('   ✓ ALL PRODUCTION SYSTEMS VERIFIED (ZERO OMISSIONS / ZERO REGRESSIONS)');
} else {
  console.log(`   ❌ ${totalFailed} SUITE(S) FAILED`);
}
console.log('==============================================================================\n');

if (totalFailed > 0) process.exit(1);
process.exit(0);
