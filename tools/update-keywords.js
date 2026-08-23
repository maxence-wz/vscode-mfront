#!/usr/bin/env node
/**
 * Regenerates the @keyword list in syntaxes/mfront.tmLanguage.json from MFront
 * itself, which is the only authoritative source.
 *
 *   node tools/update-keywords.js            # merge: add what's new, keep the rest
 *   node tools/update-keywords.js --prune    # also drop keywords MFront no longer reports
 *   node tools/update-keywords.js --check    # report only, exit 1 if out of date (CI)
 *
 * How the list is obtained (see the TFEL FAQ, "Keywords available"):
 *
 *   mfront --list-dsl                        -> the available DSLs
 *   mfront --help-keywords-list=<DSL>        -> the keywords of one DSL
 *
 * The union over every DSL is taken, because a keyword such as @Gradient only
 * exists in the generic-behaviour DSLs while @Theta only exists in the implicit
 * ones.
 *
 * MERGE IS THE DEFAULT ON PURPOSE. Interface-specific keywords
 * (@AbaqusFiniteStrainStrategy, @UMATUseTimeSubStepping, @AsterSaveTangentOperator,
 * ...) are contributed by an interface rather than by a DSL, so they may not show
 * up in any --help-keywords-list output even though they are perfectly valid in a
 * .mfront file. Pruning would silently delete them. Use --prune only after
 * checking the "no longer reported" list it prints.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GRAMMAR = path.join(__dirname, '..', 'syntaxes', 'mfront.tmLanguage.json');
const MFRONT = process.env.MFRONT || 'mfront';

const argv = process.argv.slice(2);
const PRUNE = argv.includes('--prune');
const CHECK = argv.includes('--check');

function mfront(...args) {
  try {
    return execFileSync(MFRONT, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(
        `Could not run '${MFRONT}'. Install TFEL/MFront and make sure it is on PATH,\n` +
        `or point MFRONT at the binary:  MFRONT=/opt/tfel/bin/mfront node tools/update-keywords.js`
      );
      process.exit(2);
    }
    throw e;
  }
}

// The exact layout of these listings has changed between TFEL releases, so
// rather than parsing a specific shape we take every @token that appears.
const scrape = (text) => (text.match(/@[A-Za-z]\w*/g) || []).map((s) => s.slice(1));

function listDsls() {
  const out = mfront('--list-dsl');
  return out
    .split('\n')
    .map((l) => l.replace(/^[-*\s]+/, '').split(/[\s:]/)[0].trim())
    .filter((n) => /^[A-Za-z]\w+$/.test(n));
}

function currentKeywords(grammar) {
  const m = grammar.repository.keywords.match;
  const inner = m.replace(/^@\(/, '').replace(/\)\\b$/, '');
  return inner.split('|');
}

// TextMate alternation is leftmost-first, NOT longest-match: with
// '@TangentOperator|@TangentOperatorBlocks', the second can never win, and
// '@TangentOperatorBlocks' would highlight only its prefix. Sorting longest
// first makes the prefix cases resolve correctly.
const order = (kws) => [...kws].sort((a, b) => b.length - a.length || a.localeCompare(b));

function main() {
  const grammar = JSON.parse(fs.readFileSync(GRAMMAR, 'utf8'));
  const before = new Set(currentKeywords(grammar));

  const dsls = listDsls();
  if (dsls.length === 0) {
    console.error('mfront --list-dsl returned no DSL; aborting rather than writing an empty list.');
    process.exit(2);
  }
  const reported = new Set();
  for (const dsl of dsls) {
    for (const kw of scrape(mfront(`--help-keywords-list=${dsl}`))) reported.add(kw);
  }
  console.log(`${dsls.length} DSLs queried, ${reported.size} keywords reported.`);

  const added = [...reported].filter((k) => !before.has(k)).sort();
  const unreported = [...before].filter((k) => !reported.has(k)).sort();

  if (added.length) console.log(`\nnew (${added.length}):\n  ${added.join('\n  ')}`);
  if (unreported.length) {
    console.log(
      `\nin the grammar but not reported by mfront (${unreported.length}) --\n` +
      `expected for interface-specific keywords; ${PRUNE ? 'REMOVING (--prune)' : 'keeping'}:\n` +
      `  ${unreported.join('\n  ')}`
    );
  }

  const final = PRUNE ? [...reported] : [...new Set([...before, ...reported])];
  const match = '@(' + order(final).join('|') + ')\\b';

  if (match === grammar.repository.keywords.match) {
    console.log('\nGrammar already up to date.');
    return;
  }
  if (CHECK) {
    console.error('\nGrammar keyword list is out of date; run: node tools/update-keywords.js');
    process.exit(1);
  }

  grammar.repository.keywords.match = match;
  fs.writeFileSync(GRAMMAR, JSON.stringify(grammar, null, 2) + '\n');
  console.log(`\nWrote ${final.length} keywords to ${path.relative(process.cwd(), GRAMMAR)}.`);
  console.log('Run `npm test` to check nothing regressed.');
}

main();
