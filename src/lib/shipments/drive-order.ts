// «Создать поставку из папки Drive» (2026-11-22): reading an order folder name. Names look like
// "AB-50 Nordic гендеры 2027", "OW-10", "Nordic гендеры Cdx12-x" or, after archiving,
// "04_03_AB-48 батончики, AB-49 Delta" (synthetic examples). Everything here is a suggestion for the creation form;
// the employee confirms or changes it. No Drive or database access in this module.

// The permissions of binding a Drive folder (see drive-folder-actions.ts) plus creating a shipment.
export const FROM_DRIVE_PERMISSIONS = ["shipments.view", "shipments.create", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;

export type OrderPrefix = { prefix: string; counterparty_id: string | null; is_own_stock: boolean };
export type OrderCode = { prefix: string; number: string; code: string; own: boolean; counterparty_id: string | null };
export type Party = { id: string; legal_name: string; short_name?: string | null; country?: string | null };

const normalize = (value: string) => value.normalize("NFKC").replace(/İ/g, "I").replace(/ı/g, "i").toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Codes of known prefixes in a folder name: the prefix, an optional "x", "-" or space, then the order number. */
export function orderCodes(name: string, prefixes: readonly OrderPrefix[]): OrderCode[] {
  const title = name.replace(/^(?:\d{1,3}_)+/, "");
  const found: (OrderCode & { at: number })[] = [];
  for (const item of prefixes) {
    const pattern = new RegExp(`(?<![\\p{L}])${escape(item.prefix)}(?:x|-|\\s)?(\\d{1,4})(?!\\d)`, "giu");
    for (const match of title.matchAll(pattern)) {
      found.push({ prefix: item.prefix, number: match[1], code: `${item.prefix}-${match[1]}`, own: item.is_own_stock,
        counterparty_id: item.counterparty_id, at: match.index ?? 0 });
    }
  }
  const unique = new Map<string, OrderCode & { at: number }>();
  for (const code of found.sort((a, b) => a.at - b.at)) if (!unique.has(code.code.toUpperCase())) unique.set(code.code.toUpperCase(), code);
  return [...unique.values()].map(code => ({ prefix: code.prefix, number: code.number, code: code.code, own: code.own, counterparty_id: code.counterparty_id }));
}

// Words of a company name that do not identify it.
const LEGAL = new Set(["gmbh", "ltd", "llc", "b.v", "bv", "s.p.a", "spa", "a.s", "a.ş", "san", "tic", "ve", "anonim", "sirketi", "şirketi", "group",
  "corporation", "company", "confectionary", "confectionery", "entegre", "sanayi", "ticaret", "the", "and", "too", "ооо", "тоо", "осоо", "ип",
  "bakery", "chocolate", "foods", "food", "gida"]);

function nameTokens(party: Party): string[] {
  return [...new Set(normalize(`${party.short_name ?? ""} ${party.legal_name}`).split(/[^\p{L}\p{N}.]+/u)
    .map(word => word.replace(/\.$/, "")).filter(word => word.length >= 4 && !LEGAL.has(word)))];
}

/** Suppliers whose distinctive name word appears as a whole word in the folder name. */
export function matchSuppliers(name: string, suppliers: readonly Party[]): Party[] {
  const words = new Set(normalize(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return suppliers.filter(party => nameTokens(party).some(token => words.has(token)));
}

export type FolderSuggestion = {
  projectCode: string;
  codes: OrderCode[];
  customers: string[];
  ownStock: boolean;
  supplierIds: string[];
};

/** Everything the form can suggest from the folder name and the names of its direct subfolders. */
export function suggestFromFolder(name: string, subfolders: readonly string[], prefixes: readonly OrderPrefix[], suppliers: readonly Party[]): FolderSuggestion {
  const own = orderCodes(name, prefixes);
  const nested = subfolders.flatMap(sub => orderCodes(sub, prefixes));
  const codes = [...own, ...nested.filter(code => !own.some(item => item.code.toUpperCase() === code.code.toUpperCase()))];
  const customers = [...new Set(codes.map(code => code.counterparty_id).filter((id): id is string => Boolean(id)))];
  return {
    projectCode: own[0]?.code ?? codes[0]?.code ?? "",
    codes,
    customers,
    ownStock: codes.some(code => code.own),
    supplierIds: matchSuppliers(name, suppliers).map(party => party.id),
  };
}

/** The route from the supplier's country to Kazakhstan, when there is exactly one such route. */
export function suggestRoute(supplierCountry: string | null | undefined, routes: readonly { id: string; origin_country: string; destination_country: string }[]): string | null {
  if (!supplierCountry) return null;
  const matches = routes.filter(route => route.origin_country === supplierCountry && route.destination_country === "KZ");
  return matches.length === 1 ? matches[0].id : null;
}
