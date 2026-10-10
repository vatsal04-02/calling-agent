'use strict';
// Deterministic opportunity selection: rank (signal, service) pairs from the
// evidence and the service catalogue. The LLM never chooses what to claim;
// it only words what was selected here.

function industryFits(service, industryGroup) {
  const fit = service.industries_fit || ['*'];
  if (fit.includes('*')) return 1;
  if (industryGroup && fit.includes(industryGroup)) return 1;
  return industryGroup ? 0.35 : 0.6;
}

function selectOpportunities(signals, lead, catalogue, settings) {
  const gen = settings.generation || {};
  const minConf = gen.min_confidence === undefined ? 0.6 : gen.min_confidence;
  const maxSignals = Math.min(2, gen.max_signals || 2);
  const maxServices = Math.min(2, gen.max_services || 2);
  const present = new Set((signals || []).map((s) => s.id));
  const services = ((catalogue && catalogue.services) || []).filter((s) => s.enabled);

  const pairs = [];
  for (const sig of signals || []) {
    if (sig.requires_human_check) continue; // never auto-selected
    for (const svc of services) {
      const weight = (svc.signals || {})[sig.id];
      if (!weight) continue;
      if ((svc.exclude_if_signals || []).some((x) => present.has(x))) continue;
      const score = sig.confidence * weight * industryFits(svc, lead.industry_group);
      pairs.push({ signal: sig, service: svc, score: Math.round(score * 1000) / 1000 });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  if (!pairs.length) return { ok: false, reason: 'no_matching_service_for_observations', candidates: [] };
  const best = pairs[0];
  if (best.signal.confidence < minConf) {
    return { ok: false, reason: `low_confidence(${best.signal.confidence}<${minConf})`, candidates: pairs.slice(0, 3).map(summarise) };
  }

  const chosenSignals = [best.signal];
  const chosenServices = [best.service];
  for (const p of pairs.slice(1)) {
    if (chosenSignals.length >= maxSignals && chosenServices.length >= maxServices) break;
    if (p.signal.confidence < minConf) continue;
    const newSignal = !chosenSignals.includes(p.signal);
    const newService = !chosenServices.includes(p.service);
    // A second observation must support an already-chosen service, or add the one permitted secondary service.
    if (newSignal && chosenSignals.length < maxSignals && !newService) chosenSignals.push(p.signal);
    else if (newService && chosenServices.length < maxServices && !newSignal && p.score >= best.score * 0.5) chosenServices.push(p.service);
    else if (newSignal && newService && chosenSignals.length < maxSignals && chosenServices.length < maxServices && p.score >= best.score * 0.6) {
      chosenSignals.push(p.signal);
      chosenServices.push(p.service);
    }
  }
  const confidence = Math.round((chosenSignals.reduce((n, s) => n + s.confidence, 0) / chosenSignals.length) * 100) / 100;
  return {
    ok: true,
    signals: chosenSignals,
    primary_service: chosenServices[0],
    secondary_service: chosenServices[1] || null,
    confidence,
    candidates: pairs.slice(0, 5).map(summarise),
  };
}

function summarise(p) {
  return { signal: p.signal.id, service: p.service.id, score: p.score };
}

module.exports = { selectOpportunities };
