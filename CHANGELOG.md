# Changelog - MFront Syntax Highlighting

## [Unreleased]

### 🐛 Bug Fixes
- `@Description` text is now treated as prose instead of being handed to the
  embedded C++ grammar. Ordinary writing used to break highlighting for the
  rest of the file:
  - an apostrophe or a quote ("the material's behaviour") opened a string that
    never closed;
  - LaTeX with unbalanced braces (`\left\{ ... \right.`) ended the block in the
    wrong place.
- A malformed bounds interval, e.g. `@Bounds x in [0:1;`, is now reported as an
  error instead of silently breaking the rest of the file.

### 🚀 New Features
- MFront type aliases are highlighted: the scalar quantities (`real`, `stress`,
  `strain`, `temperature`, `thermalexpansion`, `massdensity`,
  `thermalconductivity`, ...), the tensorial types (`StrainStensor`,
  `StressStensor`, `StiffnessTensor`, `Stensor4`, ...), the types imported from
  `TFEL/Math` (`stensor`, `tensor`, `st2tost2`, `tvector`, ...) and the generic
  aliases (`derivative_type`, `quantity`, ...).
- 38 keywords that were missing are now recognised, notably the
  generic-behaviour ones (`@Gradient`, `@Flux`, `@ThermodynamicForce`,
  `@TangentOperatorBlocks`) and the solver-interface ones (`@Abaqus*`,
  `@Aster*`, `@Castem*`, `@Cyrano*`, `@UMAT*`, `@CalculiX*`, `@Ansys*`).

### 🔧 Internal
- Test fixtures now cover every keyword the grammar knows about.
- The tests fetch the C++ grammar directly instead of downloading a full VS
  Code build, so `npm test` runs in seconds.
- Added a GitHub Actions workflow running the tests and packaging the
  extension on every branch.

## [1.0.1] - 2026-08-29

### 🐛 Bug Fixes
- Fixed a scope leak where an `@Bounds`/`@PhysicalBounds` interval with an
  open (infinite) endpoint — e.g. `@PhysicalBounds M in [0:*[;`, the
  documented MFront syntax for "no upper bound" — was tokenized by the
  embedded `source.cpp` grammar as an unterminated `[` bracket. That opened a
  `meta.bracket.square.array.cpp` scope that never closed, so every `@Xxx`
  keyword after the first such declaration silently lost
  `keyword.control.mfront` highlighting for the rest of the file.
- Fixed the same class of scope leak for free-form prose inside
  `@Description{ ... }` blocks: `source.cpp` can parse such text as an
  (invalid) function/class declaration and fail to close its scope at the
  block's closing `};`, again suppressing keyword highlighting for everything
  that follows. Added a grammar injection (`L:source.mfront -comment
  -string`) so the keyword rules apply inside nested scopes too, not only at
  the document root.

### 🔧 Internal
- Added a regression test suite tokenizing with the same engine VS Code uses,
  against the real C++ grammar, so these leaks cannot come back unnoticed.

Both fixes and the test suite were contributed by
[@Auubinno](https://github.com/Auubinno).

## [1.0.0] - Initial Release

### 🚀 New Features
- Added syntax highlighting for MFront files (`.mfront`).
- Support for MFront-specific keywords for better code readability.
- Integration of C++ for embedded code in MFront files.
- Basic configuration for recognizing MFront files.
- Custom icon for the extension.

---

Thank you for using **MFront Syntax Highlighting**! 🎨  
Feel free to report bugs or suggest improvements on [GitHub](https://github.com/maxence-wz/vscode-mfront/issues).
