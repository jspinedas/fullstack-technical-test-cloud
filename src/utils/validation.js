'use strict';

// Catalog assumption: the spec shows "monthly" as an example payload, not an exhaustive enum.
// Four natural report frequencies are defined here. Reduce to ['monthly'] if the business
// confirms only that type is supported; extend without code changes to the callers.
const VALID_REPORT_TYPES = Object.freeze(['daily', 'weekly', 'monthly', 'annual']);

// Practical regex: covers standard email formats without full RFC 5321 compliance.
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_REGEX.test(value);
}

function validateReportPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload must be a non-null object'] };
  }

  const errors = [];

  if (!payload.email) {
    errors.push('email is required');
  } else if (!isValidEmail(payload.email)) {
    errors.push('email must be a valid email address');
  }

  if (!payload.reportType) {
    errors.push('reportType is required');
  } else if (!VALID_REPORT_TYPES.includes(payload.reportType)) {
    errors.push(`reportType must be one of: ${VALID_REPORT_TYPES.join(', ')}`);
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

module.exports = { validateReportPayload, VALID_REPORT_TYPES };
