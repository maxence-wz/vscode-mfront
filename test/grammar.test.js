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
