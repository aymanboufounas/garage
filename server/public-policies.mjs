// Public policy metadata only. Never pass process.env or credential objects through.
export const PUBLIC_POLICY_PAGES = Object.freeze({
  '/privacy-policy': '/privacy-policy.html',
  '/delete-account': '/delete-account.html',
  '/community-guidelines': '/community-guidelines.html'
});

const safeText = (value, maximum) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum) : '';
const retentionDays = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 1 && days <= 36500 ? days : null;
};

export function publicPolicyConfig(options = {}) {
  const operatorName = safeText(options.operatorName, 200);
  const candidate = safeText(options.contactEmail, 190);
  const contactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : '';
  const retention = {
    transaction_days: retentionDays(options.transactionRetentionDays),
    moderation_days: retentionDays(options.moderationRetentionDays),
    backup_days: retentionDays(options.backupRetentionDays)
  };
  const operatorReady = Boolean(operatorName && contactEmail);
  return {
    product: 'GarageShare',
    version: '2026-11-18',
    guidelines_version: '2026-11-18',
    operator_name: operatorName,
    contact_email: contactEmail,
    operator_ready: operatorReady,
    review_required: !(operatorReady && options.policyReviewed === true && Object.values(retention).every(value => value !== null)),
    retention,
    // These are declarations supplied by the operator, not proof a backup or
    // transactional retention job has been deployed. The policy distinguishes them.
    retention_is_operator_declared: true
  };
}
