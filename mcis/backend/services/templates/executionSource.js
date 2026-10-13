/**
 * Layer 8 — public-launch hardening (execution-source taxonomy).
 *
 * Customers evaluating whether a template/workflow step is "real
 * automation" deserve an honest, consistent answer to "what actually runs
 * this step" — not a uniform "agent" label that hides the difference
 * between a connected third-party API call, a browser visit to a URL the
 * customer themselves supplied, and a connector that ISN'T connected yet
 * (which must never be presented the same as one that is).
 *
 * This module is the single place that classification is computed, so a
 * template step is never silently mislabeled by one of several call sites
 * drifting out of sync with each other.
 */
'use strict';

// The six categories asked for by the public-launch hardening pass, plus
// two additional, equally honest categories this catalogue's real step
// shapes need and that the six don't fit: a human review step (there is
// no automated execution to label at all) and a pure drafting/reasoning
// step (writes text from inputs already in hand -- it never touches a
// local app, a browser, or an external API, and claiming otherwise would
// itself be the kind of overstatement this taxonomy exists to prevent).
const EXECUTION_SOURCES = Object.freeze({
  NATIVE: 'native_nexus',
  CONNECTOR: 'connector_api',
  CUSTOMER_URL: 'customer_url',
  DEMO_FIXTURE: 'demo_fixture',
  EXTERNAL_SETUP_REQUIRED: 'external_setup_required',
  UNSUPPORTED: 'unsupported',
  HUMAN_REVIEW: 'human_review',
  AI_DRAFTING_ONLY: 'ai_drafting_only',
});

const EXECUTION_SOURCE_LABELS = Object.freeze({
  [EXECUTION_SOURCES.NATIVE]: 'Native Nexus execution — runs on the connected desktop/browser or as a platform AI agent',
  [EXECUTION_SOURCES.CONNECTOR]: 'Connector/API execution — calls your connected integration',
  [EXECUTION_SOURCES.CUSTOMER_URL]: 'Customer-authorized URL/browser execution — acts on a site or mailbox you specified',
  [EXECUTION_SOURCES.DEMO_FIXTURE]: 'Demo/test fixture — not live execution',
  [EXECUTION_SOURCES.EXTERNAL_SETUP_REQUIRED]: 'External setup required — connect the integration this step needs before it can run',
  [EXECUTION_SOURCES.UNSUPPORTED]: 'Unsupported — this action is not implemented',
  [EXECUTION_SOURCES.HUMAN_REVIEW]: 'Human review — a person decides; nothing automated runs this step',
  [EXECUTION_SOURCES.AI_DRAFTING_ONLY]: 'AI drafting only — writes text from data already provided; touches no external system',
});

/**
 * Resolve the real execution source of one catalogue step.
 *
 * @param {object} step - a step from services/templates/catalog.js
 * @param {{ integrationAvailable?: boolean }} ctx - whether THIS
 *   workspace already has the step's required connectorTemplate provider
 *   connected (irrelevant for every other step shape).
 */
function resolveStepExecutionSource(step, { integrationAvailable } = {}) {
  if (!step) return EXECUTION_SOURCES.UNSUPPORTED;
  if (step.type === 'review') return EXECUTION_SOURCES.HUMAN_REVIEW;
  if (step.connectorTemplate) {
    return integrationAvailable ? EXECUTION_SOURCES.CONNECTOR : EXECUTION_SOURCES.EXTERNAL_SETUP_REQUIRED;
  }
  // Every other step shape in the catalogue is required to say explicitly
  // what it is (native_nexus / customer_url / ai_drafting_only) via its
  // own `executionSource` field -- an AI-workforce-agent step
  // (`agentTemplate`) defaults to native (it's the platform's own agent,
  // not a third-party connector or a customer-named URL) unless the
  // catalogue entry overrides that. A step with none of these markers and
  // no explicit `executionSource` is NOT assumed to be real automation --
  // it is reported as unsupported so a future catalogue entry can never
  // silently claim capability it never declared.
  if (typeof step.executionSource === 'string' && Object.values(EXECUTION_SOURCES).includes(step.executionSource)) {
    return step.executionSource;
  }
  if (step.agentTemplate) return EXECUTION_SOURCES.NATIVE;
  return EXECUTION_SOURCES.UNSUPPORTED;
}

function labelFor(source) {
  return EXECUTION_SOURCE_LABELS[source] || EXECUTION_SOURCE_LABELS[EXECUTION_SOURCES.UNSUPPORTED];
}

module.exports = { EXECUTION_SOURCES, EXECUTION_SOURCE_LABELS, resolveStepExecutionSource, labelFor };
