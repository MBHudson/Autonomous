// ============================================
// TOOL-PROTOCOL.JS — public surface for the tool-call dialect
// ============================================
//
// The registry moved to harness.js, which knows BOTH the API family a provider
// speaks and the tool-call dialect a model answers best. This file re-exports
// the tool-protocol half so every existing importer keeps working unchanged.

export {
  TOOL_PROTOCOLS,
  protocolLabel,
  protocolHint,
  autoProtocol,
  toolProtocolFor,
  detectFamily,
  harnessFor,
  describeHarness,
  contextLimitFor,
  learnedDialect,
  rememberDialect,
} from './harness.js?v=316';
