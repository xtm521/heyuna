// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function compile({ write = false, testFixtures = false } = {}) {
  const sources = Object.fromEntries(fs.readdirSync(path.join(root, 'src')).filter((file) => file.endsWith('.sol')).map((file) => [
    `src/${file}`, { content: fs.readFileSync(path.join(root, 'src', file), 'utf8') },
  ]));
  if (testFixtures) {
    const fixtures = path.join(root, 'test/fixtures');
    for (const file of fs.readdirSync(fixtures).filter(file => file.endsWith('.sol'))) {
      sources[`test/fixtures/${file}`] = { content: fs.readFileSync(path.join(fixtures, file), 'utf8') };
    }
  }
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    metadata: { bytecodeHash: 'ipfs' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'storageLayout', 'metadata'] } },
  };
  const input = { language: 'Solidity', sources, settings };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import(importPath) {
      if (!importPath.startsWith('@openzeppelin/contracts/')) return { error: `Import not allowed: ${importPath}` };
      const resolved = path.resolve(root, 'node_modules', importPath);
      const dependencyRoot = path.resolve(root, 'node_modules/@openzeppelin/contracts');
      if (!resolved.startsWith(`${dependencyRoot}${path.sep}`)) return { error: 'Invalid import path' };
      try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
      catch { return { error: `Missing import: ${importPath}` }; }
    },
  }));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  for (const warning of output.errors ?? []) console.warn(warning.formattedMessage);
  const artifacts = {};
  for (const [source, contracts] of Object.entries(output.contracts)) {
    if (!source.startsWith('src/') && !(testFixtures && source.startsWith('test/fixtures/'))) continue;
    for (const [name, artifact] of Object.entries(contracts)) {
      const runtimeBytes = artifact.evm.deployedBytecode.object.length / 2;
      const initBytes = artifact.evm.bytecode.object.length / 2;
      if (runtimeBytes > 24_576 || initBytes > 49_152) throw new Error(`${name} exceeds EVM deployment size limits`);
      artifacts[name] = { contractName: name, sourceName: source, compiler: solc.version(), ...artifact };
    }
  }
  if (write) {
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'abi'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts/compiler-input.json'), `${JSON.stringify(input, null, 2)}\n`);
    for (const [name, artifact] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(root, 'artifacts', `${name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
      fs.writeFileSync(path.join(root, 'abi', `${name}.json`), `${JSON.stringify(artifact.abi, null, 2)}\n`);
    }
  }
  return artifacts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = compile({ write: true });
  for (const [name, artifact] of Object.entries(artifacts)) {
    console.log(`${name}: compiled; init ${artifact.evm.bytecode.object.length / 2} bytes; runtime ${artifact.evm.deployedBytecode.object.length / 2} bytes`);
  }
  console.log('ABIs exported to contracts/abi. No chain connection or deployment performed.');
}
