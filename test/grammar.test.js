// Grammar regression tests.
//
// These guard the two scope-leak bugs fixed in PR #1. Both are interactions
// between this grammar and the embedded C++ grammar, so the test tokenizes
// with the same engine VS Code uses (vscode-textmate + vscode-oniguruma) and
// loads the real cpp.tmLanguage.json rather than a stub -- a stub would not
// reproduce the bugs at all.
//
// The C++ grammar is fetched from the vscode repository at run time, so the
// tests always run against the current one. Set CPP_TMLANGUAGE to a local path
// to use a specific copy instead (offline runs, or reproducing a report
// against one version):
//
//   CPP_TMLANGUAGE=".../cpp.tmLanguage.json" npm test

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const KEYWORD_SCOPE = 'keyword.control.mfront';

// --- the real C++ grammar --------------------------------------------------

const CPP_GRAMMAR_URL =
  'https://raw.githubusercontent.com/microsoft/vscode/main/extensions/cpp/syntaxes/cpp.tmLanguage.json';

async function loadCppGrammarSource() {
  const local = process.env.CPP_TMLANGUAGE;
  if (local) return fs.readFileSync(local, 'utf8');

  const response = await fetch(CPP_GRAMMAR_URL);
  if (!response.ok) {
    throw new Error(
      `Could not fetch the C++ grammar (${response.status} ${response.statusText}).\n` +
      `If you are offline, point CPP_TMLANGUAGE at a local copy:\n` +
      `  CPP_TMLANGUAGE=/path/to/cpp.tmLanguage.json npm test`
    );
  }
  return response.text();
}

// --- registry -------------------------------------------------------------

let grammar;

before(async () => {
  const cppSource = await loadCppGrammarSource();

  const grammarPaths = {
    'source.mfront': path.join(REPO, 'syntaxes', 'mfront.tmLanguage.json'),
    'mfront.keywords.injection': path.join(REPO, 'syntaxes', 'mfront-keywords.injection.tmLanguage.json'),
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
      if (scopeName === 'source.cpp') {
        return vsctm.parseRawGrammar(cppSource, 'cpp.tmLanguage.json');
      }
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

function listFixtures(dir) {
  return fs.readdirSync(path.join(FIXTURES, dir))
    .filter((f) => f.endsWith('.mfront'))
    .sort()
    .map((f) => path.join(dir, f));
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

// --- whole-grammar fixtures ------------------------------------------------

// keyword-coverage/ holds fixtures written for this repository, between them
// using every @keyword the grammar knows about. corpus/ holds a few unmodified
// files from TFEL's own test suite (see its README for licensing), kept because
// real files use constructs hand-written ones tend to miss. Together they are
// the regression net for the whole grammar, not just for one bug: a keyword
// missing from the list, or any new scope leak, shows up here first.
test('every directive in the keyword-coverage fixtures stays highlighted', () => {
  const files = listFixtures('keyword-coverage');
  assert.ok(files.length > 0, 'keyword-coverage is empty');
  for (const f of files) assertAllDirectivesHighlighted(f);
});

test('every directive in the real-world fixtures stays highlighted', () => {
  const files = listFixtures('corpus');
  assert.ok(files.length > 0, 'corpus is empty');
  for (const f of files) assertAllDirectivesHighlighted(f);
});

test('no whole-grammar fixture leaks a scope past EOF', () => {
  for (const f of [...listFixtures('keyword-coverage'), ...listFixtures('corpus')]) {
    assertNoScopeLeakAtEof(f);
  }
});

test('the keyword-coverage fixtures use every keyword the grammar declares as reachable', () => {
  // Guards the fixtures themselves: if a keyword is added to the grammar but no
  // fixture ever uses it, nothing above would notice it was mistyped.
  const declared = new Set(
    JSON.parse(fs.readFileSync(path.join(REPO, 'syntaxes', 'mfront.tmLanguage.json'), 'utf8'))
      .repository.keywords.match.replace(/^@\(/, '').replace(/\)\\b$/, '').split('|')
  );
  const used = new Set();
  for (const f of listFixtures('keyword-coverage')) {
    for (const line of fs.readFileSync(path.join(FIXTURES, f), 'utf8').split(/\r?\n/)) {
      const m = /^\s*@([A-Za-z]\w*)/.exec(line);
      if (m && declared.has(m[1])) used.add(m[1]);
    }
  }
  assert.ok(used.size >= 125, `only ${used.size} keywords exercised by the fixtures`);
});

// --- keyword list integrity ------------------------------------------------

test('keyword alternatives are ordered so prefixes cannot shadow longer names', () => {
  // TextMate alternation is leftmost-first, not longest-match. If
  // '@TangentOperator' were listed before '@TangentOperatorBlocks', the latter
  // could never match and would highlight only its prefix. The list is edited by
  // hand, so this test is what keeps that ordering correct.
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

// --- bounds intervals ------------------------------------------------------

test('a valid bounds interval is not rendered as a bracket error', () => {
  // '[0:*[' is correct MFront, but its brackets are unbalanced. Scoped as plain
  // punctuation they would be seen as unmatched openers and coloured red, as if
  // the line were a syntax error. VS Code ignores brackets inside a string
  // token, so the bracket characters must carry a string scope.
  const lines = fs.readFileSync(path.join(FIXTURES, 'bounds-valid-and-invalid.mfront'), 'utf8')
    .split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  let checked = 0;
  for (const line of lines) {
    const { tokens, ruleStack: next } = grammar.tokenizeLine(line, ruleStack);
    ruleStack = next;
    if (!/^\s*@(Physical)?Bounds\b/.test(line)) continue;
    for (const t of tokens) {
      const text = line.substring(t.startIndex, t.endIndex);
      if (text !== '[' && text !== ']') continue;
      checked++;
      assert.ok(
        t.scopes.some((s) => s.startsWith('string.')),
        `${line.trim()}: bracket ${text} is not string-scoped -> ${t.scopes.join(' ')}`
      );
    }
    for (const t of tokens) {
      assert.ok(
        !t.scopes.some((s) => s.startsWith('invalid.')),
        `${line.trim()}: a valid interval must not be flagged invalid`
      );
    }
  }
  assert.ok(checked >= 10, `expected to check several brackets, saw ${checked}`);
});

test('a malformed bounds interval is flagged and does not swallow what follows', () => {
  const fixture = 'bounds-malformed.mfront';
  const lines = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8').split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  let flagged = 0;
  for (const line of lines) {
    const { tokens, ruleStack: next } = grammar.tokenizeLine(line, ruleStack);
    ruleStack = next;
    if (!/^\s*@(Physical)?Bounds\b/.test(line)) continue;
    if (tokens.some((t) => t.scopes.some((s) => s.startsWith('invalid.')))) flagged++;
  }
  assert.strictEqual(flagged, 3, 'every malformed interval should be flagged');
  assertAllDirectivesHighlighted(fixture);
  assertNoScopeLeakAtEof(fixture);
});

test('the injection keeps directives highlighted past a C++ scope leak', () => {
  // Guards the injection itself, which the root rules would otherwise make look
  // redundant: @Description and @Bounds are handled before source.cpp ever sees
  // them, so nothing else in this suite depends on the injection being wired up.
  // A stray '[' in a C++ body still leaks, and only the injection recovers it.
  assertAllDirectivesHighlighted('cpp-unclosed-bracket.mfront');
});

test('the injection recovers a @Description that is already inside a leaked scope', () => {
  // Pins the injection's shape, not just its presence: it must carry
  // #description-block, and with 'L:' precedence, or the @Description prose
  // below an existing leak is handed to source.cpp and leaks again.
  assertAllDirectivesHighlighted('cpp-leak-then-description.mfront');
});

// --- types and predefined variables ----------------------------------------

function scopesOfWord(fixture, word) {
  const lines = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8').split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  const found = [];
  for (const line of lines) {
    const { tokens, ruleStack: next } = grammar.tokenizeLine(line, ruleStack);
    ruleStack = next;
    for (const t of tokens) {
      if (line.substring(t.startIndex, t.endIndex).trim() === word) found.push(t.scopes);
    }
  }
  return found;
}

test('MFront type aliases are highlighted as types, not as unknown C++ identifiers', () => {
  const fixture = 'types.mfront';
  for (const type of ['real', 'stress', 'temperature', 'thermalexpansion', 'massdensity',
                      'thermalconductivity', 'strain', 'StrainStensor', 'StressStensor',
                      'StiffnessTensor', 'Stensor4', 'DeformationGradientTensor',
                      'stensor', 'tvector', 'derivative_type']) {
    const hits = scopesOfWord(fixture, type);
    assert.ok(hits.length > 0, `${type} does not appear in ${fixture}`);
    assert.ok(
      hits.some((scopes) => scopes.some((s) => s.startsWith('storage.type.mfront'))),
      `${type} is not scoped storage.type.mfront -> ${hits[0].join(' ')}`
    );
  }
});

test('a type name inside @Description prose is not highlighted as a type', () => {
  // The prose is inert text; picking words out of it would be noise.
  const hits = scopesOfWord('description-apostrophe.mfront', 'material');
  for (const scopes of hits) {
    assert.ok(
      !scopes.some((s) => s.startsWith('storage.type.mfront')),
      'a word in @Description prose was highlighted as a type'
    );
  }
});

test('MFront types use a scope every theme styles', () => {
  // Regression guard on the scope *choice*, not just on matching. A type that
  // matches but renders in the default foreground looks exactly like a bug, and
  // both semantically nicer candidates do that on stock themes:
  //   - support.type: no rule in 'Dark+' nor in 'Dark (Visual Studio)';
  //   - entity.name.type: no rule in 'Dark (Visual Studio)', where C++ class
  //     names are left unstyled too.
  // storage.type is what source.cpp uses for 'double', and every theme styles
  // it.
  const grammarJson = JSON.parse(
    fs.readFileSync(path.join(REPO, 'syntaxes', 'mfront.tmLanguage.json'), 'utf8')
  );
  assert.ok(
    grammarJson.repository.types.name.startsWith('storage.type'),
    `MFront types are scoped ${grammarJson.repository.types.name}, not storage.type.*`
  );
});
