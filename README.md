# MFront Syntax Highlighting

Adds syntax highlighting for MFront files in Visual Studio Code. Based on C++ syntax, this extension enhances the readability of `.mfront` files.

## 📦 Installation

### From the VS Code Marketplace
1. Open **Visual Studio Code**
2. Go to the **Extensions** tab (`Ctrl+Shift+X` / `Cmd+Shift+X` on Mac)
3. Search for `MFront Syntax Highlighting`
4. Click **Install**

### Manual Installation
1. Download the generated `.vsix` file
2. Install it using the following command:
   ```sh
   code --install-extension vscode-mfront-syntax.vsix
   ```

## 🛠 Features
- 🌈 **Syntax highlighting** for `.mfront` files
- 🔍 **Support for MFront-specific keywords**
- 📜 **Based on C++ syntax** for better compatibility
- 🚀 **Auto-completion** (in development)

## 🚀 Usage
Once the extension is installed, open a `.mfront` file in VS Code, and syntax highlighting will be applied automatically.

## 📢 Contribute
Contributions are welcome! To suggest improvements:
1. Fork the repository
2. Clone it locally:
   ```sh
   git clone https://github.com/maxence-wz/vscode-mfront.git
   ```
3. Make your changes and submit a **Pull Request**

### 🧪 Tests

```sh
npm install
npm test
```

The tests tokenize the fixtures in `test/fixtures/` with the same engine VS
Code uses (`vscode-textmate` + `vscode-oniguruma`) and assert that every
`@keyword` keeps its `keyword.control.mfront` scope.

Because this grammar embeds `source.cpp`, the interesting failures are
interactions with the real C++ grammar, so the tests fetch the current
`cpp.tmLanguage.json` from the VS Code repository each run. To run offline, or
against one specific version, point at a local copy:

```sh
CPP_TMLANGUAGE="/path/to/cpp.tmLanguage.json" npm test
```

## 📜 License
This extension is released under the **MIT License**.

---

⭐ **If you find this extension useful, consider leaving a star on [GitHub](https://github.com/maxence-wz/vscode-mfront)!**
