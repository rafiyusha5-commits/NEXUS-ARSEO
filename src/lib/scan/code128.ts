// Code 128 (code set B) for Nexus labels: module widths of bars and spaces, starting with a bar. Checked against the
// Code 128 reader of @zxing/library in the tests (a round trip), so a wrong pattern cannot pass unnoticed.

const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132",
  "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212",
  "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311",
  "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242", "121142", "121241", "114212",
  "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113",
  "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104, STOP = 106;

/** Widths of bars and spaces (bar first) of a text in code set B: printable ASCII 32–126 only. */
export function code128Widths(text: string): number[] {
  if (!text || /[^\x20-\x7e]/.test(text)) throw new Error("Code 128 B: only printable ASCII");
  const codes = [...text].map(char => char.charCodeAt(0) - 32);
  const checksum = codes.reduce((sum, code, index) => sum + code * (index + 1), START_B) % 103;
  return [START_B, ...codes, checksum, STOP].flatMap(value => PATTERNS[value].split("").map(Number));
}

/** Modules as booleans (true: bar), with a quiet zone of 10 modules on each side. */
export function code128Modules(text: string): boolean[] {
  const modules: boolean[] = Array(10).fill(false);
  code128Widths(text).forEach((width, index) => { for (let i = 0; i < width; i += 1) modules.push(index % 2 === 0); });
  return [...modules, ...Array(10).fill(false)];
}
