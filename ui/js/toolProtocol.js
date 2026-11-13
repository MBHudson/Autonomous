/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// TOOL-PROTOCOL.JS — public surface for the tool-call dialect
// ============================================
//
// The registry moved to harness.js, which knows BOTH the API family a provider
// speaks and the tool-call dialect a model answers best. This file re-exports
// the tool-protocol half so every existing importer keeps working unchanged.

export {
  TOOL_PROTOCOLS,
  HARNESS_CHOICES,
  harnessLabel,
  harnessHintFor,
  harnessOverride,
  protocolLabel,
  protocolHint,
  autoProtocol,
  toolProtocolFor,
  detectFamily,
  harnessFor,
  describeHarness,
  contextLimitFor,
  learnedContextLimit,
  rememberContextLimit,
  learnedDialect,
  rememberDialect,
  forgetDialect,
} from './harness.js?v=438';
