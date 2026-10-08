// Documents and forms often put make and plate in one field ("SCANIA 754BA04", "Прицеп 66DLA04 SCHMITZ").
// The export workbook has separate cells for the plate and the make of the truck and of the trailer, so the
// two are separated here. Anything that does not look like a plate is left exactly as typed.

// Kazakh/CIS style (754BA04, 66DLA04) and Russian style (A123BC77).
const PLATE = /(?<![\p{L}\p{N}])(?:\d{2,3}\s?[A-ZА-ЯЁ]{2,3}\s?\d{2,3}|[A-ZА-ЯЁ]\s?\d{3}\s?[A-ZА-ЯЁ]{2}\s?\d{2,3})(?![\p{L}\p{N}])/iu;

const squeeze = (value: string) => value.replace(/\s+/g, " ").trim();
const trimPunctuation = (value: string) => squeeze(value.replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, ""));
const WORDS_BEFORE = /^(?:тягач|автомобиль|авто|прицеп|полуприцеп|гос\.?\s*номер|номер)\s*[:№-]?\s*/iu;

export function normalizePlateText(value: string) {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function separateVehicle(plateRaw: string, makeRaw: string) {
  let plate = squeeze(plateRaw);
  let make = squeeze(makeRaw);
  const inMake = PLATE.exec(make);
  if (inMake) {
    // The make field carries the plate: move it out.
    make = trimPunctuation(make.replace(inMake[0], " ").replace(WORDS_BEFORE, ""));
    if (!plate) plate = inMake[0];
  }
  const inPlate = PLATE.exec(plate);
  if (inPlate) {
    // The plate field may carry the make as well.
    const rest = trimPunctuation(plate.replace(inPlate[0], " ").replace(WORDS_BEFORE, ""));
    plate = normalizePlateText(inPlate[0]);
    if (rest && !make) make = rest;
  }
  return { plate, make: make.replace(WORDS_BEFORE, "") };
}
