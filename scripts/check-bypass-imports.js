#!/usr/bin/env node
// Defence in depth for the unit gate: modules that can reach the network without passing the in-process guard
// (child processes, workers, raw UDP) may only be loaded by the reviewed guard files in ALLOWED.
// Reads each file's syntax tree, so only real module loading counts: static import/export-from, import x = require(),
// require(), import() and jest.requireActual/requireMock. A quoted name in a comment or a string is ignored.
// Scans tracked AND untracked .ts/.js/.mjs/.cjs files, with or without the node: prefix.
// A computed module name is not found here; the kernel-isolated run (scripts/test-unit-isolated.sh) is the boundary for it.
// `--self-test` proves the check passes the reviewed files and fails on every forbidden form.
// Exit 0: clean. Exit 1: forbidden import(s). Exit 2: a directory or file could not be read, so the tree was NOT inspected;
// an unreadable source is never treated as a clean one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const FORBIDDEN = new Set(['child_process', 'worker_threads', 'cluster', 'dgram']);
// path:module pairs reviewed as test infrastructure. Anything else, including a new file next to them, fails.
const ALLOWED = ['test/setup/deny-network.ts:dgram', 'test/unit/network-guard.spec.ts:dgram'];
const SOURCE_FILE = /\.(ts|js|mjs|cjs)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.run-tmp']);
const MODULE_LOADERS = new Set(['requireActual', 'requireMock']);

const literalText = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);

const isModuleLoadingCall = (node) =>
  ts.isCallExpression(node) &&
  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
    (ts.isPropertyAccessExpression(node.expression) && MODULE_LOADERS.has(node.expression.name.text)));

const loadedModules = (file, text) => {
  const modules = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      modules.push(literalText(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      modules.push(literalText(node.moduleReference.expression));
    } else if (isModuleLoadingCall(node)) {
      modules.push(literalText(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return modules.filter((name) => name !== undefined).map((name) => name.replace(/^node:/, ''));
};

class UninspectedSourceError extends Error {}

// Every read goes through `io`, so a failed read becomes an UninspectedSourceError instead of an empty result.
const inspected = (what, target, read) => {
  try {
    return read();
  } catch (error) {
    throw new UninspectedSourceError(`could not ${what} ${target}: ${error.message}`);
  }
};

const sourceFiles = (root, io, directory = '') =>
  inspected('list', path.join(root, directory), () => io.readdirSync(path.join(root, directory), { withFileTypes: true })).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return directory === '' && SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(root, io, relative);
    return entry.isFile() && SOURCE_FILE.test(entry.name) ? [relative] : [];
  });

const scan = (root, allowed = ALLOWED, io = fs) =>
  sourceFiles(root, io).flatMap((file) =>
    loadedModules(
      file,
      inspected('read', path.join(root, file), () => io.readFileSync(path.join(root, file), 'utf8'))
    )
      .filter((name) => FORBIDDEN.has(name) && !allowed.includes(`${file}:${name}`))
      .map((name) => `forbidden import of '${name}' in ${file}: it bypasses the network guard`)
  );

// A filesystem that fails one chosen read, counting how often it did, so a control can prove the error really happened.
const failingIo = (failOn) => {
  const injected = { count: 0 };
  const fail = (operation, target) => {
    injected.count += 1;
    throw Object.assign(new Error(`EACCES: permission denied, ${operation} '${target}'`), { code: 'EACCES' });
  };
  return {
    injected,
    readdirSync: (target, options) =>
      failOn.directory && String(target).endsWith(failOn.directory) ? fail('scandir', target) : fs.readdirSync(target, options),
    readFileSync: (target, encoding) =>
      failOn.file && String(target).endsWith(failOn.file) ? fail('open', target) : fs.readFileSync(target, encoding),
  };
};

const selfTest = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-imports-'));
  const tree = path.join(tmp, 'tree');
  const fixture = (files = {}) => {
    fs.rmSync(tree, { recursive: true, force: true });
    const all = { ...Object.fromEntries(ALLOWED.map((entry) => [entry.split(':')[0], undefined])), ...files };
    for (const [file, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      // the reviewed files are copied from the real tree, so the test cannot drift from what the gate scans
      fs.writeFileSync(path.join(tree, file), content ?? fs.readFileSync(file, 'utf8'));
    }
  };
  const controls = [
    ['the reviewed guard files', {}, ALLOWED, false],
    ['the reviewed guard files with an empty allowlist', {}, [], true],
    ['a comment that quotes an import', { 'src/a.ts': "// Do not import 'node:dgram' here.\n" }, ALLOWED, false],
    ['a block comment that quotes a require', { 'src/a.ts': "/* const cp = require('child_process') */\n" }, ALLOWED, false],
    ['a string array of module names', { 'src/a.ts': "export const banned = ['child_process'];\n" }, ALLOWED, false],
    ['a string that looks like a require', { 'src/a.ts': 'export const text = "require(\'dgram\')";\n' }, ALLOWED, false],
    ['an unrelated module and a lookalike name', { 'src/a.ts': "import fs from 'node:fs'\nimport s from 'dgram-stream'\n" }, ALLOWED, false],
    ['node:dgram imported in src', { 'src/a.ts': "import dgram from 'node:dgram'\n" }, ALLOWED, true],
    ['a side-effect import', { 'src/a.ts': "import 'dgram'\n" }, ALLOWED, true],
    ['export-from', { 'src/a.ts': "export * from 'child_process'\n" }, ALLOWED, true],
    ['import = require', { 'src/a.ts': "import cp = require('child_process')\n" }, ALLOWED, true],
    ['require', { 'src/a.ts': "const { exec } = require('child_process')\n" }, ALLOWED, true],
    ['dynamic import', { 'src/a.ts': 'const w = await import("worker_threads")\n' }, ALLOWED, true],
    ['jest.requireActual', { 'test/a.spec.ts': "const cp = jest.requireActual('child_process')\n" }, ALLOWED, true],
    ['dgram without the node: prefix in a test', { 'test/unit/a.spec.ts': "import udp from 'dgram'\n" }, ALLOWED, true],
    ['a new file next to the reviewed guard', { 'test/setup/another.ts': "import dgram from 'node:dgram'\n" }, ALLOWED, true],
    ['cluster in plain JS', { 'src/a.js': "const c = require('node:cluster')\n" }, ALLOWED, true],
    ['an .mjs file', { 'src/a.mjs': 'import cp from "node:child_process"\n' }, ALLOWED, true],
  ];
  const wrongModule = [
    'another module added to a reviewed file',
    { 'test/setup/deny-network.ts': `${fs.readFileSync('test/setup/deny-network.ts', 'utf8')}\nrequire('child_process')\n` },
    ALLOWED,
    true,
  ];
  const failures = [...controls, wrongModule].flatMap(([description, files, allowed, shouldFail]) => {
    fixture(files);
    const found = scan(tree, allowed);
    return found.length > 0 === shouldFail ? [] : [`${description}: ${shouldFail ? 'passed' : 'failed'} (${found.join('; ')})`];
  });
  // Unreadable source: each control holds a forbidden import behind the failing read, injects exactly that error, and
  // requires the scan to throw UninspectedSourceError rather than report a clean tree.
  const forbidden = "import cp from 'child_process'\n";
  const unreadable = [
    ['an unreadable source file', { 'src/locked.ts': forbidden }, { file: 'src/locked.ts' }],
    ['an unreadable directory', { 'src/locked/inner.ts': forbidden }, { directory: 'src/locked' }],
    ['an unreadable directory at the root', {}, { directory: 'tree' }],
  ].flatMap(([description, files, failOn]) => {
    fixture(files);
    const io = failingIo(failOn);
    let outcome = 'returned a result';
    try {
      scan(tree, ALLOWED, io);
    } catch (error) {
      outcome = error instanceof UninspectedSourceError ? '' : `threw ${error.message}`;
    }
    const problems = [];
    if (io.injected.count === 0) problems.push('the injected read error never occurred');
    if (outcome !== '') problems.push(`the scan ${outcome} instead of failing as uninspected`);
    return problems.length === 0 ? [] : [`${description}: ${problems.join('; ')}`];
  });
  failures.push(...unreadable);
  fs.rmSync(tmp, { recursive: true, force: true });
  failures.forEach((failure) => console.error(`self-test failed: ${failure}`));
  return failures.length === 0;
};

const main = () => {
  if (process.argv[2] === '--self-test') {
    if (!selfTest()) return 1;
    console.log('bypass import check: self-test passed');
    return 0;
  }
  const violations = scan('.');
  violations.forEach((violation) => console.error(violation));
  return violations.length > 0 ? 1 : 0;
};

try {
  process.exit(main());
} catch (error) {
  if (!(error instanceof UninspectedSourceError)) throw error;
  console.error(`bypass import check: ${error.message}`);
  process.exit(2);
}
