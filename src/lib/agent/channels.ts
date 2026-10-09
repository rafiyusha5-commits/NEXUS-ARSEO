const TELEGRAM_TOOLS = new Set([
  "find_shipments", "get_shipment", "get_shipment_vehicles", "get_shipment_documents", "get_document_extraction",
  "list_delayed_shipments", "get_stock_status", "find_products", "get_my_tasks", "get_help",
]);
// New web tools do not silently become available in Telegram.
export function channelAllowsTool(channel: "web" | "telegram", name: string): boolean {
  return channel === "web" || TELEGRAM_TOOLS.has(name);
}
