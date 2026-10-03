// Downloadable templates of the reference import. Every value is fictitious: GTINs use the
// in-store prefix 2 and tax IDs are placeholders.

import { IMPORT_FORMAT, IMPORT_VERSION, type ReferencePackage } from "./package.ts";

export const TEMPLATE_KINDS = ["counterparties", "products", "identifiers", "packaging"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

// ";"-separated like Excel in Russian locales; decimals use a comma.
export const CSV_TEMPLATES: Record<TemplateKind, string[][]> = {
  counterparties: [
    ["ref", "legal_name", "short_name", "roles", "country", "tax_id", "registration_number", "website", "preferred_locale"],
    ["demo-maker", "Demo Confectionery Oy", "Demo Candy", "manufacturer|supplier", "FI", "FI0000000-0", "", "https://example.com", "en"],
    ["demo-dist", "Demo Distribution GmbH", "", "supplier", "DE", "", "", "", "en"],
  ],
  products: [
    ["internal_sku", "name_ru", "name_en", "name_kk", "manufacturer", "supplier_sku", "brand", "country_of_origin",
      "hs_code", "shelf_life_days", "composition_ru", "composition_en", "nutrition_basis", "energy_kcal", "protein_g", "fat_g",
      "carbohydrates_g", "salt_g", "temperature_regime", "temperature_min_c", "temperature_max_c", "requires_sticker",
      "requires_marking", "gtin", "unit_barcode", "box_barcode"],
    ["DEMO-001", "Демо конфеты 200 г", "Demo sweets 200 g", "", "demo-maker", "ART-001", "Demo", "FI",
      "1806903100", "365", "сахар, какао-масло, молоко сухое", "sugar, cocoa butter, milk powder", "100g", "530", "6,5", "30",
      "58", "0,1", "ambient", "5", "25", "да", "нет", "2000000000091", "", "12000000000098"],
  ],
  identifiers: [
    ["internal_sku", "identifier_type", "value", "counterparty", "packaging_uom", "is_primary"],
    ["DEMO-001", "supplier_sku", "MFR-001", "demo-maker", "", "нет"],
  ],
  packaging: [
    ["internal_sku", "uom", "units_per_parent", "gross_weight_kg", "net_weight_kg", "volume_m3", "length_cm", "width_cm", "height_cm"],
    ["DEMO-001", "piece", "1", "0,22", "0,2", "", "", "", ""],
    ["DEMO-001", "box", "12", "2,8", "2,4", "0,012", "30", "20", "20"],
    ["DEMO-001", "pallet", "60", "180", "", "1,6", "120", "80", "150"],
  ],
};

export function csvTemplate(kind: TemplateKind): string {
  const escape = (value: string) => (/[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return "﻿" + CSV_TEMPLATES[kind].map((row) => row.map(escape).join(";")).join("\r\n") + "\r\n";
}

export const JSON_TEMPLATE: ReferencePackage = {
  format: IMPORT_FORMAT,
  version: IMPORT_VERSION,
  counterparties: [
    { row: 2, ref: "demo-maker", legal_name: "Demo Confectionery Oy", short_name: "Demo Candy", roles: ["manufacturer", "supplier"],
      country: "FI", tax_id: "FI0000000-0", website: "https://example.com", preferred_locale: "en" },
    { row: 3, ref: "demo-dist", legal_name: "Demo Distribution GmbH", roles: ["supplier"], country: "DE", preferred_locale: "en" },
  ],
  products: [
    {
      row: 2,
      internal_sku: "DEMO-001",
      name: { ru: "Демо конфеты 200 г", en: "Demo sweets 200 g" },
      manufacturer: "demo-maker",
      brand: "Demo",
      country_of_origin: "FI",
      hs_code: "1806903100",
      shelf_life_days: 365,
      composition: { ru: "сахар, какао-масло, молоко сухое", en: "sugar, cocoa butter, milk powder" },
      nutrition_facts: { basis: "100g", energy_kcal: 530, protein_g: 6.5, fat_g: 30, carbohydrates_g: 58, salt_g: 0.1 },
      temperature_regime: "ambient",
      temperature_range: "+5…+25 °C",
      requires_sticker: true,
      requires_marking: false,
      identifiers: [
        { type: "gtin", value: "2000000000091", is_primary: true },
        { type: "box_barcode", value: "12000000000098", packaging_uom: "box" },
        { type: "supplier_sku", value: "ART-001", counterparty: "demo-maker", is_primary: true },
      ],
      packaging: [
        { uom: "piece", units_per_parent: 1, gross_weight_kg: 0.22, net_weight_kg: 0.2 },
        { uom: "box", units_per_parent: 12, gross_weight_kg: 2.8, net_weight_kg: 2.4, volume_m3: 0.012, length_cm: 30, width_cm: 20, height_cm: 20 },
        { uom: "pallet", units_per_parent: 60, gross_weight_kg: 180, volume_m3: 1.6, length_cm: 120, width_cm: 80, height_cm: 150 },
      ],
    },
  ],
};
