export type BulkDocumentType = { id: string; code: string; name: string };

const TYPE_HINTS: Array<{ codes: string[]; pattern: RegExp }> = [
  { codes: ["transport_order"], pattern: /(?:договор|контракт)[ _.-]*(?:заявк|перевоз)|transport[ _.-]*(?:order|request)/iu },
  { codes: ["invoice"], pattern: /(?:invoice|инвойс|сч[её]т[ _.-]*(?:фактур)?)/iu },
  { codes: ["specification"], pattern: /(?:specification|спецификац)/iu },
  { codes: ["driver_document"], pattern: /(?:водител|driver|паспорт[ _.-]*водител|удостоверен)/iu },
  { codes: ["vehicle_document"], pattern: /(?:техпаспорт|автомобил|прицеп|тягач|vehicle|trailer)/iu },
  { codes: ["cmr"], pattern: /(?:^|[ _.-])cmr(?:[ _.-]|$)/iu },
  { codes: ["ttn"], pattern: /(?:^|[ _.-])ттн(?:[ _.-]|$)/iu },
  { codes: ["packing_list"], pattern: /(?:packing[ _.-]*list|упаковочн)/iu },
  { codes: ["waybill"], pattern: /(?:waybill|накладн)/iu },
];

export function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/u, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "Документ";
}

export function inferDocumentTypeId(fileName: string, types: BulkDocumentType[]) {
  const match = TYPE_HINTS.find(hint => hint.pattern.test(fileName));
  if (match) return types.find(type => match.codes.includes(type.code))?.id ?? "";
  return types.find(type => type.code === "other")?.id ?? "";
}
