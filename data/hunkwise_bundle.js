"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/ignore/index.js
var require_ignore = __commonJS({
  "node_modules/ignore/index.js"(exports2, module2) {
    function makeArray(subject) {
      return Array.isArray(subject) ? subject : [subject];
    }
    var UNDEFINED = void 0;
    var EMPTY = "";
    var SPACE = " ";
    var ESCAPE = "\\";
    var REGEX_TEST_BLANK_LINE = /^\s+$/;
    var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
    var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
    var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
    var REGEX_SPLITALL_CRLF = /\r?\n/g;
    var REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;
    var REGEX_TEST_TRAILING_SLASH = /\/$/;
    var SLASH = "/";
    var TMP_KEY_IGNORE = "node-ignore";
    if (typeof Symbol !== "undefined") {
      TMP_KEY_IGNORE = /* @__PURE__ */ Symbol.for("node-ignore");
    }
    var KEY_IGNORE = TMP_KEY_IGNORE;
    var define = (object, key, value) => {
      Object.defineProperty(object, key, { value });
      return value;
    };
    var REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
    var RETURN_FALSE = () => false;
    var sanitizeRange = (range) => range.replace(
      REGEX_REGEXP_RANGE,
      (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY
    );
    var cleanRangeBackSlash = (slashes) => {
      const { length } = slashes;
      return slashes.slice(0, length - length % 2);
    };
    var REPLACERS = [
      [
        // Remove BOM
        // TODO:
        // Other similar zero-width characters?
        /^\uFEFF/,
        () => EMPTY
      ],
      // > Trailing spaces are ignored unless they are quoted with backslash ("\")
      [
        // (a\ ) -> (a )
        // (a  ) -> (a)
        // (a ) -> (a)
        // (a \ ) -> (a  )
        /((?:\\\\)*?)(\\?\s+)$/,
        (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
      ],
      // Replace (\ ) with ' '
      // (\ ) -> ' '
      // (\\ ) -> '\\ '
      // (\\\ ) -> '\\ '
      [
        /(\\+?)\s/g,
        (_, m1) => {
          const { length } = m1;
          return m1.slice(0, length - length % 2) + SPACE;
        }
      ],
      // Escape metacharacters
      // which is written down by users but means special for regular expressions.
      // > There are 12 characters with special meanings:
      // > - the backslash \,
      // > - the caret ^,
      // > - the dollar sign $,
      // > - the period or dot .,
      // > - the vertical bar or pipe symbol |,
      // > - the question mark ?,
      // > - the asterisk or star *,
      // > - the plus sign +,
      // > - the opening parenthesis (,
      // > - the closing parenthesis ),
      // > - and the opening square bracket [,
      // > - the opening curly brace {,
      // > These special characters are often called "metacharacters".
      [
        /[\\$.|*+(){^]/g,
        (match) => `\\${match}`
      ],
      [
        // > a question mark (?) matches a single character
        /(?!\\)\?/g,
        () => "[^/]"
      ],
      // leading slash
      [
        // > A leading slash matches the beginning of the pathname.
        // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
        // A leading slash matches the beginning of the pathname
        /^\//,
        () => "^"
      ],
      // replace special metacharacter slash after the leading slash
      [
        /\//g,
        () => "\\/"
      ],
      [
        // > A leading "**" followed by a slash means match in all directories.
        // > For example, "**/foo" matches file or directory "foo" anywhere,
        // > the same as pattern "foo".
        // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
        // >   under directory "foo".
        // Notice that the '*'s have been replaced as '\\*'
        /^\^*\\\*\\\*\\\//,
        // '**/foo' <-> 'foo'
        () => "^(?:.*\\/)?"
      ],
      // starting
      [
        // there will be no leading '/'
        //   (which has been replaced by section "leading slash")
        // If starts with '**', adding a '^' to the regular expression also works
        /^(?=[^^])/,
        function startingReplacer() {
          return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
        }
      ],
      // two globstars
      [
        // Use lookahead assertions so that we could match more than one `'/**'`
        /\\\/\\\*\\\*(?=\\\/|$)/g,
        // Zero, one or several directories
        // should not use '*', or it will be replaced by the next replacer
        // Check if it is not the last `'/**'`
        (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"
      ],
      // normal intermediate wildcards
      [
        // Never replace escaped '*'
        // ignore rule '\*' will match the path '*'
        // 'abc.*/' -> go
        // 'abc.*'  -> skip this rule,
        //    coz trailing single wildcard will be handed by [trailing wildcard]
        /(^|[^\\]+)(\\\*)+(?=.+)/g,
        // '*.js' matches '.js'
        // '*.js' doesn't match 'abc'
        (_, p1, p2) => {
          const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
          return p1 + unescaped;
        }
      ],
      [
        // unescape, revert step 3 except for back slash
        // For example, if a user escape a '\\*',
        // after step 3, the result will be '\\\\\\*'
        /\\\\\\(?=[$.|*+(){^])/g,
        () => ESCAPE
      ],
      [
        // '\\\\' -> '\\'
        /\\\\/g,
        () => ESCAPE
      ],
      [
        // > The range notation, e.g. [a-zA-Z],
        // > can be used to match one of the characters in a range.
        // `\` is escaped by step 3
        /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
        (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${sanitizeRange(range)}${endEscape}]` : "[]" : "[]"
      ],
      // ending
      [
        // 'js' will not match 'js.'
        // 'ab' will not match 'abc'
        /(?:[^*])$/,
        // WTF!
        // https://git-scm.com/docs/gitignore
        // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
        // which re-fixes #24, #38
        // > If there is a separator at the end of the pattern then the pattern
        // > will only match directories, otherwise the pattern can match both
        // > files and directories.
        // 'js*' will not match 'a.js'
        // 'js/' will not match 'a.js'
        // 'js' will match 'a.js' and 'a.js/'
        (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`
      ]
    ];
    var REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
    var MODE_IGNORE = "regex";
    var MODE_CHECK_IGNORE = "checkRegex";
    var UNDERSCORE = "_";
    var TRAILING_WILD_CARD_REPLACERS = {
      [MODE_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      },
      [MODE_CHECK_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      }
    };
    var makeRegexPrefix = (pattern) => REPLACERS.reduce(
      (prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)),
      pattern
    );
    var isString = (subject) => typeof subject === "string";
    var checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
    var splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);
    var IgnoreRule = class {
      constructor(pattern, mark, body, ignoreCase, negative, prefix) {
        this.pattern = pattern;
        this.mark = mark;
        this.negative = negative;
        define(this, "body", body);
        define(this, "ignoreCase", ignoreCase);
        define(this, "regexPrefix", prefix);
      }
      get regex() {
        const key = UNDERSCORE + MODE_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_IGNORE, key);
      }
      get checkRegex() {
        const key = UNDERSCORE + MODE_CHECK_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_CHECK_IGNORE, key);
      }
      _make(mode, key) {
        const str = this.regexPrefix.replace(
          REGEX_REPLACE_TRAILING_WILDCARD,
          // It does not need to bind pattern
          TRAILING_WILD_CARD_REPLACERS[mode]
        );
        const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
        return define(this, key, regex);
      }
    };
    var createRule = ({
      pattern,
      mark
    }, ignoreCase) => {
      let negative = false;
      let body = pattern;
      if (body.indexOf("!") === 0) {
        negative = true;
        body = body.substr(1);
      }
      body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
      const regexPrefix = makeRegexPrefix(body);
      return new IgnoreRule(
        pattern,
        mark,
        body,
        ignoreCase,
        negative,
        regexPrefix
      );
    };
    var RuleManager = class {
      constructor(ignoreCase) {
        this._ignoreCase = ignoreCase;
        this._rules = [];
      }
      _add(pattern) {
        if (pattern && pattern[KEY_IGNORE]) {
          this._rules = this._rules.concat(pattern._rules._rules);
          this._added = true;
          return;
        }
        if (isString(pattern)) {
          pattern = {
            pattern
          };
        }
        if (checkPattern(pattern.pattern)) {
          const rule = createRule(pattern, this._ignoreCase);
          this._added = true;
          this._rules.push(rule);
        }
      }
      // @param {Array<string> | string | Ignore} pattern
      add(pattern) {
        this._added = false;
        makeArray(
          isString(pattern) ? splitPattern(pattern) : pattern
        ).forEach(this._add, this);
        return this._added;
      }
      // Test one single path without recursively checking parent directories
      //
      // - checkUnignored `boolean` whether should check if the path is unignored,
      //   setting `checkUnignored` to `false` could reduce additional
      //   path matching.
      // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`
      // @returns {TestResult} true if a file is ignored
      test(path8, checkUnignored, mode) {
        let ignored = false;
        let unignored = false;
        let matchedRule;
        this._rules.forEach((rule) => {
          const { negative } = rule;
          if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) {
            return;
          }
          const matched = rule[mode].test(path8);
          if (!matched) {
            return;
          }
          ignored = !negative;
          unignored = negative;
          matchedRule = negative ? UNDEFINED : rule;
        });
        const ret = {
          ignored,
          unignored
        };
        if (matchedRule) {
          ret.rule = matchedRule;
        }
        return ret;
      }
    };
    var throwError = (message, Ctor) => {
      throw new Ctor(message);
    };
    var checkPath = (path8, originalPath, doThrow) => {
      if (!isString(path8)) {
        return doThrow(
          `path must be a string, but got \`${originalPath}\``,
          TypeError
        );
      }
      if (!path8) {
        return doThrow(`path must not be empty`, TypeError);
      }
      if (checkPath.isNotRelative(path8)) {
        const r = "`path.relative()`d";
        return doThrow(
          `path should be a ${r} string, but got "${originalPath}"`,
          RangeError
        );
      }
      return true;
    };
    var isNotRelative = (path8) => REGEX_TEST_INVALID_PATH.test(path8);
    checkPath.isNotRelative = isNotRelative;
    checkPath.convert = (p) => p;
    var Ignore = class {
      constructor({
        ignorecase = true,
        ignoreCase = ignorecase,
        allowRelativePaths = false
      } = {}) {
        define(this, KEY_IGNORE, true);
        this._rules = new RuleManager(ignoreCase);
        this._strictPathCheck = !allowRelativePaths;
        this._initCache();
      }
      _initCache() {
        this._ignoreCache = /* @__PURE__ */ Object.create(null);
        this._testCache = /* @__PURE__ */ Object.create(null);
      }
      add(pattern) {
        if (this._rules.add(pattern)) {
          this._initCache();
        }
        return this;
      }
      // legacy
      addPattern(pattern) {
        return this.add(pattern);
      }
      // @returns {TestResult}
      _test(originalPath, cache, checkUnignored, slices) {
        const path8 = originalPath && checkPath.convert(originalPath);
        checkPath(
          path8,
          originalPath,
          this._strictPathCheck ? throwError : RETURN_FALSE
        );
        return this._t(path8, cache, checkUnignored, slices);
      }
      checkIgnore(path8) {
        if (!REGEX_TEST_TRAILING_SLASH.test(path8)) {
          return this.test(path8);
        }
        const slices = path8.split(SLASH).filter(Boolean);
        slices.pop();
        if (slices.length) {
          const parent = this._t(
            slices.join(SLASH) + SLASH,
            this._testCache,
            true,
            slices
          );
          if (parent.ignored) {
            return parent;
          }
        }
        return this._rules.test(path8, false, MODE_CHECK_IGNORE);
      }
      _t(path8, cache, checkUnignored, slices) {
        if (path8 in cache) {
          return cache[path8];
        }
        if (!slices) {
          slices = path8.split(SLASH).filter(Boolean);
        }
        slices.pop();
        if (!slices.length) {
          return cache[path8] = this._rules.test(path8, checkUnignored, MODE_IGNORE);
        }
        const parent = this._t(
          slices.join(SLASH) + SLASH,
          cache,
          checkUnignored,
          slices
        );
        return cache[path8] = parent.ignored ? parent : this._rules.test(path8, checkUnignored, MODE_IGNORE);
      }
      ignores(path8) {
        return this._test(path8, this._ignoreCache, false).ignored;
      }
      createFilter() {
        return (path8) => !this.ignores(path8);
      }
      filter(paths) {
        return makeArray(paths).filter(this.createFilter());
      }
      // @returns {TestResult}
      test(path8) {
        return this._test(path8, this._testCache, true);
      }
    };
    var factory = (options) => new Ignore(options);
    var isPathValid = (path8) => checkPath(path8 && checkPath.convert(path8), path8, RETURN_FALSE);
    var setupWindows = () => {
      const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
      checkPath.convert = makePosix;
      const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
      checkPath.isNotRelative = (path8) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path8) || isNotRelative(path8);
    };
    if (
      // Detect `process` so that it can run in browsers.
      typeof process !== "undefined" && process.platform === "win32"
    ) {
      setupWindows();
    }
    module2.exports = factory;
    factory.default = factory;
    module2.exports.isPathValid = isPathValid;
    define(module2.exports, /* @__PURE__ */ Symbol.for("setupWindows"), setupWindows);
  }
});

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate,
  getFileWatcher: () => getFileWatcher,
  getReviewPanel: () => getReviewPanel,
  getStateManager: () => getStateManager
});
module.exports = __toCommonJS(extension_exports);
var vscode9 = __toESM(require("vscode"));
var fs7 = __toESM(require("fs"));
var path7 = __toESM(require("path"));

// src/stateManager.ts
var vscode2 = __toESM(require("vscode"));
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/hunkwiseGit.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_child_process = require("child_process");
var import_util = require("util");

// src/pathNormalize.ts
function normalizePath(p) {
  if (process.platform === "darwin") {
    return p.normalize("NFC");
  }
  return p;
}

// src/hunkwiseGit.ts
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var DEFAULT_SETTINGS = {
  ignorePatterns: process.platform === "darwin" ? [".git", ".DS_Store"] : [".git"],
  respectGitignore: true,
  clearOnBranchSwitch: false,
  quoteRotationInterval: 30,
  useDiffEditor: false,
  showInlineDecorations: true
};
var HunkwiseGit = class {
  constructor(hunkwiseDir, workspaceRoot, logger) {
    this.gitInitialized = false;
    this.destroyed = false;
    this.hunkwiseDir = hunkwiseDir;
    this.gitDir = path.join(hunkwiseDir, "git");
    this.workTree = workspaceRoot;
    this.log = logger ?? ((msg) => console.warn(`[hunkwise] ${msg}`));
  }
  // ── env / low-level git ───────────────────────────────────────────────────
  get env() {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      GIT_TERMINAL_PROMPT: "0"
    };
  }
  async git(args) {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: this.workTree,
      env: this.env,
      maxBuffer: 10 * 1024 * 1024
      // 10 MB — default 1 MB is too small for large files
    });
    return stdout;
  }
  // ── settings.json ─────────────────────────────────────────────────────────
  get settingsPath() {
    return path.join(this.hunkwiseDir, "settings.json");
  }
  loadSettings() {
    try {
      const raw = fs.readFileSync(this.settingsPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        ignorePatterns: parsed.ignorePatterns ?? [...DEFAULT_SETTINGS.ignorePatterns],
        respectGitignore: parsed.respectGitignore ?? DEFAULT_SETTINGS.respectGitignore,
        clearOnBranchSwitch: parsed.clearOnBranchSwitch ?? DEFAULT_SETTINGS.clearOnBranchSwitch,
        quoteRotationInterval: typeof parsed.quoteRotationInterval === "number" && Number.isFinite(parsed.quoteRotationInterval) && parsed.quoteRotationInterval >= 0 ? parsed.quoteRotationInterval : DEFAULT_SETTINGS.quoteRotationInterval,
        useDiffEditor: typeof parsed.useDiffEditor === "boolean" ? parsed.useDiffEditor : DEFAULT_SETTINGS.useDiffEditor,
        showInlineDecorations: typeof parsed.showInlineDecorations === "boolean" ? parsed.showInlineDecorations : DEFAULT_SETTINGS.showInlineDecorations
      };
    } catch {
      return { ...DEFAULT_SETTINGS, ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns] };
    }
  }
  saveSettings(settings) {
    try {
      fs.mkdirSync(this.hunkwiseDir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    } catch (err) {
      this.log(`saveSettings failed: ${err}`);
    }
  }
  /**
   * Merge defaults into existing settings.json.
   * Fields already present are kept; missing fields are added.
   * Returns the resulting settings.
   */
  mergeDefaultSettings(defaults) {
    const existing = fs.existsSync(this.settingsPath) ? this.loadSettings() : {};
    const merged = { ...defaults, ...existing };
    this.saveSettings(merged);
    return merged;
  }
  // ── git init ──────────────────────────────────────────────────────────────
  async initGit() {
    if (this.destroyed || this.gitInitialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitGit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = void 0;
    }
  }
  async doInitGit() {
    const headPath = path.join(this.gitDir, "HEAD");
    if (!fs.existsSync(this.gitDir) || !fs.existsSync(headPath)) {
      if (fs.existsSync(this.gitDir)) {
        this.log("initGit: corrupted git dir detected (HEAD missing), re-initializing");
        try {
          fs.rmSync(this.gitDir, { recursive: true, force: true });
        } catch (err) {
          this.log(`initGit: failed to remove corrupted git dir: ${err}`);
          throw err;
        }
      }
      if (this.destroyed) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git(["init"]);
      if (this.destroyed) return;
      await this.git(["config", "user.email", "hunkwise@localhost"]);
      if (this.destroyed) return;
      await this.git(["config", "user.name", "hunkwise"]);
    }
    if (this.destroyed) return;
    this.gitInitialized = true;
  }
  async hasHead() {
    try {
      await this.git(["rev-parse", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }
  // ── snapshot / remove ─────────────────────────────────────────────────────
  /**
   * Write content into the git index for filePath (no commit).
   * Use commit() to persist.
   */
  async snapshot(filePath, content) {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const hash = await new Promise((resolve, reject) => {
        const child = (0, import_child_process.execFile)(
          "git",
          ["hash-object", "-w", "--stdin"],
          { env: this.env },
          (err, stdout) => err ? reject(err) : resolve(stdout.trim())
        );
        child.stdin.end(content, "utf-8");
      });
      await this.git(["update-index", "--add", "--cacheinfo", `100644,${hash},${rel}`]);
      await this.commit();
    } catch (err) {
      this.log(`snapshot failed for ${rel}: ${err}`);
      throw err;
    }
  }
  /**
   * Rename a file (or all files under a directory) in the git index and commit.
   * Reuses existing blob hashes — no content re-hashing needed.
   */
  async renameFile(oldFilePath, newFilePath) {
    await this.initGit();
    const oldRel = normalizePath(path.relative(this.workTree, oldFilePath));
    const newRel = normalizePath(path.relative(this.workTree, newFilePath));
    try {
      const lsOut = await this.git(["ls-files", "--stage", "--", oldRel]);
      const lines = lsOut.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return;
      const entries = [];
      for (const line of lines) {
        const m = line.match(/^(\d+) ([0-9a-f]+) \d+\t(.+)$/);
        if (!m) continue;
        entries.push({ mode: m[1], hash: m[2], entryRel: normalizePath(m[3]) });
      }
      if (entries.length === 0) return;
      const oldPaths = entries.map((e) => e.entryRel);
      const CHUNK = 200;
      for (let i = 0; i < oldPaths.length; i += CHUNK) {
        await this.git(["update-index", "--force-remove", "--", ...oldPaths.slice(i, i + CHUNK)]);
      }
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ mode, hash, entryRel }) => {
          const suffix = entryRel === oldRel ? "" : entryRel.slice(oldRel.length);
          const renamed = newRel + suffix;
          return ["--add", "--cacheinfo", `${mode},${hash},${renamed}`];
        });
        await this.git(["update-index", ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`renameFile failed (${path.relative(this.workTree, oldFilePath)} \u2192 ${path.relative(this.workTree, newFilePath)}): ${err}`);
      throw err;
    }
  }
  /**
   * Remove a file's baseline from the git index and commit.
   */
  async removeFile(filePath) {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const lsOut = await this.git(["ls-files", "--stage", "--", rel]);
      if (!lsOut.trim()) return;
      await this.git(["update-index", "--force-remove", "--", rel]);
      await this.commit();
    } catch (err) {
      this.log(`removeFile failed for ${rel}: ${err}`);
      throw err;
    }
  }
  /**
   * Snapshot multiple files at once — writes all blobs to index then commits once.
   * Much faster than calling snapshot() per file.
   */
  async snapshotBatch(files) {
    if (files.length === 0) return;
    await this.initGit();
    try {
      const entries = await Promise.all(
        files.map(
          ({ filePath, content }) => new Promise((resolve, reject) => {
            const rel = normalizePath(path.relative(this.workTree, filePath));
            const child = (0, import_child_process.execFile)(
              "git",
              ["hash-object", "-w", "--stdin"],
              { env: this.env },
              (err, stdout) => err ? reject(err) : resolve({ rel, hash: stdout.trim() })
            );
            child.stdin.end(content, "utf-8");
          })
        )
      );
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ["--add", "--cacheinfo", `100644,${hash},${rel}`]);
        await this.git(["update-index", ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`snapshotBatch failed (${files.length} files): ${err}`);
    }
  }
  /**
   * Remove multiple files from the git index in a single operation and commit once.
   * Much faster than calling removeFile() per file.
   */
  async removeFileBatch(filePaths) {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const rels = filePaths.map((fp) => normalizePath(path.relative(this.workTree, fp)));
      const CHUNK = 200;
      for (let i = 0; i < rels.length; i += CHUNK) {
        await this.git(["update-index", "--force-remove", "--", ...rels.slice(i, i + CHUNK)]);
      }
      await this.commit();
    } catch (err) {
      this.log(`removeFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }
  async commit() {
    if (await this.hasHead()) {
      await this.git(["commit", "--amend", "--no-edit", "--allow-empty"]);
    } else {
      await this.git(["commit", "-m", "hunkwise baselines"]);
    }
  }
  /**
   * Return the baseline content for a file from the git index, or undefined if not tracked.
   * Reads from index (not HEAD) so newly staged files are immediately visible.
   */
  async getBaseline(filePath) {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      return await this.git(["show", `:${rel}`]);
    } catch {
      return void 0;
    }
  }
  /**
   * Return absolute paths of all files currently tracked in HEAD.
   */
  async listTrackedFiles() {
    await this.initGit();
    try {
      const out = await this.git(["ls-tree", "HEAD", "--name-only", "-r"]);
      return out.split("\n").map((l) => l.trim()).filter(Boolean).map((rel) => normalizePath(path.join(this.workTree, rel)));
    } catch {
      return [];
    }
  }
  // ── destroy ───────────────────────────────────────────────────────────────
  /** Remove only the git directory (called on disable). settings.json is preserved. */
  destroyGit() {
    this.gitInitialized = false;
    this.destroyed = true;
    if (fs.existsSync(this.gitDir)) {
      try {
        fs.rmSync(this.gitDir, { recursive: true, force: true });
      } catch (err) {
        this.log(`destroyGit failed: ${err}`);
      }
    }
  }
};

// src/log.ts
var vscode = __toESM(require("vscode"));
var channel;
function initLog() {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Hunkwise");
  }
}
function log(message) {
  channel?.appendLine(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`);
}

// src/stateManager.ts
var DEFAULT_IGNORE_PATTERNS = process.platform === "darwin" ? [".git", ".DS_Store"] : [".git"];
function logFileList(files, rootPath) {
  const rel = files.map((fp) => rootPath ? path2.relative(rootPath, fp) : fp);
  const shown = rel.slice(0, 20);
  const suffix = rel.length > 20 ? ` \u2026 and ${rel.length - 20} more` : "";
  return shown.join(", ") + suffix;
}
var StateManager = class {
  constructor() {
    // In-memory cache — rebuilt from git on load(), updated synchronously on mutations
    this.state = /* @__PURE__ */ new Map();
    this._enabled = false;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    this._respectGitignore = true;
    this._clearOnBranchSwitch = false;
    this._quoteRotationInterval = 30;
    this._useDiffEditor = false;
    this._showInlineDecorations = true;
    // Serial queue: git ops run one at a time; flush() awaits the tail
    this.gitQueue = Promise.resolve();
    const workspaceFolders = vscode2.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.workspaceRoot = workspaceFolders[0].uri.fsPath;
      this.hunkwiseDir = path2.join(this.workspaceRoot, ".vscode", "hunkwise");
    }
  }
  // ── accessors ─────────────────────────────────────────────────────────────
  get enabled() {
    return this._enabled;
  }
  get ignorePatterns() {
    return this._ignorePatterns;
  }
  get respectGitignore() {
    return this._respectGitignore;
  }
  get clearOnBranchSwitch() {
    return this._clearOnBranchSwitch;
  }
  get quoteRotationInterval() {
    return this._quoteRotationInterval;
  }
  get useDiffEditor() {
    return this._useDiffEditor;
  }
  get showInlineDecorations() {
    return this._showInlineDecorations;
  }
  get dir() {
    return this.hunkwiseDir;
  }
  get git() {
    return this._git;
  }
  /**
   * Walk workspace and collect files that exist on disk but are not tracked in git.
   * These are externally created new files that should be shown with null baseline.
   */
  async collectUntrackedFiles(trackedSet, shouldIgnore) {
    if (!this.workspaceRoot) return [];
    const root = this.workspaceRoot;
    const collect = async (dir) => {
      let results = [];
      let entries;
      try {
        entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = normalizePath(path2.join(dir, entry.name));
        const isDir = entry.isDirectory();
        if (shouldIgnore?.(full, isDir)) continue;
        if (isDir) {
          const nested = await collect(full);
          if (nested.length) results.push(...nested);
        } else if (entry.isFile() && !trackedSet.has(full)) {
          try {
            await fs2.promises.access(full, fs2.constants.R_OK);
            results.push(full);
          } catch {
            continue;
          }
        }
      }
      return results;
    };
    return collect(root);
  }
  // ── init / load ───────────────────────────────────────────────────────────
  ensureGit() {
    if (!this.hunkwiseDir || !this.workspaceRoot) return void 0;
    if (!this._git) {
      this._git = new HunkwiseGit(this.hunkwiseDir, this.workspaceRoot, log);
    }
    return this._git;
  }
  /**
   * Load persistent state from settings.json + git repo.
   * Must be called once at activation. Async because reading baselines
   * from git requires exec calls.
   */
  async load(shouldIgnore) {
    const g = this.ensureGit();
    if (!g) return;
    const gitDir = path2.join(this.hunkwiseDir, "git");
    if (!fs2.existsSync(gitDir)) return;
    this._enabled = true;
    const settings = g.loadSettings();
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;
    this._clearOnBranchSwitch = settings.clearOnBranchSwitch;
    this._quoteRotationInterval = settings.quoteRotationInterval;
    this._useDiffEditor = settings.useDiffEditor;
    this._showInlineDecorations = settings.showInlineDecorations;
    await g.initGit();
    const tracked = await g.listTrackedFiles();
    const ignored = [];
    const skippedNoBaseline = [];
    const reviewing = [];
    const idle = [];
    await Promise.all(tracked.map(async (filePath) => {
      if (shouldIgnore?.(filePath)) {
        ignored.push(filePath);
        return;
      }
      const baseline = await g.getBaseline(filePath);
      if (baseline === void 0) {
        skippedNoBaseline.push(filePath);
        return;
      }
      let diskContent;
      let fileDeleted = false;
      try {
        diskContent = await fs2.promises.readFile(filePath, "utf-8");
      } catch (err) {
        if (err?.code === "ENOENT") {
          fileDeleted = true;
        }
      }
      if (fileDeleted || diskContent !== void 0 && diskContent !== baseline) {
        this.state.set(filePath, { status: "reviewing", baseline });
        reviewing.push(filePath);
      } else {
        idle.push(filePath);
      }
    }));
    if (skippedNoBaseline.length > 0) {
      log(`load: skipped ${skippedNoBaseline.length} file(s) with no baseline in index: ${logFileList(skippedNoBaseline, this.workspaceRoot)}`);
    }
    if (reviewing.length > 0) {
      log(`load: ${reviewing.length} file(s) have diffs: ${logFileList(reviewing, this.workspaceRoot)}`);
    }
    if (idle.length > 0) {
      log(`load: ${idle.length} file(s) unchanged, baseline preserved`);
    }
    if (ignored.length > 0) {
      log(`load: removing ${ignored.length} ignored file(s) from git: ${logFileList(ignored, this.workspaceRoot)}`);
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(ignored)).catch((err) => {
        log(`git queue error: ${err}`);
      });
    }
    const trackedSet = new Set(tracked);
    const untrackedFiles = await this.collectUntrackedFiles(trackedSet, shouldIgnore);
    if (untrackedFiles.length > 0) {
      log(`load: ${untrackedFiles.length} untracked new file(s): ${logFileList(untrackedFiles, this.workspaceRoot)}`);
      for (const fp of untrackedFiles) {
        this.state.set(fp, { status: "reviewing", baseline: null });
      }
    }
  }
  /**
   * Rebuild in-memory state from git baselines, comparing with the current state.
   * Logs a diff report showing what changed.
   */
  async rebuildState(shouldIgnore) {
    const g = this._git;
    if (!g || !this._enabled) {
      log("rebuildState: not enabled or no git, skip");
      return;
    }
    log("rebuildState: begin");
    await this.gitQueue;
    const oldState = /* @__PURE__ */ new Map();
    for (const [fp, fs8] of this.state) {
      oldState.set(fp, { ...fs8 });
    }
    this.state.clear();
    await g.initGit();
    const tracked = await g.listTrackedFiles();
    const filtered = tracked.filter((fp) => !shouldIgnore?.(fp));
    await Promise.all(filtered.map(async (filePath) => {
      const baseline = await g.getBaseline(filePath);
      if (baseline === void 0) return;
      let diskContent;
      let fileDeleted = false;
      try {
        diskContent = await fs2.promises.readFile(filePath, "utf-8");
      } catch (err) {
        if (err?.code === "ENOENT") {
          fileDeleted = true;
        }
      }
      if (fileDeleted || diskContent !== void 0 && diskContent !== baseline) {
        this.state.set(filePath, { status: "reviewing", baseline });
      }
    }));
    const trackedSet = new Set(tracked);
    const untrackedFiles = await this.collectUntrackedFiles(trackedSet, shouldIgnore);
    for (const fp of untrackedFiles) {
      this.state.set(fp, { status: "reviewing", baseline: null });
    }
    const added = [];
    const removed = [];
    const baselineChanged = [];
    const statusChanged = [];
    const rootPath = this.workspaceRoot;
    const rel = (fp) => rootPath ? path2.relative(rootPath, fp) : fp;
    for (const [fp, newFs] of this.state) {
      const oldFs = oldState.get(fp);
      if (!oldFs) {
        added.push(rel(fp));
      } else {
        if (oldFs.baseline !== newFs.baseline) baselineChanged.push(rel(fp));
        if (oldFs.status !== newFs.status) statusChanged.push(rel(fp));
      }
    }
    for (const fp of oldState.keys()) {
      if (!this.state.has(fp)) removed.push(rel(fp));
    }
    if (added.length === 0 && removed.length === 0 && baselineChanged.length === 0 && statusChanged.length === 0) {
      log("rebuildState: no differences found \u2014 memory state matches git");
    } else {
      log(`rebuildState: differences found:`);
      if (added.length > 0) log(`  added (found in git or on disk but was missing from memory): ${added.join(", ")}`);
      if (removed.length > 0) log(`  removed (in memory but not in git/disk): ${removed.join(", ")}`);
      if (baselineChanged.length > 0) log(`  baseline changed: ${baselineChanged.join(", ")}`);
      if (statusChanged.length > 0) log(`  status changed: ${statusChanged.join(", ")}`);
    }
    log(`rebuildState: done \u2014 ${this.state.size} file(s) in reviewing state`);
  }
  // ── file state ────────────────────────────────────────────────────────────
  getFile(filePath) {
    return this.state.get(normalizePath(filePath));
  }
  setFile(filePath, state, skipSnapshot) {
    filePath = normalizePath(filePath);
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath) } : void 0;
    this.state.set(filePath, state);
    if (!skipSnapshot && this._git && state.baseline !== null) {
      const g = this._git;
      const baseline = state.baseline;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch((err) => {
        log(`git queue error (setFile rollback): ${err}`);
        if (this.state.get(filePath) === state) {
          if (oldState) {
            this.state.set(filePath, oldState);
          } else {
            this.state.delete(filePath);
          }
          this.onRollback?.();
        }
      });
    }
  }
  removeFile(filePath) {
    filePath = normalizePath(filePath);
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath) } : void 0;
    this.state.delete(filePath);
    if (this._git && !(oldState !== void 0 && oldState.baseline === null)) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.removeFile(filePath)).catch((err) => {
        log(`git queue error (removeFile rollback): ${err}`);
        if (!this.state.has(filePath) && oldState) {
          this.state.set(filePath, { ...oldState });
          this.onRollback?.();
        }
      });
    }
  }
  renameFile(oldFilePath, newFilePath) {
    oldFilePath = normalizePath(oldFilePath);
    newFilePath = normalizePath(newFilePath);
    const oldPrefix = oldFilePath + path2.sep;
    let hasDirChildren = false;
    const fileState = this.state.get(oldFilePath);
    if (fileState) {
      this.state.delete(oldFilePath);
      this.state.set(newFilePath, fileState);
    }
    for (const [fp, childState] of [...this.state.entries()]) {
      if (fp.startsWith(oldPrefix)) {
        this.state.delete(fp);
        const newFp = newFilePath + fp.slice(oldFilePath.length);
        this.state.set(newFp, childState);
        hasDirChildren = true;
      }
    }
    const skipGit = fileState && fileState.baseline === null && !hasDirChildren;
    if (this._git && !skipGit) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.renameFile(oldFilePath, newFilePath)).catch((err) => {
        log(`git queue error (renameFile): ${err}`);
      });
    }
  }
  /**
   * Snapshot a file's content as baseline via the git queue (serialized).
   * Use this instead of calling git.snapshot() directly to avoid concurrent git ops.
   */
  snapshotFile(filePath, content) {
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, content)).catch((err) => {
        log(`git queue error: ${err}`);
      });
    }
  }
  getAllFiles() {
    return this.state;
  }
  isReviewing(filePath) {
    return this.state.get(normalizePath(filePath))?.status === "reviewing";
  }
  /**
   * Exit reviewing state without removing the file from git.
   * If newBaseline is provided as a non-null string, update the baseline in git (e.g. after accept).
   * If omitted or explicitly null, do not snapshot or update the git baseline; the existing baseline
   * is assumed to already be correct (e.g. hunks resolved to 0, or discard).
   */
  exitReviewing(filePath, newBaseline) {
    filePath = normalizePath(filePath);
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath) } : void 0;
    this.state.delete(filePath);
    if (newBaseline !== void 0 && newBaseline !== null) {
      if (this._git) {
        const g = this._git;
        const baseline = newBaseline;
        this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch((err) => {
          log(`git queue error (exitReviewing rollback): ${err}`);
          if (!this.state.has(filePath) && oldState) {
            this.state.set(filePath, { ...oldState });
            this.onRollback?.();
            void vscode2.window.showErrorMessage(
              `Failed to update review baseline for ${path2.basename(filePath)}. The file has been kept in reviewing so you can retry.`
            );
          }
        });
      }
    }
  }
  // ── settings ──────────────────────────────────────────────────────────────
  async setEnabled(value) {
    this._enabled = value;
    if (value) {
      const g = this.ensureGit();
      if (!g) return;
      await g.initGit();
      const merged = g.mergeDefaultSettings(this.currentSettings());
      this._ignorePatterns = merged.ignorePatterns;
      this._respectGitignore = merged.respectGitignore;
      this._clearOnBranchSwitch = merged.clearOnBranchSwitch;
      this._quoteRotationInterval = merged.quoteRotationInterval;
      this._useDiffEditor = merged.useDiffEditor;
      this._showInlineDecorations = merged.showInlineDecorations;
    } else {
      this.state.clear();
      this._git?.destroyGit();
      this._git = void 0;
    }
  }
  /**
   * Snapshot all current workspace files into hunkwise git as baselines.
   * Only snapshots files that don't already have a baseline recorded.
   * Should be called once after enable.
   */
  async snapshotWorkspace(shouldIgnore) {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;
    const collect = async (dir) => {
      let results = [];
      let entries;
      try {
        entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = normalizePath(path2.join(dir, entry.name));
        const isDir = entry.isDirectory();
        if (shouldIgnore(full, isDir)) continue;
        if (isDir) {
          results = results.concat(await collect(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    };
    const filePaths = await collect(this.workspaceRoot);
    const batch = [];
    await Promise.all(filePaths.map(async (filePath) => {
      try {
        const content = await fs2.promises.readFile(filePath, "utf-8");
        batch.push({ filePath, content });
      } catch {
      }
    }));
    if (batch.length > 0) {
      await g.snapshotBatch(batch);
    }
  }
  currentSettings() {
    return { ignorePatterns: this._ignorePatterns, respectGitignore: this._respectGitignore, clearOnBranchSwitch: this._clearOnBranchSwitch, quoteRotationInterval: this._quoteRotationInterval, useDiffEditor: this._useDiffEditor, showInlineDecorations: this._showInlineDecorations };
  }
  setIgnorePatterns(patterns) {
    this._ignorePatterns = patterns;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), ignorePatterns: patterns });
    }
  }
  setRespectGitignore(value) {
    this._respectGitignore = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), respectGitignore: value });
    }
  }
  setClearOnBranchSwitch(value) {
    this._clearOnBranchSwitch = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), clearOnBranchSwitch: value });
    }
  }
  setQuoteRotationInterval(value) {
    const normalized = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    this._quoteRotationInterval = normalized;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), quoteRotationInterval: normalized });
    }
  }
  setUseDiffEditor(value) {
    log(`settings: useDiffEditor=${value}`);
    this._useDiffEditor = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), useDiffEditor: value });
    }
  }
  setShowInlineDecorations(value) {
    log(`settings: showInlineDecorations=${value}`);
    this._showInlineDecorations = value;
    if (this._enabled && this._git) {
      this._git.saveSettings({ ...this.currentSettings(), showInlineDecorations: value });
    }
  }
  /**
   * Reload all settings from settings.json (called when settings.json is modified externally).
   * Returns the new ignorePatterns if enabled, null if not enabled or no git.
   */
  reloadIgnorePatterns() {
    if (!this._enabled || !this._git) return null;
    const settings = this._git.loadSettings();
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;
    this._clearOnBranchSwitch = settings.clearOnBranchSwitch;
    this._quoteRotationInterval = settings.quoteRotationInterval;
    this._useDiffEditor = settings.useDiffEditor;
    this._showInlineDecorations = settings.showInlineDecorations;
    return this._ignorePatterns;
  }
  /**
   * Sync tracked files with current ignore rules.
   * - Removes baselines for files that are now ignored.
   * - Snapshots files newly allowed by current rules but not yet tracked.
   * Called after ignorePatterns / respectGitignore / .gitignore changes.
   */
  async syncIgnoreState(shouldIgnore) {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;
    const collect = async (dir) => {
      let results = [];
      let entries;
      try {
        entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = normalizePath(path2.join(dir, entry.name));
        const isDir = entry.isDirectory();
        if (shouldIgnore(full, isDir)) continue;
        if (isDir) {
          results = results.concat(await collect(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    };
    const [allowedFiles, trackedFiles] = await Promise.all([
      collect(this.workspaceRoot),
      g.listTrackedFiles()
    ]);
    const allowedSet = new Set(allowedFiles);
    const toRemove = trackedFiles.filter((fp) => !allowedSet.has(fp));
    for (const fp of this.state.keys()) {
      if (!allowedSet.has(fp) && !toRemove.includes(fp)) {
        this.state.delete(fp);
      }
    }
    if (toRemove.length > 0) {
      log(`syncIgnoreState: removing ${toRemove.length} file(s): ${logFileList(toRemove, this.workspaceRoot)}`);
    }
    for (const fp of toRemove) {
      this.state.delete(fp);
    }
    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch((err) => {
        log(`git queue error: ${err}`);
      });
    }
    const trackedSet = new Set(trackedFiles);
    for (const fp of this.state.keys()) trackedSet.add(fp);
    const toAdd = allowedFiles.filter((fp) => !trackedSet.has(fp));
    if (toAdd.length > 0) {
      log(`syncIgnoreState: adding ${toAdd.length} file(s): ${logFileList(toAdd, this.workspaceRoot)}`);
    }
    if (toAdd.length > 0) {
      const batch = [];
      await Promise.all(toAdd.map(async (fp) => {
        try {
          const content = await fs2.promises.readFile(fp, "utf-8");
          batch.push({ filePath: fp, content });
        } catch {
        }
      }));
      if (batch.length > 0) {
        this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch((err) => {
          log(`git queue error: ${err}`);
        });
      }
    }
    await this.gitQueue;
  }
  /**
   * Called on branch switch when clearOnBranchSwitch is enabled.
   * Clears all reviewing state, re-snapshots every tracked file to the current
   * disk content, and removes baselines for files that no longer exist.
   * This must be called while FileWatcher events are suppressed so that
   * git-checkout-induced file changes don't race with the clear.
   */
  async clearHunksOnBranchSwitch(shouldIgnore) {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;
    const reviewingCount = Array.from(this.state.values()).filter((s) => s.status === "reviewing").length;
    log(`clearHunksOnBranchSwitch: clearing ${reviewingCount} reviewing file(s), re-syncing all baselines`);
    this.state.clear();
    const collect = async (dir) => {
      let results = [];
      let entries;
      try {
        entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = normalizePath(path2.join(dir, entry.name));
        const isDir = entry.isDirectory();
        if (shouldIgnore?.(full, isDir)) continue;
        if (isDir) {
          results = results.concat(await collect(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    };
    const [diskFiles, trackedFiles] = await Promise.all([
      collect(this.workspaceRoot),
      g.listTrackedFiles()
    ]);
    const diskSet = new Set(diskFiles);
    const batch = [];
    await Promise.all(diskFiles.map(async (fp) => {
      try {
        const content = await fs2.promises.readFile(fp, "utf-8");
        batch.push({ filePath: fp, content });
      } catch {
      }
    }));
    const toRemove = trackedFiles.filter((fp) => !diskSet.has(fp));
    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch((err) => {
        log(`git queue error: ${err}`);
      });
    }
    if (batch.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch((err) => {
        log(`git queue error: ${err}`);
      });
    }
    await this.gitQueue;
  }
  /**
   * Reset extension to disabled state (called when hunkwiseDir is deleted externally).
   */
  resetToDisabled() {
    this._enabled = false;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    this._useDiffEditor = false;
    this._showInlineDecorations = true;
    this.state.clear();
    this._git = void 0;
    this.gitQueue = Promise.resolve();
  }
  /** Wait for all pending git operations to complete. Call on deactivate. */
  async flush() {
    await this.gitQueue;
  }
  /** Cancel any pending saves (no-op now, kept for API compatibility). */
  cancelPendingSave() {
  }
};

// src/fileWatcher.ts
var vscode3 = __toESM(require("vscode"));
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));

// node_modules/diff/lib/index.mjs
function Diff() {
}
Diff.prototype = {
  diff: function diff(oldString, newString) {
    var _options$timeout;
    var options = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
    var callback = options.callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    this.options = options;
    var self = this;
    function done(value) {
      if (callback) {
        setTimeout(function() {
          callback(void 0, value);
        }, 0);
        return true;
      } else {
        return value;
      }
    }
    oldString = this.castInput(oldString);
    newString = this.castInput(newString);
    oldString = this.removeEmpty(this.tokenize(oldString));
    newString = this.removeEmpty(this.tokenize(newString));
    var newLen = newString.length, oldLen = oldString.length;
    var editLength = 1;
    var maxEditLength = newLen + oldLen;
    if (options.maxEditLength) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    var maxExecutionTime = (_options$timeout = options.timeout) !== null && _options$timeout !== void 0 ? _options$timeout : Infinity;
    var abortAfterTimestamp = Date.now() + maxExecutionTime;
    var bestPath = [{
      oldPos: -1,
      lastComponent: void 0
    }];
    var newPos = this.extractCommon(bestPath[0], newString, oldString, 0);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done([{
        value: this.join(newString),
        count: newString.length
      }]);
    }
    var minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    function execEditLength() {
      for (var diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        var basePath = void 0;
        var removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = void 0;
        }
        var canAdd = false;
        if (addPath) {
          var addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        var canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = void 0;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos + 1 < addPath.oldPos) {
          basePath = self.addToPath(addPath, true, void 0, 0);
        } else {
          basePath = self.addToPath(removePath, void 0, true, 1);
        }
        newPos = self.extractCommon(basePath, newString, oldString, diagonalPath);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(buildValues(self, basePath.lastComponent, newString, oldString, self.useLongestToken));
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    }
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback();
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        var ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  },
  addToPath: function addToPath(path8, added, removed, oldPosInc) {
    var last = path8.lastComponent;
    if (last && last.added === added && last.removed === removed) {
      return {
        oldPos: path8.oldPos + oldPosInc,
        lastComponent: {
          count: last.count + 1,
          added,
          removed,
          previousComponent: last.previousComponent
        }
      };
    } else {
      return {
        oldPos: path8.oldPos + oldPosInc,
        lastComponent: {
          count: 1,
          added,
          removed,
          previousComponent: last
        }
      };
    }
  },
  extractCommon: function extractCommon(basePath, newString, oldString, diagonalPath) {
    var newLen = newString.length, oldLen = oldString.length, oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(newString[newPos + 1], oldString[oldPos + 1])) {
      newPos++;
      oldPos++;
      commonCount++;
    }
    if (commonCount) {
      basePath.lastComponent = {
        count: commonCount,
        previousComponent: basePath.lastComponent
      };
    }
    basePath.oldPos = oldPos;
    return newPos;
  },
  equals: function equals(left, right) {
    if (this.options.comparator) {
      return this.options.comparator(left, right);
    } else {
      return left === right || this.options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  },
  removeEmpty: function removeEmpty(array) {
    var ret = [];
    for (var i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  },
  castInput: function castInput(value) {
    return value;
  },
  tokenize: function tokenize(value) {
    return value.split("");
  },
  join: function join3(chars) {
    return chars.join("");
  }
};
function buildValues(diff2, lastComponent, newString, oldString, useLongestToken) {
  var components = [];
  var nextComponent;
  while (lastComponent) {
    components.push(lastComponent);
    nextComponent = lastComponent.previousComponent;
    delete lastComponent.previousComponent;
    lastComponent = nextComponent;
  }
  components.reverse();
  var componentPos = 0, componentLen = components.length, newPos = 0, oldPos = 0;
  for (; componentPos < componentLen; componentPos++) {
    var component = components[componentPos];
    if (!component.removed) {
      if (!component.added && useLongestToken) {
        var value = newString.slice(newPos, newPos + component.count);
        value = value.map(function(value2, i) {
          var oldValue = oldString[oldPos + i];
          return oldValue.length > value2.length ? oldValue : value2;
        });
        component.value = diff2.join(value);
      } else {
        component.value = diff2.join(newString.slice(newPos, newPos + component.count));
      }
      newPos += component.count;
      if (!component.added) {
        oldPos += component.count;
      }
    } else {
      component.value = diff2.join(oldString.slice(oldPos, oldPos + component.count));
      oldPos += component.count;
      if (componentPos && components[componentPos - 1].added) {
        var tmp = components[componentPos - 1];
        components[componentPos - 1] = components[componentPos];
        components[componentPos] = tmp;
      }
    }
  }
  var finalComponent = components[componentLen - 1];
  if (componentLen > 1 && typeof finalComponent.value === "string" && (finalComponent.added || finalComponent.removed) && diff2.equals("", finalComponent.value)) {
    components[componentLen - 2].value += finalComponent.value;
    components.pop();
  }
  return components;
}
var characterDiff = new Diff();
var extendedWordChars = /^[A-Za-z\xC0-\u02C6\u02C8-\u02D7\u02DE-\u02FF\u1E00-\u1EFF]+$/;
var reWhitespace = /\S/;
var wordDiff = new Diff();
wordDiff.equals = function(left, right) {
  if (this.options.ignoreCase) {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  return left === right || this.options.ignoreWhitespace && !reWhitespace.test(left) && !reWhitespace.test(right);
};
wordDiff.tokenize = function(value) {
  var tokens = value.split(/([^\S\r\n]+|[()[\]{}'"\r\n]|\b)/);
  for (var i = 0; i < tokens.length - 1; i++) {
    if (!tokens[i + 1] && tokens[i + 2] && extendedWordChars.test(tokens[i]) && extendedWordChars.test(tokens[i + 2])) {
      tokens[i] += tokens[i + 2];
      tokens.splice(i + 1, 2);
      i--;
    }
  }
  return tokens;
};
var lineDiff = new Diff();
lineDiff.tokenize = function(value) {
  if (this.options.stripTrailingCr) {
    value = value.replace(/\r\n/g, "\n");
  }
  var retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (var i = 0; i < linesAndNewlines.length; i++) {
    var line = linesAndNewlines[i];
    if (i % 2 && !this.options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      if (this.options.ignoreWhitespace) {
        line = line.trim();
      }
      retLines.push(line);
    }
  }
  return retLines;
};
function diffLines(oldStr, newStr, callback) {
  return lineDiff.diff(oldStr, newStr, callback);
}
var sentenceDiff = new Diff();
sentenceDiff.tokenize = function(value) {
  return value.split(/(\S.+?[.!?])(?=\s+|$)/);
};
var cssDiff = new Diff();
cssDiff.tokenize = function(value) {
  return value.split(/([{}:;,]|\s+)/);
};
function _typeof(obj) {
  "@babel/helpers - typeof";
  if (typeof Symbol === "function" && typeof Symbol.iterator === "symbol") {
    _typeof = function(obj2) {
      return typeof obj2;
    };
  } else {
    _typeof = function(obj2) {
      return obj2 && typeof Symbol === "function" && obj2.constructor === Symbol && obj2 !== Symbol.prototype ? "symbol" : typeof obj2;
    };
  }
  return _typeof(obj);
}
var objectPrototypeToString = Object.prototype.toString;
var jsonDiff = new Diff();
jsonDiff.useLongestToken = true;
jsonDiff.tokenize = lineDiff.tokenize;
jsonDiff.castInput = function(value) {
  var _this$options = this.options, undefinedReplacement = _this$options.undefinedReplacement, _this$options$stringi = _this$options.stringifyReplacer, stringifyReplacer = _this$options$stringi === void 0 ? function(k, v) {
    return typeof v === "undefined" ? undefinedReplacement : v;
  } : _this$options$stringi;
  return typeof value === "string" ? value : JSON.stringify(canonicalize(value, null, null, stringifyReplacer), stringifyReplacer, "  ");
};
jsonDiff.equals = function(left, right) {
  return Diff.prototype.equals.call(jsonDiff, left.replace(/,([\r\n])/g, "$1"), right.replace(/,([\r\n])/g, "$1"));
};
function canonicalize(obj, stack, replacementStack, replacer, key) {
  stack = stack || [];
  replacementStack = replacementStack || [];
  if (replacer) {
    obj = replacer(key, obj);
  }
  var i;
  for (i = 0; i < stack.length; i += 1) {
    if (stack[i] === obj) {
      return replacementStack[i];
    }
  }
  var canonicalizedObj;
  if ("[object Array]" === objectPrototypeToString.call(obj)) {
    stack.push(obj);
    canonicalizedObj = new Array(obj.length);
    replacementStack.push(canonicalizedObj);
    for (i = 0; i < obj.length; i += 1) {
      canonicalizedObj[i] = canonicalize(obj[i], stack, replacementStack, replacer, key);
    }
    stack.pop();
    replacementStack.pop();
    return canonicalizedObj;
  }
  if (obj && obj.toJSON) {
    obj = obj.toJSON();
  }
  if (_typeof(obj) === "object" && obj !== null) {
    stack.push(obj);
    canonicalizedObj = {};
    replacementStack.push(canonicalizedObj);
    var sortedKeys = [], _key;
    for (_key in obj) {
      if (obj.hasOwnProperty(_key)) {
        sortedKeys.push(_key);
      }
    }
    sortedKeys.sort();
    for (i = 0; i < sortedKeys.length; i += 1) {
      _key = sortedKeys[i];
      canonicalizedObj[_key] = canonicalize(obj[_key], stack, replacementStack, replacer, _key);
    }
    stack.pop();
    replacementStack.pop();
  } else {
    canonicalizedObj = obj;
  }
  return canonicalizedObj;
}
var arrayDiff = new Diff();
arrayDiff.tokenize = function(value) {
  return value.slice();
};
arrayDiff.join = arrayDiff.removeEmpty = function(value) {
  return value;
};

// src/diffEngine.ts
function hunkId(hunk) {
  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}`;
}
function computeHunks(baseline, current) {
  const changes = diffLines(baseline ?? "", current);
  const hunks = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      const lineCount = change.count ?? 0;
      oldLine += lineCount;
      newLine += lineCount;
      i++;
      continue;
    }
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const removed = [];
    const added = [];
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const c = changes[i];
      const lines = c.value.endsWith("\n") ? c.value.slice(0, -1).split("\n") : c.value.split("\n");
      if (c.removed) {
        removed.push(...lines);
        oldLine += lines.length;
      } else if (c.added) {
        added.push(...lines);
        newLine += lines.length;
      }
      i++;
    }
    if (removed.length > 0 || added.length > 0) {
      hunks.push({
        oldStart: hunkOldStart,
        oldLines: removed.length,
        newStart: hunkNewStart,
        newLines: added.length,
        removedContent: removed,
        addedContent: added
      });
    }
  }
  return hunks;
}

// src/fileWatcher.ts
var ignoreLib = require_ignore();
function prefixGitignoreRules(content, prefix) {
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const neg = trimmed.startsWith("!");
    let pattern = neg ? trimmed.slice(1) : trimmed;
    if (pattern.startsWith("/")) {
      pattern = prefix + pattern;
    } else if (!pattern.includes("/") || pattern.endsWith("/") && !pattern.slice(0, -1).includes("/")) {
      pattern = prefix + "/**/" + pattern;
    } else {
      pattern = prefix + "/" + pattern;
    }
    return (neg ? "!" : "") + pattern;
  }).join("\n");
}
var FileWatcher = class {
  constructor(stateManager, onStateChanged, onIgnoreRulesChanged) {
    this.stateManager = stateManager;
    this.disposables = [];
    this.selfEditFiles = /* @__PURE__ */ new Set();
    // Files being deleted by the user via VSCode (explorer / applyEdit)
    this.pendingUserDeletes = /* @__PURE__ */ new Set();
    // Old paths of in-progress user renames — suppress onDiskDelete without extra git ops
    this.pendingRenameOldPaths = /* @__PURE__ */ new Set();
    this.debounceTimers = /* @__PURE__ */ new Map();
    // Compiled ignore instance from workspace .gitignore
    this.gitignoreMatcher = ignoreLib();
    // When true, all file-system events are suppressed (used during branch switch)
    this._suppressed = false;
    this.onStateChanged = onStateChanged;
    this.onIgnoreRulesChanged = onIgnoreRulesChanged;
  }
  register(context) {
    this.loadGitignore();
    const gitignoreWatcher = vscode3.workspace.createFileSystemWatcher("**/.gitignore");
    gitignoreWatcher.onDidChange(() => {
      this.loadGitignore();
      this.onIgnoreRulesChanged?.();
    });
    gitignoreWatcher.onDidCreate(() => {
      this.loadGitignore();
      this.onIgnoreRulesChanged?.();
    });
    gitignoreWatcher.onDidDelete(() => {
      this.loadGitignore();
      this.onIgnoreRulesChanged?.();
    });
    this.disposables.push(gitignoreWatcher);
    const watcher = vscode3.workspace.createFileSystemWatcher("**/*");
    watcher.onDidChange((uri) => this.onDiskChange(uri));
    watcher.onDidDelete((uri) => this.onDiskDelete(uri));
    watcher.onDidCreate((uri) => this.onDiskCreate(uri));
    this.disposables.push(watcher);
    this.disposables.push(
      vscode3.workspace.onWillDeleteFiles((e) => {
        for (const uri of e.files) {
          this.pendingUserDeletes.add(normalizePath(uri.fsPath));
        }
      }),
      vscode3.workspace.onDidDeleteFiles((e) => {
        setTimeout(() => {
          for (const uri of e.files) {
            this.pendingUserDeletes.delete(normalizePath(uri.fsPath));
          }
        }, 500);
      }),
      // onWillRenameFiles fires BEFORE the actual rename. Record paths so
      // the subsequent onDiskDelete/onDiskCreate events are suppressed, and
      // migrate state+git. UI refresh is deferred to onDidRenameFiles because
      // the new file doesn't exist on disk yet when onWill fires.
      vscode3.workspace.onWillRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          const oldPath = normalizePath(oldUri.fsPath);
          const newPath = normalizePath(newUri.fsPath);
          if (!this.stateManager.enabled) continue;
          log(`rename: ${path3.basename(oldPath)} \u2192 ${path3.basename(newPath)}`);
          this.pendingRenameOldPaths.add(oldPath);
          this.selfEditFiles.add(newPath);
          this.stateManager.renameFile(oldPath, newPath);
        }
      }),
      vscode3.workspace.onDidRenameFiles((e) => {
        let needsRefresh = false;
        for (const { oldUri, newUri } of e.files) {
          this.pendingRenameOldPaths.delete(normalizePath(oldUri.fsPath));
          this.selfEditFiles.delete(normalizePath(newUri.fsPath));
          if (this.stateManager.getFile(normalizePath(newUri.fsPath))) {
            needsRefresh = true;
          }
        }
        if (needsRefresh) this.onStateChanged();
      })
    );
    const docChange = vscode3.workspace.onDidChangeTextDocument((e) => {
      this.onDocumentChange(e);
    });
    this.disposables.push(docChange);
    context.subscriptions.push(...this.disposables);
  }
  loadGitignore() {
    const rootPath = vscode3.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.gitignoreMatcher = ignoreLib();
    if (!rootPath) return;
    try {
      const { execFileSync } = require("child_process");
      const globalPath = execFileSync("git", ["config", "--global", "core.excludesfile"], {
        encoding: "utf-8",
        timeout: 3e3
      }).trim();
      if (globalPath) {
        const resolved = globalPath.startsWith("~") ? path3.join(require("os").homedir(), globalPath.slice(1)) : globalPath;
        try {
          this.gitignoreMatcher.add(fs3.readFileSync(resolved, "utf-8"));
        } catch {
        }
      }
    } catch {
      try {
        const defaultPath = path3.join(require("os").homedir(), ".config", "git", "ignore");
        this.gitignoreMatcher.add(fs3.readFileSync(defaultPath, "utf-8"));
      } catch {
      }
    }
    this.collectGitignores(rootPath, rootPath);
  }
  /**
   * Recursively collect .gitignore files starting from `dir`.
   * Skips directories already ignored by the current matcher state.
   */
  collectGitignores(dir, rootPath) {
    const gitignorePath = path3.join(dir, ".gitignore");
    try {
      const content = fs3.readFileSync(gitignorePath, "utf-8");
      if (dir === rootPath) {
        this.gitignoreMatcher.add(content);
      } else {
        const prefix = path3.relative(rootPath, dir).replace(/\\/g, "/");
        this.gitignoreMatcher.add(prefixGitignoreRules(content, prefix));
      }
    } catch {
    }
    let entries;
    try {
      entries = fs3.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path3.join(dir, entry.name);
      const rel = path3.relative(rootPath, full).replace(/\\/g, "/");
      if (this.gitignoreMatcher.ignores(rel + "/")) continue;
      this.collectGitignores(full, rootPath);
    }
  }
  /** Suppress all file-system event handling (used during branch switch). */
  suppressAll() {
    this._suppressed = true;
  }
  /** Resume file-system event handling after branch switch completes. */
  resumeAll() {
    this._suppressed = false;
  }
  markSelfEdit(filePath) {
    this.selfEditFiles.add(normalizePath(filePath));
  }
  clearSelfEdit(filePath) {
    this.selfEditFiles.delete(normalizePath(filePath));
  }
  shouldIgnore(filePath, isDirectory) {
    if (!filePath) return false;
    const hunkwiseDir = this.stateManager.dir;
    if (hunkwiseDir && filePath.startsWith(hunkwiseDir + path3.sep)) return true;
    if (hunkwiseDir && filePath === hunkwiseDir) return true;
    const rootPath = vscode3.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return false;
    let relPath = "";
    try {
      relPath = vscode3.workspace.asRelativePath(vscode3.Uri.file(filePath), false) || "";
    } catch {
      relPath = "";
    }
    if (!relPath) {
      try {
        relPath = path3.relative(rootPath, filePath);
      } catch {
        relPath = "";
      }
    }
    relPath = relPath.replace(/\\/g, "/");
    if (!relPath || relPath === ".") return false;
    if (relPath.startsWith("..")) return false;
    if (isDirectory) relPath += "/";
    const userMatcher = ignoreLib().add(this.stateManager.ignorePatterns);
    if (userMatcher.ignores(relPath)) return true;
    if (this.stateManager.respectGitignore && this.gitignoreMatcher.ignores(relPath)) return true;
    return false;
  }
  async onDiskCreate(uri) {
    const filePath = normalizePath(uri.fsPath);
    const basename5 = path3.basename(filePath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;
    const fileState = this.stateManager.getFile(filePath);
    log(`onDiskCreate(${basename5}): fileState=${fileState ? `{status:${fileState.status}, baseline.len:${fileState.baseline?.length ?? "null"}}` : "undefined"}`);
    if (fileState?.status === "reviewing") {
      let diskContent2;
      try {
        diskContent2 = await fs3.promises.readFile(filePath, "utf-8");
      } catch {
        log(`onDiskCreate(${basename5}): read failed while reviewing, skip`);
        return;
      }
      log(`onDiskCreate(${basename5}): reviewing, recompute hunks (baseline.len=${fileState.baseline?.length ?? "null"}, disk.len=${diskContent2.length})`);
      this.recomputeHunks(filePath, fileState.baseline, diskContent2);
      return;
    }
    if (fileState) {
      log(`onDiskCreate(${basename5}): has fileState but not reviewing, skip`);
      return;
    }
    const git = this.stateManager.git;
    if (!git) {
      log(`onDiskCreate(${basename5}): no git, skip`);
      return;
    }
    let diskContent;
    try {
      diskContent = await fs3.promises.readFile(filePath, "utf-8");
    } catch {
      log(`onDiskCreate(${basename5}): read failed, skip`);
      return;
    }
    const gitBaseline = await git.getBaseline(filePath);
    log(`onDiskCreate(${basename5}): gitBaseline=${gitBaseline !== void 0 ? `'${gitBaseline.length} chars'` : "undefined"}`);
    if (gitBaseline !== void 0) {
      log(`onDiskCreate(${basename5}): has baseline, enterReviewing as change`);
      this.enterReviewing(filePath, gitBaseline, diskContent);
      return;
    }
    const openDoc = vscode3.workspace.textDocuments.find((d) => normalizePath(d.uri.fsPath) === filePath);
    const bufferMatch = openDoc ? openDoc.getText() === diskContent : false;
    log(`onDiskCreate(${basename5}): openDoc=${!!openDoc}, bufferMatch=${bufferMatch}`);
    if (openDoc && bufferMatch) {
      log(`onDiskCreate(${basename5}): buffer matches disk, snapshot as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }
    log(`onDiskCreate(${basename5}): external create, enterReviewing as NEW`);
    this.enterReviewing(filePath, null, diskContent);
  }
  async onDiskDelete(uri) {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    const filePath = normalizePath(uri.fsPath);
    const basename5 = path3.basename(filePath);
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;
    const fileState = this.stateManager.getFile(filePath);
    const git = this.stateManager.git;
    if (this.pendingRenameOldPaths.has(filePath)) {
      this.pendingRenameOldPaths.delete(filePath);
      log(`onDiskDelete(${basename5}): rename old path, skip`);
      return;
    }
    if (this.pendingUserDeletes.has(filePath)) {
      this.pendingUserDeletes.delete(filePath);
      log(`onDiskDelete(${basename5}): user delete, removeFile`);
      this.stateManager.removeFile(filePath);
      const dirPrefix = filePath + path3.sep;
      let needsRefresh = !!fileState;
      for (const [childPath] of this.stateManager.getAllFiles()) {
        if (childPath.startsWith(dirPrefix)) {
          this.stateManager.removeFile(childPath);
          needsRefresh = true;
        }
      }
      if (needsRefresh) {
        this.onStateChanged();
      }
      return;
    }
    if (!git) {
      log(`onDiskDelete(${basename5}): no git, skip`);
      return;
    }
    if (fileState?.baseline === null) {
      log(`onDiskDelete(${basename5}): new file (null baseline) deleted, removing fileState`);
      this.stateManager.exitReviewing(filePath);
      this.onStateChanged();
      return;
    }
    const gitBaseline = fileState?.baseline ?? await git.getBaseline(filePath);
    log(`onDiskDelete(${basename5}): external delete, gitBaseline=${gitBaseline !== void 0 ? `'${gitBaseline.length} chars'` : "undefined"}`);
    if (gitBaseline === void 0) {
      if (fileState) {
        log(`onDiskDelete(${basename5}): no baseline, removing fileState`);
        this.stateManager.removeFile(filePath);
        this.onStateChanged();
      }
      const dirPrefix = filePath + path3.sep;
      const allFiles = this.stateManager.getAllFiles();
      let childrenCleaned = 0;
      for (const [childPath, childState] of allFiles) {
        if (!childPath.startsWith(dirPrefix)) continue;
        if (childState.baseline === null) {
          this.stateManager.exitReviewing(childPath);
        } else {
          this.enterReviewing(childPath, childState.baseline, "");
        }
        childrenCleaned++;
      }
      if (childrenCleaned > 0) {
        log(`onDiskDelete(${basename5}): cleaned ${childrenCleaned} child file(s) from deleted directory`);
        this.onStateChanged();
      }
      return;
    }
    this.enterReviewing(filePath, gitBaseline, "");
  }
  async onDiskChange(uri) {
    const filePath = normalizePath(uri.fsPath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;
    let diskContent;
    try {
      diskContent = await fs3.promises.readFile(filePath, "utf-8");
    } catch {
      return;
    }
    const fileState = this.stateManager.getFile(filePath);
    if (fileState?.status === "reviewing") {
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
      return;
    }
    const git = this.stateManager.git;
    if (!git) return;
    const openDoc = vscode3.workspace.textDocuments.find((d) => normalizePath(d.uri.fsPath) === filePath);
    if (openDoc && openDoc.getText() === diskContent) {
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }
    const gitBaseline = await git.getBaseline(filePath);
    if (gitBaseline === void 0) {
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }
    this.enterReviewing(filePath, gitBaseline, diskContent);
  }
  onDocumentChange(e) {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (e.document.uri.scheme !== "file") return;
    const filePath = normalizePath(e.document.uri.fsPath);
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;
    const fileState = this.stateManager.getFile(filePath);
    if (fileState?.status !== "reviewing") return;
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const latestState = this.stateManager.getFile(filePath);
      if (!latestState || latestState.status !== "reviewing") return;
      this.recomputeHunks(filePath, latestState.baseline, e.document.getText());
    }, 50);
    this.debounceTimers.set(filePath, timer);
  }
  enterReviewing(filePath, baseline, current) {
    const hunks = computeHunks(baseline, current);
    const isNew = baseline === null;
    const isDeleted = !fs3.existsSync(filePath) && baseline !== null;
    if (hunks.length === 0 && !isNew && !isDeleted) return;
    const tag = isNew ? " (new)" : isDeleted ? " (deleted)" : "";
    log(`reviewing: ${path3.basename(filePath)}${tag}`);
    this.stateManager.setFile(filePath, { status: "reviewing", baseline });
    this.onStateChanged();
  }
  recomputeHunks(filePath, baseline, current) {
    if (computeHunks(baseline, current).length === 0) {
      if (baseline === null && current === "") {
        this.onStateChanged();
        return;
      }
      this.stateManager.exitReviewing(filePath);
    }
    this.onStateChanged();
  }
  dispose() {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingUserDeletes.clear();
    this.pendingRenameOldPaths.clear();
    this.disposables.forEach((d) => d.dispose());
  }
};

// src/decorationManager.ts
var vscode4 = __toESM(require("vscode"));
var addedLineDecoration = vscode4.window.createTextEditorDecorationType({
  backgroundColor: new vscode4.ThemeColor("diffEditor.insertedLineBackground"),
  isWholeLine: true
});
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function buildDeletedHtml(lines, tabSize) {
  const rows = lines.map((l) => `<div class="line">${escapeHtml(l)}</div>`).join("");
  return `<!DOCTYPE html><html style="background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,0.1))"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1));
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: var(--vscode-editor-line-height, 1.5);
}
.line { white-space: pre; overflow: hidden; text-overflow: ellipsis; tab-size: ${tabSize}; }
</style>
</head><body>${rows}</body></html>`;
}
function buildActionsHtml(filePath, hunkId2) {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: visible; }
body { background: transparent; position: relative; }
.bar {
  position: absolute;
  top: 3px; left: 4px;
  display: flex; align-items: center; gap: 4px;
}
button {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
  border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
  border-radius: 2px;
  padding: 0 6px; font-size: 10px;
  font-family: var(--vscode-font-family, sans-serif);
  cursor: pointer; height: 20px; line-height: 1;
  display: inline-flex; align-items: center; white-space: nowrap;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.btn-accept {
  background: #2a7d3a;
  color: #d4f0da;
  border-color: rgba(63,185,80,0.3);
}
.btn-accept:hover { background: #256b31; }
.btn-discard {
  background: rgba(248,81,73,0.08);
  color: #c97d7a;
  border-color: rgba(248,81,73,0.25);
}
.btn-discard:hover { background: rgba(248,81,73,0.15); }
</style>
</head><body>
<div class="bar">
<button class="btn-accept" onclick="accept()">\u2713 Accept</button>
<button class="btn-discard" onclick="discard()">\u21BA Discard</button>
</div>
<script>
const vscode = acquireVsCodeApi();
function accept() { vscode.postMessage({ command: 'accept', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId2)} }); }
function discard() { vscode.postMessage({ command: 'discard', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId2)} }); }
</script>
</body></html>`;
}
function insetCacheKey(afterLine, height) {
  return `${afterLine}:${height}`;
}
var DecorationManager = class {
  constructor(stateManager, onAction) {
    this.stateManager = stateManager;
    // editorKey → ordered list of insets for that editor
    this.insets = /* @__PURE__ */ new Map();
    this.onAction = onAction;
  }
  refresh(editors) {
    const targets = editors ?? vscode4.window.visibleTextEditors;
    const diffPaths = this.diffEditorFilePaths();
    for (const editor of targets) {
      this.applyToEditor(editor, diffPaths);
    }
  }
  refreshActionBar(_editor) {
  }
  disposeInsetList(list) {
    for (const h of list) {
      h.disposeListener.dispose();
      h.disposable.dispose();
      if (!h.disposed) h.inset.dispose();
    }
  }
  /**
   * Collect file paths that are open in any diff tab (git, hunkwise, etc.).
   */
  diffEditorFilePaths() {
    const paths = /* @__PURE__ */ new Set();
    for (const group of vscode4.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode4.TabInputTextDiff) {
          paths.add(tab.input.modified.fsPath);
        }
      }
    }
    return paths;
  }
  applyToEditor(editor, diffPaths) {
    const filePath = editor.document.uri.fsPath;
    const editorKey = editor.document.uri.toString();
    const fileState = this.stateManager.getFile(filePath);
    const isInDiff = editor.viewColumn === void 0 && diffPaths.has(filePath);
    const skipInsets = isInDiff || !this.stateManager.showInlineDecorations;
    if (!fileState || fileState.status !== "reviewing" || skipInsets) {
      this.disposeInsetList(this.insets.get(editorKey) ?? []);
      this.insets.delete(editorKey);
      editor.setDecorations(addedLineDecoration, []);
      return;
    }
    const addedRanges = [];
    const tabSize = editor.options.tabSize || 4;
    const parsed = computeHunks(fileState.baseline, editor.document.getText());
    const specs = [];
    for (const hunk of parsed) {
      const id = hunkId(hunk);
      for (let i = 0; i < hunk.newLines; i++) {
        const lineIdx = hunk.newStart - 1 + i;
        if (lineIdx < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(lineIdx).range);
        }
      }
      const hasDeletion = hunk.removedContent.length > 0;
      const hasAddition = hunk.newLines > 0;
      const deletedAfterLine = hunk.newStart - 2;
      let actionAfterLine;
      if (hasAddition) {
        actionAfterLine = hunk.newStart + hunk.newLines - 2;
      } else {
        actionAfterLine = deletedAfterLine;
      }
      if (hasDeletion) {
        specs.push({
          afterLine: Math.max(-1, deletedAfterLine),
          height: hunk.removedContent.length,
          html: buildDeletedHtml(hunk.removedContent, tabSize)
        });
      }
      specs.push({
        afterLine: actionAfterLine,
        height: 2,
        html: buildActionsHtml(filePath, id)
      });
    }
    const existing = this.insets.get(editorKey) ?? [];
    const nextInsets = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const key = insetCacheKey(spec.afterLine, spec.height);
      const prev = existing[i];
      if (prev && prev.cacheKey === key && !prev.disposed) {
        prev.inset.webview.html = spec.html;
        nextInsets.push(prev);
        existing[i] = void 0;
      } else {
        const created = this.makeInset(editorKey, editor, spec.afterLine, spec.height, spec.html, key);
        if (created) nextInsets.push(created);
      }
    }
    for (const leftover of existing) {
      if (leftover) {
        leftover.disposeListener.dispose();
        leftover.disposable.dispose();
        if (!leftover.disposed) leftover.inset.dispose();
      }
    }
    editor.setDecorations(addedLineDecoration, addedRanges);
    if (nextInsets.length > 0) {
      this.insets.set(editorKey, nextInsets);
    } else {
      this.insets.delete(editorKey);
    }
  }
  makeInset(editorKey, editor, afterLine, height, html, cacheKey) {
    try {
      const inset = vscode4.window.createWebviewTextEditorInset(
        editor,
        afterLine,
        height,
        { enableScripts: true }
      );
      inset.webview.html = html;
      const disposable = inset.webview.onDidReceiveMessage((msg) => {
        if (msg.command === "accept" || msg.command === "discard") {
          this.onAction?.(msg.command, msg.filePath, msg.hunkId);
        }
      });
      const entry = {
        inset,
        disposable,
        cacheKey,
        disposed: false,
        disposeListener: inset.onDidDispose(() => {
          entry.disposed = true;
          const targetEditor = vscode4.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === editorKey
          );
          if (targetEditor) this.applyToEditor(targetEditor, this.diffEditorFilePaths());
        })
      };
      return entry;
    } catch (err) {
      log(`createWebviewTextEditorInset failed: ${err}`);
      return void 0;
    }
  }
  dispose() {
    addedLineDecoration.dispose();
    for (const list of this.insets.values()) {
      this.disposeInsetList(list);
    }
    this.insets.clear();
  }
};

// src/reviewPanel.ts
var vscode7 = __toESM(require("vscode"));
var path6 = __toESM(require("path"));
var fs6 = __toESM(require("fs"));

// src/commands.ts
var vscode6 = __toESM(require("vscode"));
var fs5 = __toESM(require("fs"));
var path5 = __toESM(require("path"));

// src/gitignoreManager.ts
var fs4 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
var vscode5 = __toESM(require("vscode"));
var HUNKWISE_ENTRY = ".vscode/hunkwise/";
var MARKER_COMMENT = "# hunkwise";
function getWorkspaceRoot() {
  return vscode5.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function upsertGitignore() {
  const root = getWorkspaceRoot();
  if (!root) return;
  const gitignorePath = path4.join(root, ".gitignore");
  let content = "";
  if (fs4.existsSync(gitignorePath)) {
    content = fs4.readFileSync(gitignorePath, "utf-8");
  }
  if (content.includes(HUNKWISE_ENTRY)) return;
  const entry = content.endsWith("\n") || content.length === 0 ? `${MARKER_COMMENT}
${HUNKWISE_ENTRY}
` : `
${MARKER_COMMENT}
${HUNKWISE_ENTRY}
`;
  fs4.writeFileSync(gitignorePath, content + entry, "utf-8");
}

// src/commands.ts
function registerCommands(context, stateManager, fileWatcher, reviewPanel, onStateChanged) {
  context.subscriptions.push(
    vscode6.commands.registerCommand(
      "hunkwise.enable",
      () => enableHunkwise(stateManager, fileWatcher, reviewPanel, onStateChanged)
    ),
    vscode6.commands.registerCommand(
      "hunkwise.disable",
      () => disableHunkwise(stateManager, onStateChanged)
    ),
    vscode6.commands.registerCommand("hunkwise.setIgnorePatterns", async (patterns) => {
      stateManager.setIgnorePatterns(patterns);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode6.commands.registerCommand("hunkwise.setRespectGitignore", async (value) => {
      stateManager.setRespectGitignore(value);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode6.commands.registerCommand("hunkwise.setClearOnBranchSwitch", (value) => {
      stateManager.setClearOnBranchSwitch(value);
    }),
    vscode6.commands.registerCommand("hunkwise.clearHunks", async () => {
      await stateManager.clearHunksOnBranchSwitch(
        (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
      );
      onStateChanged();
    })
  );
}
async function enableHunkwise(stateManager, fileWatcher, reviewPanel, onStateChanged) {
  log("enable");
  reviewPanel.setLoading(true);
  try {
    await Promise.all([
      new Promise((resolve) => setTimeout(resolve, 750)),
      (async () => {
        await stateManager.setEnabled(true);
        try {
          upsertGitignore();
        } catch (err) {
          log(`upsertGitignore failed: ${err}`);
        }
        await stateManager.snapshotWorkspace((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      })()
    ]);
  } finally {
    reviewPanel.setLoading(false);
  }
  onStateChanged();
}
async function disableHunkwise(stateManager, onStateChanged) {
  log("disable");
  stateManager.setEnabled(false);
  onStateChanged();
}
async function acceptAllFiles(stateManager, onStateChanged) {
  for (const filePath of Array.from(stateManager.getAllFiles().keys())) {
    acceptFileByPath(stateManager, filePath, () => {
    });
  }
  onStateChanged();
}
async function discardAllFiles(stateManager, fileWatcher, onStateChanged) {
  for (const [filePath] of Array.from(stateManager.getAllFiles().entries())) {
    try {
      await discardFileByPath(stateManager, fileWatcher, filePath, () => {
      });
    } catch (err) {
      log(`discardAllFiles: failed to restore ${filePath}: ${err}`);
    }
  }
  onStateChanged();
}
function acceptFileByPath(stateManager, filePath, onStateChanged) {
  if (!stateManager.getFile(filePath)) return;
  const basename5 = path5.basename(filePath);
  if (!fs5.existsSync(filePath)) {
    log(`acceptFileByPath(${basename5}): file not on disk, removeFile`);
    stateManager.removeFile(filePath);
  } else {
    const content = fs5.readFileSync(filePath, "utf-8");
    log(`acceptFileByPath(${basename5}): file exists, exitReviewing with content.len=${content.length}`);
    stateManager.exitReviewing(filePath, content);
  }
  onStateChanged();
}
async function discardFileByPath(stateManager, fileWatcher, filePath, onStateChanged) {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;
  fileWatcher.markSelfEdit(filePath);
  try {
    if (fileState.baseline === null) {
      if (fs5.existsSync(filePath)) {
        fs5.unlinkSync(filePath);
      }
    } else if (fileState.baseline === "" && fs5.existsSync(filePath)) {
      const uri = vscode6.Uri.file(filePath);
      const doc = await vscode6.workspace.openTextDocument(uri);
      const edit = new vscode6.WorkspaceEdit();
      const fullRange = new vscode6.Range(
        new vscode6.Position(0, 0),
        new vscode6.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, "");
      await vscode6.workspace.applyEdit(edit);
      await doc.save();
    } else if (!fs5.existsSync(filePath)) {
      fs5.mkdirSync(path5.dirname(filePath), { recursive: true });
      fs5.writeFileSync(filePath, fileState.baseline ?? "", "utf-8");
      await vscode6.window.showTextDocument(vscode6.Uri.file(filePath));
    } else {
      const uri = vscode6.Uri.file(filePath);
      const doc = await vscode6.workspace.openTextDocument(uri);
      const edit = new vscode6.WorkspaceEdit();
      const fullRange = new vscode6.Range(
        new vscode6.Position(0, 0),
        new vscode6.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline ?? "");
      await vscode6.workspace.applyEdit(edit);
      await doc.save();
    }
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
  if (fileState.baseline === null) {
    stateManager.removeFile(filePath);
  } else {
    stateManager.exitReviewing(filePath);
  }
  onStateChanged();
}
function acceptHunk(stateManager, filePath, id, onStateChanged, source = "unknown") {
  const basename5 = path5.basename(filePath);
  log(`acceptHunk(${basename5}): hunkId=${id}, source=${source}`);
  const fileState = stateManager.getFile(filePath);
  if (!fileState) {
    log(`acceptHunk(${basename5}): no fileState, skip`);
    return;
  }
  const doc = vscode6.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === filePath);
  if (!doc) {
    log(`acceptHunk(${basename5}): no doc found, skip`);
    return;
  }
  const baselineStr = fileState.baseline ?? "";
  log(`acceptHunk(${basename5}): doc.scheme=${doc.uri.scheme}, doc.len=${doc.getText().length}, baseline.len=${baselineStr.length}`);
  const hunks = computeHunks(fileState.baseline, doc.getText());
  log(`acceptHunk(${basename5}): total hunks=${hunks.length}`);
  const hunk = hunks.find((h) => hunkId(h) === id);
  if (!hunk) {
    log(`acceptHunk(${basename5}): hunk not found, skip`);
    return;
  }
  const originalNewStart = hunk.newStart;
  const currentLines = doc.getText().split("\n");
  const baselineLines = baselineStr.split("\n");
  const newBaseline = [
    ...baselineLines.slice(0, hunk.oldStart - 1),
    ...currentLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),
    ...baselineLines.slice(hunk.oldStart - 1 + hunk.oldLines)
  ].join("\n");
  const remainingHunks = computeHunks(newBaseline, doc.getText());
  log(`acceptHunk(${basename5}): remainingHunks=${remainingHunks.length}`);
  if (remainingHunks.length === 0) {
    log(`acceptHunk(${basename5}): last hunk, exitReviewing`);
    stateManager.exitReviewing(filePath, doc.getText());
  } else {
    stateManager.setFile(filePath, { status: "reviewing", baseline: newBaseline });
    revealNextHunk(filePath, remainingHunks, originalNewStart);
  }
  onStateChanged();
  log(`acceptHunk(${basename5}): done`);
}
function revealNextHunk(filePath, remainingHunks, originalNewStart) {
  const editor = vscode6.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
  if (!editor) return;
  const next = remainingHunks.find((h) => h.newStart >= originalNewStart) ?? remainingHunks[0];
  if (!next) return;
  const pos = new vscode6.Position(Math.max(0, next.newStart - 1), 0);
  editor.selection = new vscode6.Selection(pos, pos);
  editor.revealRange(new vscode6.Range(pos, pos), vscode6.TextEditorRevealType.InCenter);
}
async function discardHunk(stateManager, fileWatcher, filePath, id, onStateChanged, source = "unknown") {
  const basename5 = path5.basename(filePath);
  log(`discardHunk(${basename5}): hunkId=${id}, source=${source}`);
  const fileState = stateManager.getFile(filePath);
  if (!fileState) {
    log(`discardHunk(${basename5}): no fileState, skip`);
    return;
  }
  const uri = vscode6.Uri.file(filePath);
  const doc = await vscode6.workspace.openTextDocument(uri);
  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`discardHunk(${basename5}): total hunks=${allHunks.length}`);
  const hunk = allHunks.find((h) => hunkId(h) === id);
  if (!hunk) {
    log(`discardHunk(${basename5}): hunk not found, skip`);
    return;
  }
  const originalNewStart = hunk.newStart;
  const baselineStr = fileState.baseline ?? "";
  const baselineLines = baselineStr.split("\n");
  const originalLines = baselineLines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines);
  const startPos = new vscode6.Position(hunk.newStart - 1, 0);
  let endPos;
  if (hunk.newLines === 0) {
    endPos = startPos;
  } else {
    const lastNewLine = hunk.newStart - 1 + hunk.newLines - 1;
    endPos = lastNewLine < doc.lineCount - 1 ? new vscode6.Position(lastNewLine + 1, 0) : new vscode6.Position(lastNewLine, doc.lineAt(lastNewLine).text.length);
  }
  const replacement = originalLines.length > 0 ? originalLines.join("\n") + "\n" : "";
  log(`discardHunk(${basename5}): replacing lines ${startPos.line}-${endPos.line} with ${originalLines.length} original lines`);
  fileWatcher.markSelfEdit(filePath);
  try {
    const edit = new vscode6.WorkspaceEdit();
    edit.replace(uri, new vscode6.Range(startPos, endPos), replacement);
    const applied = await vscode6.workspace.applyEdit(edit);
    log(`discardHunk(${basename5}): applyEdit=${applied}`);
    if (!applied) {
      log(`discardHunk(${basename5}): applyEdit failed, aborting`);
      return;
    }
    const saved = vscode6.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === filePath);
    if (saved) await saved.save();
    log(`discardHunk(${basename5}): saved, doc.scheme=${saved?.uri.scheme ?? "N/A"}, doc.len=${saved?.getText().length ?? "N/A"}`);
    const currentText = saved?.getText() ?? doc.getText();
    const remainingHunks = computeHunks(fileState.baseline, currentText);
    log(`discardHunk(${basename5}): remainingHunks=${remainingHunks.length}`);
    if (remainingHunks.length === 0) {
      if (fileState.baseline === null && fs5.existsSync(filePath)) {
        log(`discardHunk(${basename5}): new file fully discarded, deleting`);
        try {
          fs5.unlinkSync(filePath);
        } catch (err) {
          log(`discardHunk(${basename5}): unlink failed: ${err}`);
        }
      }
      log(`discardHunk(${basename5}): no hunks left, exitReviewing`);
      stateManager.exitReviewing(filePath);
    } else {
      revealNextHunk(filePath, remainingHunks, originalNewStart);
    }
    onStateChanged();
    log(`discardHunk(${basename5}): done`);
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
}

// src/reviewPanel.ts
var ReviewPanel = class {
  constructor(context, stateManager, fileWatcher, onStateChanged, onBaselineChanged, onAfterHunkAction) {
    this.context = context;
    this.stateManager = stateManager;
    this.fileWatcher = fileWatcher;
    this.onStateChanged = onStateChanged;
    this.onBaselineChanged = onBaselineChanged;
    this.onAfterHunkAction = onAfterHunkAction;
    this._loading = false;
  }
  get loading() {
    return this._loading;
  }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode7.Uri.joinPath(this.context.extensionUri, "webview", "hunkwise_media")
      ]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "ready") {
        if (this._loading) {
          this.view?.webview.postMessage({ type: "loading", loading: true });
        } else {
          this.refresh();
        }
        return;
      }
      this.handleMessage(msg);
    });
  }
  refresh() {
    if (!this.view || this._loading) return;
    const state = this.buildPanelState();
    this.view.webview.postMessage({ type: "update", state });
  }
  setLoading(loading) {
    this._loading = loading;
    if (!this.view) return;
    if (loading) {
      this.view.webview.postMessage({ type: "loading", loading: true });
    } else {
      const state = this.buildPanelState();
      this.view.webview.postMessage({ type: "update", state });
    }
  }
  openSettings() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: "openSettings" });
  }
  buildPanelState() {
    const files = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const [filePath, fileState] of this.stateManager.getAllFiles()) {
      if (fileState.status !== "reviewing") continue;
      const fileExists = fs6.existsSync(filePath);
      let currentContent;
      if (!fileExists) {
        currentContent = "";
      } else {
        const doc = vscode7.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
        currentContent = doc ? doc.getText() : "";
        if (!doc) {
          try {
            currentContent = fs6.readFileSync(filePath, "utf-8");
          } catch {
            currentContent = "";
          }
        }
      }
      const pendingHunks = computeHunks(fileState.baseline, currentContent);
      const isNew = fileState.baseline === null;
      const isDeleted = !fileExists && fileState.baseline !== null;
      if (pendingHunks.length === 0 && !isNew && !isDeleted) continue;
      const addedLines = pendingHunks.reduce((s, h) => s + h.newLines, 0);
      const removedLines = pendingHunks.reduce((s, h) => s + h.oldLines, 0);
      totalAdded += addedLines;
      totalRemoved += removedLines;
      const workspaceFolders = vscode7.workspace.workspaceFolders;
      const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? "";
      const relPath = path6.relative(rootPath, filePath);
      const fileName = path6.basename(filePath);
      const dirName = path6.dirname(relPath) === "." ? "" : path6.dirname(relPath);
      files.push({
        filePath,
        fileName,
        dirName,
        addedLines,
        removedLines,
        pendingCount: pendingHunks.length,
        isNew,
        isDeleted,
        hunks: pendingHunks.map((h) => ({
          id: hunkId(h),
          filePath,
          newStart: h.newStart,
          newLines: h.newLines,
          oldLines: h.oldLines
        }))
      });
    }
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return {
      enabled: this.stateManager.enabled,
      ignorePatterns: this.stateManager.ignorePatterns,
      respectGitignore: this.stateManager.respectGitignore,
      clearOnBranchSwitch: this.stateManager.clearOnBranchSwitch,
      quoteRotationInterval: this.stateManager.quoteRotationInterval,
      useDiffEditor: this.stateManager.useDiffEditor,
      showInlineDecorations: this.stateManager.showInlineDecorations,
      totalFiles: files.length,
      totalAdded,
      totalRemoved,
      files
    };
  }
  async handleMessage(msg) {
    switch (msg.command) {
      case "enable":
        await vscode7.commands.executeCommand("hunkwise.enable");
        break;
      case "disable":
        await vscode7.commands.executeCommand("hunkwise.disable");
        break;
      case "setIgnorePatterns":
        if (msg.folders !== void 0) {
          await vscode7.commands.executeCommand("hunkwise.setIgnorePatterns", msg.folders);
        }
        break;
      case "setRespectGitignore":
        if (msg.value !== void 0) {
          await vscode7.commands.executeCommand("hunkwise.setRespectGitignore", msg.value);
        }
        break;
      case "setClearOnBranchSwitch":
        if (msg.value !== void 0) {
          this.stateManager.setClearOnBranchSwitch(msg.value);
        }
        break;
      case "setQuoteRotationInterval": {
        const interval = Number(msg.value);
        if (Number.isFinite(interval) && interval >= 0) {
          this.stateManager.setQuoteRotationInterval(interval);
          this.refresh();
        }
        break;
      }
      case "acceptAll":
        await acceptAllFiles(this.stateManager, this.onStateChanged);
        break;
      case "discardAll":
        await discardAllFiles(this.stateManager, this.fileWatcher, this.onStateChanged);
        break;
      case "acceptFile":
        if (msg.filePath) {
          acceptFileByPath(this.stateManager, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch((err) => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case "discardFile":
        if (msg.filePath) {
          await discardFileByPath(this.stateManager, this.fileWatcher, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch((err) => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case "acceptHunk":
        if (msg.filePath && msg.hunkId) {
          acceptHunk(this.stateManager, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            this.onBaselineChanged?.(msg.filePath);
            void this.onAfterHunkAction?.().catch((err) => log(`onAfterHunkAction: ${err}`));
          }, "panel");
        }
        break;
      case "discardHunk":
        if (msg.filePath && msg.hunkId) {
          await discardHunk(this.stateManager, this.fileWatcher, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch((err) => log(`onAfterHunkAction: ${err}`));
          }, "panel");
        }
        break;
      case "setUseDiffEditor":
        if (msg.value !== void 0) {
          this.stateManager.setUseDiffEditor(msg.value);
        }
        break;
      case "setShowInlineDecorations":
        if (msg.value !== void 0) {
          this.stateManager.setShowInlineDecorations(msg.value);
          this.onStateChanged();
        }
        break;
      case "openFile":
        if (msg.filePath) {
          log(`openFile(${path6.basename(msg.filePath)}): opening in ${this.stateManager.useDiffEditor ? "diffEditor" : "normalEditor"}`);
          if (this.stateManager.useDiffEditor) {
            await this.openDiffEditor(msg.filePath);
          } else {
            const fileState = this.stateManager.getFile(msg.filePath);
            const doc = await vscode7.window.showTextDocument(vscode7.Uri.file(msg.filePath));
            if (fileState) {
              const hunks = computeHunks(fileState.baseline, doc.document.getText());
              if (hunks.length > 0) {
                const pos = new vscode7.Position(Math.max(0, hunks[0].newStart - 1), 0);
                doc.selection = new vscode7.Selection(pos, pos);
                doc.revealRange(new vscode7.Range(pos, pos), vscode7.TextEditorRevealType.InCenter);
              }
            }
          }
        }
        break;
      case "openDeletedDiff":
        if (msg.filePath) {
          const fileName = path6.basename(msg.filePath);
          const baselineUri = vscode7.Uri.file(msg.filePath).with({ scheme: "hunkwise-baseline" });
          const emptyUri = vscode7.Uri.from({ scheme: "untitled", path: msg.filePath + ".deleted" });
          await vscode7.commands.executeCommand("vscode.diff", baselineUri, emptyUri, `${fileName} (deleted)`);
        }
        break;
      case "jumpToHunk":
        if (msg.filePath && msg.hunkId) {
          log(`jumpToHunk(${path6.basename(msg.filePath)}): hunkId=${msg.hunkId}, opening in ${this.stateManager.useDiffEditor ? "diffEditor" : "normalEditor"}`);
          if (this.stateManager.useDiffEditor) {
            await this.openDiffEditor(msg.filePath, msg.hunkId);
          } else {
            const fileState = this.stateManager.getFile(msg.filePath);
            if (fileState) {
              const doc = await vscode7.window.showTextDocument(vscode7.Uri.file(msg.filePath));
              const hunk = computeHunks(fileState.baseline, doc.document.getText()).find((h) => hunkId(h) === msg.hunkId);
              if (hunk) {
                const pos = new vscode7.Position(Math.max(0, hunk.newStart - 1), 0);
                doc.selection = new vscode7.Selection(pos, pos);
                doc.revealRange(new vscode7.Range(pos, pos), vscode7.TextEditorRevealType.InCenter);
              }
            }
          }
        }
        break;
    }
  }
  async openDiffEditor(filePath, targetHunkId) {
    const fileName = path6.basename(filePath);
    const baselineUri = vscode7.Uri.file(filePath).with({ scheme: "hunkwise-baseline" });
    const currentUri = vscode7.Uri.file(filePath);
    await vscode7.commands.executeCommand("vscode.diff", baselineUri, currentUri, `${fileName} (hunkwise)`);
    const fileState = this.stateManager.getFile(filePath);
    const candidates = vscode7.window.visibleTextEditors.filter(
      (e) => e.document.uri.scheme === "file" && e.document.uri.fsPath === filePath
    );
    const editor = candidates.find((e) => e.viewColumn === void 0) ?? candidates[0];
    if (fileState && editor) {
      const hunks = computeHunks(fileState.baseline, editor.document.getText());
      const target = targetHunkId ? hunks.find((h) => hunkId(h) === targetHunkId) : hunks[0];
      if (target) {
        const pos = new vscode7.Position(Math.max(0, target.newStart - 1), 0);
        editor.selection = new vscode7.Selection(pos, pos);
        editor.revealRange(new vscode7.Range(pos, pos), vscode7.TextEditorRevealType.InCenter);
      }
    }
  }
  getHtml(webview) {
    const mediaPath = vscode7.Uri.joinPath(this.context.extensionUri, "webview", "hunkwise_media");
    const cssUri = webview.asWebviewUri(vscode7.Uri.joinPath(mediaPath, "panel.css"));
    const jsUri = webview.asWebviewUri(vscode7.Uri.joinPath(mediaPath, "panel.js"));
    let html = fs6.readFileSync(
      path6.join(this.context.extensionUri.fsPath, "webview", "hunkwise_media", "panel.html"),
      "utf-8"
    );
    html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
    html = html.replace(/\{\{jsUri\}\}/g, jsUri.toString());
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    return html;
  }
};

// src/diffCodeLens.ts
var vscode8 = __toESM(require("vscode"));
var DiffCodeLensProvider = class {
  constructor(stateManager) {
    this.stateManager = stateManager;
    this._onDidChangeCodeLenses = new vscode8.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  }
  fire() {
    this._onDidChangeCodeLenses.fire();
  }
  dispose() {
    this._onDidChangeCodeLenses.dispose();
  }
  provideCodeLenses(document) {
    if (document.uri.scheme !== "file") return [];
    if (!this.stateManager.enabled) return [];
    if (!this.isActiveHunkwiseDiffTab(document.uri)) return [];
    if (this.hasVisibleNormalEditor(document.uri)) return [];
    const fileState = this.stateManager.getFile(document.uri.fsPath);
    if (!fileState || fileState.status !== "reviewing") return [];
    const hunks = computeHunks(fileState.baseline, document.getText());
    const lenses = [];
    for (const hunk of hunks) {
      const afterHunk = hunk.newStart - 1 + hunk.newLines;
      const line = Math.min(afterHunk, document.lineCount - 1);
      const range = new vscode8.Range(line, 0, line, 0);
      const id = hunkId(hunk);
      lenses.push(
        new vscode8.CodeLens(range, {
          title: "$(check) Accept",
          command: "hunkwise.codeLensAcceptHunk",
          arguments: [document.uri.fsPath, id]
        }),
        new vscode8.CodeLens(range, {
          title: "$(x) Discard",
          command: "hunkwise.codeLensDiscardHunk",
          arguments: [document.uri.fsPath, id]
        })
      );
    }
    return lenses;
  }
  hasVisibleNormalEditor(uri) {
    const fsPath = uri.fsPath;
    return vscode8.window.visibleTextEditors.some(
      (e) => e.document.uri.scheme === "file" && e.document.uri.fsPath === fsPath && e.viewColumn !== void 0
    );
  }
  isActiveHunkwiseDiffTab(uri) {
    const fsPath = uri.fsPath;
    for (const group of vscode8.window.tabGroups.all) {
      const active = group.activeTab;
      if (active?.input instanceof vscode8.TabInputTextDiff) {
        if (active.input.original.scheme === "hunkwise-baseline" && active.input.modified.fsPath === fsPath) {
          return true;
        }
      }
    }
    return false;
  }
};

// src/extension.ts
async function activate(context) {
  initLog();
  const ext = vscode9.extensions.getExtension("molon.hunkwise");
  log(`activate v${ext?.packageJSON?.version ?? "?"}`);
  const stateManager = new StateManager();
  stateManager.onRollback = () => onStateChanged();
  const baselineChangeEmitter = new vscode9.EventEmitter();
  context.subscriptions.push(
    baselineChangeEmitter,
    vscode9.workspace.registerTextDocumentContentProvider("hunkwise-baseline", {
      onDidChange: baselineChangeEmitter.event,
      provideTextDocumentContent(uri) {
        const filePath = uri.fsPath;
        const fileState = stateManager.getFile(filePath);
        return fileState?.baseline ?? "";
      }
    })
  );
  let decorationManager;
  let reviewPanel;
  let diffCodeLensProvider;
  function onStateChanged() {
    decorationManager?.refresh();
    reviewPanel?.refresh();
    diffCodeLensProvider?.fire();
  }
  function fireBaselineChange(filePath) {
    baselineChangeEmitter.fire(vscode9.Uri.file(filePath).with({ scheme: "hunkwise-baseline" }));
  }
  async function closeStaleTabs() {
    for (const group of vscode9.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode9.TabInputTextDiff && tab.input.original.scheme === "hunkwise-baseline") {
          const filePath = tab.input.modified.scheme === "file" ? tab.input.modified.fsPath : tab.input.original.fsPath;
          const fileState = stateManager.getFile(filePath);
          if (!fileState || fileState.status !== "reviewing") {
            await vscode9.window.tabGroups.close(tab);
            if (fs7.existsSync(filePath)) {
              await vscode9.window.showTextDocument(vscode9.Uri.file(filePath));
            }
          }
          continue;
        }
        if (tab.input instanceof vscode9.TabInputText) {
          const filePath = tab.input.uri.fsPath;
          if (tab.input.uri.scheme === "file" && !fs7.existsSync(filePath)) {
            const fileState = stateManager.getFile(filePath);
            if (!fileState || fileState.status !== "reviewing") {
              await vscode9.window.tabGroups.close(tab);
            }
          }
        }
      }
    }
  }
  let syncIgnore;
  const fileWatcher = new FileWatcher(stateManager, onStateChanged, () => syncIgnore());
  syncIgnore = () => stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)).then(onStateChanged);
  fileWatcher.register(context);
  fileWatcher.suppressAll();
  try {
    await stateManager.load((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
    log(`loaded state: enabled=${stateManager.enabled}, files=${stateManager.getAllFiles().size}`);
  } finally {
    fileWatcher.resumeAll();
  }
  decorationManager = new DecorationManager(stateManager, (command, filePath, hId) => {
    if (command === "accept") {
      acceptHunk(stateManager, filePath, hId, () => {
        onStateChanged();
        fireBaselineChange(filePath);
        void closeStaleTabs().catch((err) => log(`closeStaleTabs: ${err}`));
      }, "inset");
    } else {
      discardHunk(stateManager, fileWatcher, filePath, hId, () => {
        onStateChanged();
        void closeStaleTabs().catch((err) => log(`closeStaleTabs: ${err}`));
      }, "inset");
    }
  });
  context.subscriptions.push(
    vscode9.window.onDidChangeVisibleTextEditors((editors) => {
      decorationManager?.refresh(editors);
      diffCodeLensProvider?.fire();
    }),
    vscode9.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) decorationManager?.refresh([editor]);
      diffCodeLensProvider?.fire();
    }),
    vscode9.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      const editor = vscode9.window.visibleTextEditors.find(
        (ed) => ed.document.uri.fsPath === e.document.uri.fsPath
      );
      if (editor) decorationManager?.refresh([editor]);
      reviewPanel?.refresh();
    })
  );
  reviewPanel = new ReviewPanel(context, stateManager, fileWatcher, onStateChanged, fireBaselineChange, closeStaleTabs);
  context.subscriptions.push(
    vscode9.window.registerWebviewViewProvider("hunkwiseToolbar", reviewPanel)
  );
  registerCommands(context, stateManager, fileWatcher, reviewPanel, onStateChanged);
  diffCodeLensProvider = new DiffCodeLensProvider(stateManager);
  context.subscriptions.push(
    diffCodeLensProvider,
    vscode9.languages.registerCodeLensProvider({ scheme: "file" }, diffCodeLensProvider),
    vscode9.commands.registerCommand("hunkwise.codeLensAcceptHunk", (filePath, hId) => {
      acceptHunk(stateManager, filePath, hId, () => {
        onStateChanged();
        fireBaselineChange(filePath);
        void closeStaleTabs().catch((err) => log(`closeStaleTabs: ${err}`));
      }, "codeLens");
    }),
    vscode9.commands.registerCommand("hunkwise.codeLensDiscardHunk", (filePath, hId) => {
      discardHunk(stateManager, fileWatcher, filePath, hId, () => {
        onStateChanged();
        void closeStaleTabs().catch((err) => log(`closeStaleTabs: ${err}`));
      }, "codeLens");
    })
  );
  context.subscriptions.push(
    vscode9.commands.registerCommand("hunkwise.openSettings", () => {
      reviewPanel?.openSettings();
    }),
    vscode9.commands.registerCommand("hunkwise.refresh", async () => {
      if (!stateManager.enabled) return;
      reviewPanel?.setLoading(true);
      try {
        await stateManager.rebuildState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
        onStateChanged();
      } catch (err) {
        log(`refresh: error \u2014 ${err}`);
      } finally {
        reviewPanel?.setLoading(false);
      }
    })
  );
  if (stateManager.enabled) {
    reviewPanel.setLoading(true);
    log("startup sync: begin");
    Promise.all([
      new Promise((resolve) => setTimeout(resolve, 750)),
      stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir))
    ]).then(() => {
      log("startup sync: complete");
      reviewPanel?.setLoading(false);
      onStateChanged();
    }).catch((err) => {
      log(`startup sync: error \u2014 ${err}`);
      reviewPanel?.setLoading(false);
      onStateChanged();
    });
  } else {
    onStateChanged();
  }
  const hunkwiseDir = stateManager.dir;
  if (hunkwiseDir) {
    const gitDir = path7.join(hunkwiseDir, "git");
    let settingsWatcher;
    const startSettingsWatch = () => {
      if (!fs7.existsSync(hunkwiseDir)) return;
      try {
        settingsWatcher = fs7.watch(hunkwiseDir, { persistent: false }, (_eventType, filename) => {
          if (filename === "settings.json") {
            stateManager.reloadIgnorePatterns();
            syncIgnore();
          }
        });
      } catch (err) {
        log(`settings watch failed: ${err}`);
      }
    };
    const pollInterval = setInterval(() => {
      const gitExists = fs7.existsSync(gitDir);
      if (!gitExists && stateManager.enabled) {
        log("git dir deleted externally \u2014 resetting to disabled");
        settingsWatcher?.close();
        settingsWatcher = void 0;
        stateManager.resetToDisabled();
        onStateChanged();
      } else if (gitExists && stateManager.enabled && !settingsWatcher) {
        startSettingsWatch();
      }
    }, 1e3);
    startSettingsWatch();
    context.subscriptions.push({
      dispose: () => {
        clearInterval(pollInterval);
        settingsWatcher?.close();
      }
    });
  }
  const workspaceRoot = vscode9.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const gitHeadPath = path7.join(workspaceRoot, ".git", "HEAD");
    let lastHead;
    try {
      lastHead = fs7.readFileSync(gitHeadPath, "utf-8").trim();
    } catch {
    }
    if (lastHead !== void 0) {
      let headWatcher;
      const startHeadWatch = () => {
        headWatcher?.close();
        headWatcher = void 0;
        try {
          headWatcher = fs7.watch(gitHeadPath, { persistent: false }, () => {
            startHeadWatch();
            if (!stateManager.enabled || !stateManager.clearOnBranchSwitch) return;
            let currentHead;
            try {
              currentHead = fs7.readFileSync(gitHeadPath, "utf-8").trim();
            } catch {
              return;
            }
            if (currentHead !== lastHead) {
              lastHead = currentHead;
              log(`branch switched \u2192 suppressing file watcher and clearing hunks`);
              fileWatcher.suppressAll();
              stateManager.clearHunksOnBranchSwitch(
                (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
              ).then(() => {
                fileWatcher.resumeAll();
                onStateChanged();
              }).catch((err) => {
                log(`clearHunksOnBranchSwitch error: ${err}`);
                fileWatcher.resumeAll();
                onStateChanged();
              });
            }
          });
        } catch (err) {
          log(`HEAD watch failed: ${err}`);
        }
      };
      startHeadWatch();
      context.subscriptions.push({ dispose: () => headWatcher?.close() });
    }
  }
  context.subscriptions.push({
    dispose: () => {
      decorationManager?.dispose();
    }
  });
  activeStateManager = stateManager;
  activeReviewPanel = reviewPanel;
  activeFileWatcher = fileWatcher;
  return { getReviewPanel, getStateManager, getFileWatcher };
}
var activeStateManager;
var activeReviewPanel;
var activeFileWatcher;
function getReviewPanel() {
  return activeReviewPanel;
}
function getStateManager() {
  return activeStateManager;
}
function getFileWatcher() {
  return activeFileWatcher;
}
async function deactivate() {
  log("deactivate");
  await activeStateManager?.flush();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate,
  getFileWatcher,
  getReviewPanel,
  getStateManager
});
