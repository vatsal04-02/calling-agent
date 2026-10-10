'use strict';
const { clean, safeJsonParse, toInt, isoNow, toCell, truncate } = require('./util');
const { STATUS, VALIDATION, APPROVAL } = require('./status');
const { selectOpportunities } = require('./opportunities');
const { localeFor, templateParts, assembleEmail } = require('./compose');
const { buildRequest, parseResponse } = require('./llm');
const { validateDraft, PLACEHOLDER_RE } = require('./validate');

const MAX_GENERATION_ATTEMPTS = 3;

function contextFor(lead, selection, settings, compliance) {
  const locale = localeFor(lead.country, compliance);
  return {
    lead, selection, settings, locale,
    sender: settings.sender,
    countryRules: (compliance.countries || {})[lead.country] || null,
    companyName: settings.sender.company,
  };
}

/** Decide what to do for one RESEARCHED lead. */
function planGeneration(lead, catalogue, settings, compliance) {
  if (clean(lead.no_unsolicited_notice)) {
    return {
      action: 'skip',
      lead_id: lead.lead_id,
      update: { lead_id: lead.lead_id, outreach_status: STATUS.MANUAL_REVIEW, status_reason: 'website_says_no_unsolicited_messages', updated_at: isoNow() },
    };
  }
  const signals = safeJsonParse(lead.signals_json, []);
  const selection = selectOpportunities(signals, lead, catalogue, settings);
  if (!selection.ok) {
    const action = (settings.generation && settings.generation.no_recommendation_action) || 'MANUAL_REVIEW';
    return {
      action: 'skip',
      lead_id: lead.lead_id,
      update: {
        lead_id: lead.lead_id,
        outreach_status: action === 'SKIP' ? STATUS.NO_RECOMMENDATION : STATUS.MANUAL_REVIEW,
        status_reason: `no_recommendation:${selection.reason}`,
        confidence_score: '',
        recommended_solution: '',
        updated_at: isoNow(),
      },
    };
  }
  const ctx = contextFor(lead, selection, settings, compliance);
  const provider = (settings.llm && settings.llm.provider) || 'template';
  const plan = {
    action: provider === 'template' ? 'template' : 'llm',
    lead_id: lead.lead_id,
    lead,
    selection: {
      signals: selection.signals,
      primary_service: selection.primary_service,
      secondary_service: selection.secondary_service,
      confidence: selection.confidence,
    },
    locale: ctx.locale,
  };
  if (plan.action === 'llm') plan.request_body = buildRequest(ctx, settings.llm);
  return plan;
}

/** Turn the plan (+ LLM HTTP result, if any) into a Leads row update. */
function finalizeGeneration(plan, llmItem, settings, compliance) {
  const lead = plan.lead;
  const now = isoNow();
  const attempts = toInt(lead.generation_attempts, 0) + 1;
  const ctx = contextFor(lead, plan.selection, settings, compliance);
  let parts;
  let generator;
  let usage = null;
  if (plan.action === 'template') {
    parts = templateParts(ctx);
    generator = 'template';
  } else {
    const parsed = parseResponse(llmItem, settings.llm);
    if (!parsed.ok) {
      const giveUp = attempts >= MAX_GENERATION_ATTEMPTS || parsed.kind === 'permanent';
      return {
        lead_id: lead.lead_id,
        outreach_status: giveUp ? STATUS.MANUAL_REVIEW : STATUS.RESEARCHED,
        status_reason: giveUp ? `generation_failed:${parsed.kind}` : `generation_retry_pending:${parsed.kind}`,
        generation_attempts: attempts,
        last_error: truncate(`LLM ${parsed.kind}: ${parsed.error}`, 500),
        updated_at: now,
        _error: { type: `llm_${parsed.kind}`, message: parsed.error },
      };
    }
    parts = parsed.parts;
    usage = parsed.usage;
    generator = `${settings.llm.provider}:${settings.llm.model}`;
  }
  const validation = validateDraft(parts, ctx);
  const email = assembleEmail(parts, ctx);
  const leftover = PLACEHOLDER_RE.exec(email.subject + '\n' + email.body);
  if (leftover) {
    validation.issues.push({ code: 'placeholder_in_assembled_email', severity: 'block', detail: `${leftover[0]} (check sender settings)` });
    validation.status = VALIDATION.FAILED;
  }
  const passed = validation.status === VALIDATION.PASSED;
  const p = plan.selection.primary_service;
  const s = plan.selection.secondary_service;
  return {
    lead_id: lead.lead_id,
    recommended_solution: p.name,
    secondary_solution: s ? s.name : '',
    business_benefit: (p.approved_benefits || [])[0] || '',
    selected_signals: plan.selection.signals.map((x) => x.id).join(', '),
    confidence_score: plan.selection.confidence,
    email_subject: email.subject,
    email_body: email.body,
    factual_validation_status: validation.status,
    validation_issues: toCell(validation.issues.map((i) => `${i.severity}:${i.code}:${i.detail}`).join('\n'), 5000),
    generator,
    llm_usage: usage ? `${usage.input_tokens} in / ${usage.output_tokens} out` : '',
    generation_attempts: attempts,
    generated_at: now,
    outreach_status: passed ? STATUS.READY_FOR_APPROVAL : STATUS.MANUAL_REVIEW,
    status_reason: passed ? '' : 'draft_failed_validation',
    approval_status: APPROVAL.PENDING,
    last_error: '',
    updated_at: now,
  };
}

module.exports = { planGeneration, finalizeGeneration, MAX_GENERATION_ATTEMPTS };
