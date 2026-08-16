# Changelog - MFront Syntax Highlighting

## [Unreleased]

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
