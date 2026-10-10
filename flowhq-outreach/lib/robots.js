'use strict';
// Minimal RFC 9309 robots.txt parser: groups by user-agent, longest-match
// Allow/Disallow with * and $ wildcards.

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (current) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;
  let pattern = '';
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  for (const ch of body) pattern += ch === '*' ? '.*' : ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + pattern + (anchored ? '$' : '')).test(path);
}

function agentToken(userAgent) {
  return String(userAgent || '').split('/')[0].trim().toLowerCase();
}

function isAllowed(groups, userAgent, path) {
  const token = agentToken(userAgent);
  let matched = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  if (!matched.length) matched = groups.filter((g) => g.agents.includes('*'));
  if (!matched.length) return true;
  const rules = [].concat(...matched.map((g) => g.rules));
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// Interpret an HTTP response for robots.txt per RFC 9309: 4xx => no rules,
// 5xx/unreachable => assume full disallow.
function robotsFromResponse(statusCode, body) {
  const code = Number(statusCode) || 0;
  if (code >= 200 && code < 300) return { state: 'parsed', groups: parseRobots(body) };
  if (code >= 400 && code < 500) return { state: 'absent', groups: [] };
  return { state: 'unreachable', groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }] };
}

module.exports = { parseRobots, isAllowed, robotsFromResponse };
