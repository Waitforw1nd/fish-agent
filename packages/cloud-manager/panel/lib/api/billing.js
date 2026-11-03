export function createBillingApi({ request, tenantPath }) {
  return {
    getBillingEntries: (id, options = {}) => request(tenantPath(id, '/billing/entries'), options),
    getRecharges: (id) => request(tenantPath(id, '/billing/recharges')),
    createRecharge(id, { amount, amountMicros } = {}) {
      return request(tenantPath(id, '/billing/recharges'), {
        method: 'POST',
        body: { amountMicros: amountMicros ?? Math.round(Number(amount) * 1_000_000) }
      });
    },
    getTransactions: (id) => request(tenantPath(id, '/billing/transactions'))
  };
}
