# Third-party test fixtures

The `.mfront` files in this directory are **not** part of this extension and
are **not** covered by its MIT licence. They are unmodified copies of test
files from the TFEL/MFront project, kept here as real-world regression
fixtures: they exercise constructs that hand-written fixtures tend to miss,
such as LaTeX inside `@Description`, open-ended `@Bounds` intervals and slip
system declarations.

- Upstream project: TFEL/MFront — https://github.com/thelfer/tfel
- Copyright (C) CEA/DEN, EDF R&D
- Licence: GNU GPL (with linking exception) **or** CeCILL-A, at your option,
  as stated by the upstream project

The files are included unmodified, for testing only. They are excluded from
the published extension by `.vscodeignore`, so the `.vsix` distributed on the
Marketplace contains none of them.

Fixtures written for this repository live in `test/fixtures/` and in `test/fixtures/keyword-coverage/`, and are MIT-licensed like the rest of the extension.
