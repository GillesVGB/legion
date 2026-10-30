export const exemptionRemovalTime = (ctx) =>
  Number(ctx.store.setting('gangpot:exemptions-removed-at') || 0);
export function removeGangpotExemptions(store, now = Date.now()) {
  if (!store.config.gangpot) return;
  store.transaction(() => {
    if (!store.setting('gangpot:exemptions-removed-at')) {
      store.setSetting('gangpot:exemptions-removed-at', String(now));
      store.audit('gangpot.exemptions.removed', store.config.clientId, { at: now });
    }
    store.db
      .prepare(
        "UPDATE gangpot_exemptions SET revoked_at=?,revoked_by=?,revoke_reason='Losse gangpotvrijstellingen zijn afgeschaft.' WHERE revoked_at IS NULL",
      )
      .run(now, store.config.clientId || 'system');
  });
}
