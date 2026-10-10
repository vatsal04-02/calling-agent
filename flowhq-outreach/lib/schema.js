'use strict';
// Column layout for every tab in the FlowHQ Outreach spreadsheet.
// templates/FlowHQ-Outreach-Template.xlsx is generated from this file.

const TABS = {
  Leads: [
    // identity (lead_id must stay in column A: updates match on it)
    'lead_id', 'business_name', 'contact_name', 'first_name', 'email', 'role_address', 'website', 'domain', 'country',
    'country_inferred', 'industry', 'industry_group', 'source', 'notes', 'phone', 'source_row_number', 'original_row_json', 'imported_at',
    // workflow state
    'outreach_status', 'status_reason', 'validation_errors', 'duplicate_of', 'legal_basis_confirmed', 'reprocess',
    // research
    'website_access_status', 'pages_reviewed', 'observed_issue_1', 'evidence_url_1', 'evidence_snippet_1', 'observed_issue_2',
    'evidence_url_2', 'evidence_snippet_2', 'signals_json', 'email_published_url', 'no_unsolicited_notice', 'research_summary', 'researched_at',
    // personalisation
    'selected_signals', 'recommended_solution', 'secondary_solution', 'business_benefit', 'confidence_score', 'email_subject', 'email_body',
    'factual_validation_status', 'validation_issues', 'generator', 'llm_usage', 'generation_attempts', 'generated_at',
    // approval
    'approval_status', 'approved_by', 'reviewer_notes',
    // sending & tracking
    'send_block_reason', 'send_mode', 'sent_to', 'sending_timestamp', 'provider_message_id', 'provider_thread_id',
    'delivery_or_error_status', 'retry_count', 'next_retry_at', 'follow_up_eligible', 'opt_out_status', 'unsubscribe_token',
    'last_error', 'updated_at',
  ],
  Research_Cache: ['domain', 'researched_at', 'expires_at', 'access_status', 'pages_reviewed', 'signals_json', 'emails_found',
    'no_unsolicited_notice', 'text_chars', 'summary', 'research_json'],
  Send_Log: ['log_id', 'timestamp', 'run_id', 'lead_id', 'mode', 'intended_recipient', 'actual_recipient', 'subject', 'status',
    'http_status', 'provider_message_id', 'thread_id', 'error_message'],
  Suppression: ['value', 'type', 'reason', 'source', 'added_at', 'lead_id'],
  Error_Log: ['timestamp', 'workflow', 'node', 'lead_id', 'error_type', 'message', 'execution_id'],
  Settings: ['key', 'value', 'notes'],
  Inbox_Log: ['message_id', 'thread_id', 'received_at', 'from', 'subject', 'classification', 'matched_lead_id', 'action', 'processed_at'],
};

const DEFAULT_SETTINGS_ROWS = [
  { key: 'KILL_SWITCH', value: 'FALSE', notes: 'TRUE stops all sending immediately, including mid-run. Set automatically on Gmail auth/quota errors or a high bounce rate.' },
  { key: 'KILL_SWITCH_REASON', value: '', notes: 'Why the kill switch was set.' },
  { key: 'SENDING_ENABLED', value: 'FALSE', notes: 'Must be TRUE here AND in the workflow config for anything to be sent.' },
  { key: 'TEST_MODE', value: 'TRUE', notes: 'TRUE = only allowlisted test inboxes receive email. Live sending also requires sending.live_approval in the workflow config.' },
  { key: 'TEST_ALLOWLIST', value: '', notes: 'Comma-separated test inboxes you own.' },
  { key: 'TEST_REDIRECT_TO', value: '', notes: 'Optional: a test inbox (also on the allowlist) that receives a copy of each approved draft, marked [TEST].' },
  { key: 'MAX_SENDS_PER_RUN', value: '5', notes: 'The lower of this and the workflow config applies.' },
  { key: 'MAX_SENDS_PER_DAY', value: '20', notes: 'Rolling 24 hours. The lower of this and the workflow config applies.' },
  { key: 'SEND_INTERVAL_SECONDS', value: '90', notes: 'Minimum gap between emails. The higher of this and the workflow config applies.' },
  { key: 'SEND_LOCK', value: '', notes: 'Managed by workflow 04: holds "<run>|<time>" while a send run is in progress so overlapping runs cannot work the same queue. Expires after 30 minutes. Leave empty.' },
  { key: 'RESEARCH_BATCH_SIZE', value: '10', notes: 'Leads researched per run.' },
  { key: 'GENERATION_BATCH_SIZE', value: '10', notes: 'Drafts generated per run.' },
];

module.exports = { TABS, DEFAULT_SETTINGS_ROWS };
