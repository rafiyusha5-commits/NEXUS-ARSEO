import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
function syntheticPng(key){
  const chunk=(type,data)=>{
    const payload=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
    for(const byte of payload){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,payload,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(100,0);header.writeUInt32BE(100,4);header[8]=8;header[9]=2;
  const pixels=Buffer.concat(Array.from({length:100},()=>Buffer.concat([Buffer.from([0]),Buffer.alloc(300,255)])));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('tEXt',Buffer.from(`Comment\0SYNTHETIC OCR BOUNDARY ${key}`)),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
export function makeExternalFixtures(){
  const root='1ffI_2N0F9Gy3N8r5XgNRv-hipmCl1ele',folder='Synthetic_browser_folder';
  const declaration=`ДЕКЛАРАЦИЯ НА ТОВАРЫ
No | 50123/010199/0000123
5 Всего т-ов | 6 Всего мест
2 | 2
12 ОБЩАЯ ТАМОЖЕННАЯ СТОИМОСТЬ
FI | 350,00
22 Валюта | 23 Курс валюты
EUR | 350,00 | 1,00 | 021
${[[1,'990001',100,200],[2,'990002',50,150]].map(([n,sku,qty,amount])=>`31 Грузовые | 32 Товар | 33 Код товара
${n} | 1806901900
1. SYNTHETIC CANDY ${sku},
FI | | ${qty},000 | ООООZОО
37 ПРОЦЕДУРА | 38 Вес нетто (кг)
4000 | 000 | ${qty*0.9},000
42 Цена товара | 43.Код МОС
44. Дополнит. | ${amount},00 | 1
45 Таможенная стоимость
 | ${amount},00
46 Статистическая стоимость
47 Исчисление
`).join('\n')}\fГрафа 31 Описание товара
No Товара | Комментарии
1 | 1. SYNTHETIC АРТИКУЛ: 990001 ОБЩЕЕ КОЛИЧЕСТВО В ЕД. ФИЗ. ОБЪЕМА: 100 ШТ
2 | 1. SYNTHETIC АРТИКУЛ: 990002 ОБЩЕЕ КОЛИЧЕСТВО В ЕД. ФИЗ. ОБЪЕМА: 50 ШТ
Графа 44 Дополнительная информация
1 | 8 | 04021 | SYNTH-INV-1 | 2099/01/01 | Инвойс
1 | 9 | 04131 | WZ 1/01/2099EX | 2099/01/01 | Упаковочный лист`;
  const definitions=[
    ['invoice','Invoice.png',`Инвойс № SYNTH-INV-1
Дата инвойса: 01.01.2099
Номер заказа: SYNTH-ORDER
Вес брутто: 150 кг
Вес нетто: 135 кг
Количество паллет: 2
FAKTURA VAT / INVOICE Kod EAN
--- INVOICE TABLE LAYOUT ---
INVOICE NO): | SYNTH-INV-1
LP. | Kod EAN | JM/unit
1 | 990001 | Synthetic Alpha | 0,90 | 1234567890123 | sztuka | 100 | 2,00 | 200,00 | 0 | 0 | 200,00
2 | 990002 | Synthetic Beta | 0,90 | 1234567890124 | sztuka | 50 | 3,00 | 150,00 | 0 | 0 | 150,00
Total (Razem) EUR: | 350,00 | 350,00`],
    ['cmr1','CMR-1.png','CMR № SYNTH-CMR-1\nДата отгрузки: 01.01.2099\nГосномер авто: PILOT-A\nГосномер прицепа: TRAILER-A\nВес брутто: 60 кг\nВес нетто: 54 кг\nКоличество паллет: 1'],
    ['cmr2','CMR-2.png','CMR № SYNTH-CMR-2\nДата отгрузки: 01.01.2099\nГосномер авто: PILOT-B\nГосномер прицепа: TRAILER-B\nВес брутто: 90 кг\nВес нетто: 81 кг\nКоличество паллет: 1'],
    ['packing','Dispatch note.png',`DISPATCH NOTE/ ORDER NR: WZ 1/01/2099EX
1 990001 1234567890123 Synthetic Alpha 10 (100 ) 90.000 01.01.2100 LOT1
2 990002 1234567890124 Synthetic Beta 5 (50 ) 45.000 01.01.2100 LOT2
Total: 15 (150 ) 135.000
Вес брутто: 150 кг
Вес нетто: 135 кг`],
    ['customs','Customs declaration.png',declaration],
  ];
  const files=definitions.map(([key,name,text])=>{const bytes=syntheticPng(key);return {key,id:'Synthetic_browser_'+key,name,mimeType:'image/png',parents:[folder],version:'1',modifiedTime:'2026-01-01T00:00:00Z',size:String(bytes.length),base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),text};});
  return {root,folder,files};
}
