#!/usr/bin/env node
// Ordex Conformance CLI
// Deterministic conformance runner sharing exact execution engine with Conformance Studio.
// Exit codes:
// 0: All selected tests passed
// 1: One or more conformance tests failed, or the selection had no vectors
// 2: Configuration or invocation error

import { FAMILIES, runConformanceSuite } from '../../site/src/lib/conformance-engine.mjs';
import { loadAllFamilies, assertNoUnregisteredVectorFiles } from './vector-loader.mjs';

// Parse CLI flags
const args = process.argv.slice(2);
let selectedFamily = null;
let jsonOutput = false;
let markdownOutput = false;
let junitOutput = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--family' && args[i + 1]) {
    selectedFamily = args[++i];
    if (!FAMILIES.includes(selectedFamily)) {
      console.error(`Error: Unknown family "${selectedFamily}". Supported families: ${FAMILIES.join(', ')}`);
      process.exit(2);
    }
  } else if (args[i] === '--json') {
    jsonOutput = true;
  } else if (args[i] === '--markdown') {
    markdownOutput = true;
  } else if (args[i] === '--junit') {
    junitOutput = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Ordex Conformance CLI Runner

Usage:
  node scripts/docs/conformance-cli.mjs [options]

Options:
  --family <name>    Run only a specific verifier family (${FAMILIES.join(', ')})
  --json             Output raw JSON report
  --markdown         Output Markdown self-test report
  --junit            Output JUnit XML report
  --help, -h         Show help

Exit codes:
  0: All selected conformance checks passed
  1: One or more checks failed, or the selection had no vectors
  2: Configuration or usage error
`);
    process.exit(0);
  }
}

// OX-S07: vectors load through the same Node loader the generator and tests use, and every
// file in conformance/ must belong to a registered family.
let familiesData;
try {
  assertNoUnregisteredVectorFiles();
  familiesData = loadAllFamilies();
} catch (err) {
  console.error('Error loading conformance vectors:', err.message);
  process.exit(2);
}

// Execute
const selectedFamilies = selectedFamily ? [selectedFamily] : FAMILIES;
const suiteResult = runConformanceSuite(familiesData, selectedFamilies);

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

if (jsonOutput) {
  console.log(JSON.stringify(suiteResult, null, 2));
} else if (markdownOutput) {
  console.log(`
# Ordex Self-Test Conformance Report
- **Timestamp:** ${suiteResult.summary.timestamp}
- **Total Cases:** ${suiteResult.summary.total}
- **Passed:** ${suiteResult.summary.passed}
- **Failed:** ${suiteResult.summary.failed}
- **Duration:** ${suiteResult.summary.durationMs.toFixed(2)}ms
- **Verdict:** ${suiteResult.summary.success ? 'PASS' : 'FAIL'}

| Family | Variant | Vector Case | Result | Outcome |
| :--- | :--- | :--- | :--- | :--- |
${suiteResult.results.map(r => `| \`${r.family}\` | ${r.variant} | ${r.name} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.outcome} |`).join('\n')}
`);
} else if (junitOutput) {
  console.log(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Ordex Conformance" tests="${suiteResult.summary.total}" failures="${suiteResult.summary.failed}" time="${(suiteResult.summary.durationMs / 1000).toFixed(3)}">
  <testsuite name="Ordex Verifiers" tests="${suiteResult.summary.total}" failures="${suiteResult.summary.failed}">
${suiteResult.results.map(r => `    <testcase classname="${xml(r.family)}" name="${xml(r.name)}" time="${(r.durationMs / 1000).toFixed(4)}">
${r.passed ? '' : `      <failure message="Verdict mismatch">${xml(JSON.stringify(r.mismatches))}</failure>`}
    </testcase>`).join('\n')}
  </testsuite>
</testsuites>`);
} else {
  console.log(`Ordex Conformance Studio CLI`);
  console.log(`Running ${suiteResult.summary.total} vectors across ${selectedFamilies.length} families...\n`);

  for (const r of suiteResult.results) {
    const symbol = r.passed ? '✔' : '✖';
    console.log(`  ${symbol} [${r.family}] ${r.name} (${r.durationMs.toFixed(2)}ms)`);
    if (!r.passed) {
      console.error(`    Mismatches:`, r.mismatches);
    }
  }

  console.log(`\nResults: ${suiteResult.summary.passed}/${suiteResult.summary.total} passed (${suiteResult.summary.durationMs.toFixed(2)}ms)`);
  if (suiteResult.summary.empty) {
    console.error('\nFAILED: the selected suite has no vectors.');
  } else if (!suiteResult.summary.success) {
    console.error(`\nFAILED: ${suiteResult.summary.failed} checks failed.`);
  }
}

process.exit(suiteResult.summary.success ? 0 : 1);
