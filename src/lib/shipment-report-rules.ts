const PRICE_ROLES = new Set([
  "administrator", "director", "executive_director", "commercial_director",
  "logistics_director", "senior_logistics_manager", "accountant",
]);

export function canViewShipmentPrices(roles: ReadonlyArray<{ code: string }>) {
  return roles.some((role) => PRICE_ROLES.has(role.code));
}
