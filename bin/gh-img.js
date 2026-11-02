#!/usr/bin/env node
// Silence node:sqlite's ExperimentalWarning so stdout/stderr stay clean for agents.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(text ?? '')) return;
  return emitWarning.call(process, warning, ...args);
};

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
