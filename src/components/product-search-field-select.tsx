import type { ProductSearchField } from "@/lib/products/search";

const options: Array<{ value: ProductSearchField; label: string }> = [
  { value: "all", label: "Везде" },
  { value: "barcode", label: "Штрихкоду" },
  { value: "article", label: "Артикулу" },
  { value: "name", label: "Названию" },
  { value: "weight", label: "Граммажу / весу" },
  { value: "volume", label: "Объёму (мл / л)" },
  { value: "brand", label: "Бренду" },
  { value: "manufacturer", label: "Производителю" },
  { value: "category", label: "Категории" },
  { value: "hs_code", label: "ТН ВЭД" },
];

export function ProductSearchFieldSelect({ defaultValue }: { defaultValue: ProductSearchField }) {
  return <label className="catalog-search-mode">Искать по
    <select
      name="search_by"
      defaultValue={defaultValue}
    >
      {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>
  </label>;
}
