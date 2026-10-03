export function canViewShipmentPrices(grantedPermissions: ReadonlySet<string>) {
  return grantedPermissions.has("prices.purchase.view");
}
