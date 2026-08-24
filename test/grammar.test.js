// Grammar regression tests.
//
// These guard the two scope-leak bugs fixed in PR #1. Both are interactions
// between this grammar and the embedded C++ grammar, so the test tokenizes
// with the same engine VS Code uses (vscode-textmate + vscode-oniguruma) and
// loads the real cpp.tmLanguage.json rather than a stub -- a stub would not
// reproduce the bugs at all.
//
// The C++ grammar is taken from a real VS Code build, downloaded and cached
// by @vscode/test-electron. Set CPP_TMLANGUAGE to a local path to skip the
// download (useful offline):
//
//   CPP_TMLANGUAGE=".../resources/app/extensions/cpp/syntaxes/cpp.tmLanguage.json" npm test

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const KEYWORD_SCOPE = 'keyword.control.mfront';

// --- locating the real C++ grammar ----------------------------------------

function findFile(root, target, depth = 6) {
  if (depth < 0 || !fs.existsSync(root)) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name === target) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findFile(path.join(root, e.name), target, depth - 1);
    if (hit) return hit;
  }
  return null;
}

async function resolveCppGrammarPath() {
  if (process.env.CPP_TMLANGUAGE) return process.env.CPP_TMLANGUAGE;

  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  const exe = await downloadAndUnzipVSCode();
  // Walk up from the executable to the install root, then find the grammar.
  let root = path.dirname(exe);
  for (let i = 0; i < 4; i++) {
    const hit = findFile(root, 'cpp.tmLanguage.json');
    if (hit) return hit;
    root = path.dirname(root);
  }
  throw new Error('Could not locate cpp.tmLanguage.json in the downloaded VS Code build.');
}

// --- registry -------------------------------------------------------------

let grammar;

before(async () => {
  const cppPath = await resolveCppGrammarPath();

  const grammarPaths = {
    'source.mfront': path.join(REPO, 'syntaxes', 'mfront.tmLanguage.json'),
    'mfront.keywords.injection': path.join(REPO, 'syntaxes', 'mfront-keywords.injection.tmLanguage.json'),
    'source.cpp': cppPath,
  };

  // Mirrors what VS Code does with the `injectTo` field in package.json, so
  // the test exercises the same wiring the shipped extension uses.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const injections = {};
  for (const g of pkg.contributes.grammars) {
    for (const target of g.injectTo || []) {
      (injections[target] = injections[target] || []).push(g.scopeName);
    }
  }
  assert.ok(
    (injections['source.mfront'] || []).includes('mfront.keywords.injection'),
    'package.json must inject mfront.keywords.injection into source.mfront'
  );

  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s) => new oniguruma.OnigScanner(s),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    getInjections: (scopeName) => injections[scopeName],
    loadGrammar: async (scopeName) => {
      const p = grammarPaths[scopeName];
      if (!p) return null; // grammars cpp.tmLanguage.json references but does not need here
      return vsctm.parseRawGrammar(fs.readFileSync(p, 'utf8'), p);
    },
  });

  grammar = await registry.loadGrammar('source.mfront');
  assert.ok(grammar, 'failed to load source.mfront');
});

// --- helpers --------------------------------------------------------------

// Tokenizes a whole fixture and returns, per line, the scopes covering the
// first '@' on that line. Tokenizing the entire file (rather than a line in
// isolation) is the point: these bugs are about state leaking across lines.
function scopesAtKeywords(fixture) {
  const lines = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8').split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const result = grammar.tokenizeLine(lines[i], ruleStack);
    ruleStack = result.ruleStack;
    const at = lines[i].indexOf('@');
    if (at === -1) continue;
    const token = result.tokens.find((t) => t.startIndex <= at && at < t.endIndex);
    out.push({
      line: i + 1,
      text: lines[i],
      isDirective: /^\s*@[A-Za-z]\w*/.test(lines[i]),
      scopes: token ? token.scopes : [],
    });
  }
  return out;
}

const hasKeywordScope = (entry) => entry.scopes.some((s) => s.startsWith(KEYWORD_SCOPE));

function assertAllDirectivesHighlighted(fixture) {
  const entries = scopesAtKeywords(fixture).filter((e) => e.isDirective);
  assert.ok(entries.length > 0, `${fixture}: fixture has no @directives`);
  const lost = entries.filter((e) => !hasKeywordScope(e));
  assert.deepStrictEqual(
    lost.map((e) => `L${e.line}: ${e.text.trim()}  ->  ${e.scopes.join(' ')}`),
    [],
    `${fixture}: these @keywords lost ${KEYWORD_SCOPE}`
  );
}

// A well-formed .mfront file closes every scope it opens, so by EOF we should
// be back at the document root. This is a second, independent assertion: it
// catches leaks the directive check above structurally cannot see. When an
// apostrophe in @Description prose opens string.quoted.single.cpp, every
// following @keyword sits *inside* a string scope -- and a keyword quoted in a
// string genuinely should not be highlighted, so a check that skips those would
// report the whole file clean.
function assertNoScopeLeakAtEof(fixture) {
  const lines = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8').split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  for (const line of lines) {
    ruleStack = grammar.tokenizeLine(line, ruleStack).ruleStack;
  }
  // Read the open scopes from a synthetic trailing empty line rather than from
  // the last real token: a file legitimately ending on '}' has that token
  // carrying meta.block.cpp, which is the block being closed, not a leak.
  const tail = grammar.tokenizeLine('', ruleStack);
  const open = (tail.tokens[0] ? tail.tokens[0].scopes : ['source.mfront'])
    .filter((s) => s !== 'source.mfront');
  assert.deepStrictEqual(
    open, [],
    `${fixture}: scope still open at EOF -- it swallows the rest of the file`
  );
}

function listCorpus() {
  return fs.readdirSync(path.join(FIXTURES, 'corpus'))
    .filter((f) => f.endsWith('.mfront'))
    .sort();
}

// --- tests ----------------------------------------------------------------

test('keywords stay highlighted after an open-ended bounds interval', () => {
  assertAllDirectivesHighlighted('bounds-open-interval.mfront');
});

test('keywords stay highlighted after declaration-shaped @Description prose', () => {
  assertAllDirectivesHighlighted('description-declaration-prose.mfront');
});

test('keywords stay highlighted around commented-out keywords', () => {
  assertAllDirectivesHighlighted('keywords-in-comments.mfront');
});

test('keywords inside comments are NOT highlighted', () => {
  const commented = scopesAtKeywords('keywords-in-comments.mfront')
    .filter((e) => !e.isDirective);
  assert.ok(commented.length > 0, 'fixture has no commented-out keywords');
  const wrong = commented.filter(hasKeywordScope);
  assert.deepStrictEqual(
    wrong.map((e) => `L${e.line}: ${e.text.trim()}`),
    [],
    `these keywords are inside a comment and must not carry ${KEYWORD_SCOPE} ` +
    '(the injectionSelector must keep its "-comment -string" suffixes)'
  );
});

test('the bounds interval does not open a C++ bracket scope', () => {
  // Direct guard on the mechanism, not just the symptom: if this regresses,
  // the scope stack grows without bound for the rest of the file.
  const entries = scopesAtKeywords('bounds-open-interval.mfront');
  const leaked = entries.filter((e) =>
    e.scopes.some((s) => s.startsWith('meta.bracket.square'))
  );
  assert.deepStrictEqual(
    leaked.map((e) => `L${e.line}: ${e.text.trim()}`),
    [],
    'a bounds interval leaked a meta.bracket.square scope into later lines'
  );
});

// --- @Description prose is not C++ ----------------------------------------

test('keywords stay highlighted after an apostrophe in @Description prose', () => {
  assertAllDirectivesHighlighted('description-apostrophe.mfront');
  assertNoScopeLeakAtEof('description-apostrophe.mfront');
});

test('keywords stay highlighted after an unclosed double quote in @Description prose', () => {
  assertAllDirectivesHighlighted('description-unclosed-double-quote.mfront');
  assertNoScopeLeakAtEof('description-unclosed-double-quote.mfront');
});

test('unbalanced LaTeX braces in @Description do not end the block early', () => {
  assertAllDirectivesHighlighted('description-latex-braces.mfront');
  assertNoScopeLeakAtEof('description-latex-braces.mfront');
});

test('every @Description block shape opens and closes cleanly', () => {
  assertAllDirectivesHighlighted('description-block-shapes.mfront');
  assertNoScopeLeakAtEof('description-block-shapes.mfront');
});

test('@Description with no block yet does not swallow the directives below', () => {
  assertAllDirectivesHighlighted('description-without-block.mfront');
});

// --- real-world corpus -----------------------------------------------------

// Fixtures under test/fixtures/corpus/ are unmodified files from tfel's own
// test suite, picked so that between them they use every @keyword the corpus
// contains. They are the regression net for the whole grammar, not just for
// one bug: a keyword missing from the list, or any new scope leak, shows up
// here first.
test('every directive in the real-world corpus stays highlighted', () => {
  const files = listCorpus();
  assert.ok(files.length > 0, 'corpus is empty');
  for (const f of files) assertAllDirectivesHighlighted(path.join('corpus', f));
});

test('no real-world corpus file leaks a scope past EOF', () => {
  for (const f of listCorpus()) assertNoScopeLeakAtEof(path.join('corpus', f));
});

// --- keyword list integrity ------------------------------------------------

test('keyword alternatives are ordered so prefixes cannot shadow longer names', () => {
  // TextMate alternation is leftmost-first, not longest-match. If
  // '@TangentOperator' were listed before '@TangentOperatorBlocks', the latter
  // could never match and would highlight only its prefix. tools/update-keywords.js
  // emits the list longest-first; this guards hand edits.
  const grammar = JSON.parse(
    fs.readFileSync(path.join(REPO, 'syntaxes', 'mfront.tmLanguage.json'), 'utf8')
  );
  const kws = grammar.repository.keywords.match
    .replace(/^@\(/, '').replace(/\)\\b$/, '').split('|');
  const shadowed = [];
  for (let i = 0; i < kws.length; i++) {
    for (let j = i + 1; j < kws.length; j++) {
      if (kws[j].startsWith(kws[i])) shadowed.push(`@${kws[j]} is shadowed by @${kws[i]}`);
    }
  }
  assert.deepStrictEqual(shadowed, [], 'a longer keyword is listed after one of its prefixes');
});

test('both @Description braces are scoped as string so neither looks unmatched', () => {
  // VS Code's bracket pair colorization ignores brackets that sit inside a
  // string token. Scoping only the opening brace as string left the closing one
  // looking like an unmatched bracket, which themes render in red.
  for (const fixture of ['description-apostrophe.mfront', 'description-block-shapes.mfront']) {
    const lines = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8').split(/\r?\n/);
    let ruleStack = vsctm.INITIAL;
    for (const line of lines) {
      const { tokens, ruleStack: next } = grammar.tokenizeLine(line, ruleStack);
      ruleStack = next;
      for (const t of tokens) {
        const scopes = t.scopes.join(' ');
        if (!/punctuation\.section\.block\.(begin|end)\.mfront/.test(scopes)) continue;
        assert.ok(
          t.scopes.some((s) => s.startsWith('string.')),
          `${fixture}: ${JSON.stringify(line.substring(t.startIndex, t.endIndex))} ` +
          `is a @Description brace but is not scoped as a string -> ${scopes}`
        );
      }
    }
  }
});
