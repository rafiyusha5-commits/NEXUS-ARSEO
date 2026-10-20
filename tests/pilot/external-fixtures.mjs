import {createHash} from 'node:crypto';
export function makeExternalFixtures(){
  const root='1ffI_2N0F9Gy3N8r5XgNRv-hipmCl1ele',folder='Synthetic_browser_folder';
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDusAAAAASUVORK5CYII=','base64');
  const definitions=[
    ['invoice','Invoice.png','Инвойс № SYNTH-INV-1\nДата инвойса: 01.01.2099\nНомер заказа: SYNTH-ORDER\nВес брутто: 150 кг\nВес нетто: 135 кг\nКоличество паллет: 2'],
    ['cmr1','CMR-1.png','CMR № SYNTH-CMR-1\nДата отгрузки: 01.01.2099\nГосномер авто: PILOT-A\nГосномер прицепа: TRAILER-A\nВес брутто: 60 кг\nВес нетто: 54 кг\nКоличество паллет: 1'],
    ['cmr2','CMR-2.png','CMR № SYNTH-CMR-2\nДата отгрузки: 01.01.2099\nГосномер авто: PILOT-B\nГосномер прицепа: TRAILER-B\nВес брутто: 90 кг\nВес нетто: 81 кг\nКоличество паллет: 1'],
    ['packing','Dispatch note.png','Упаковочный лист № SYNTH-PACK-1\nНомер заказа: SYNTH-ORDER\nВес брутто: 150 кг\nВес нетто: 135 кг\nКоличество паллет: 2'],
    ['customs','Customs declaration.png','ДЕКЛАРАЦИЯ НА ТОВАРЫ\nРегистрационный номер: 39855200/010199/0000001\nДата декларации: 01.01.2099\nВес брутто: 150 кг\nВес нетто: 135 кг'],
  ];
  const files=definitions.map(([key,name,text])=>{const bytes=Buffer.concat([png,Buffer.from('\nSYNTHETIC-'+key)]);return {key,id:'Synthetic_browser_'+key,name,mimeType:'image/png',parents:[folder],version:'1',modifiedTime:'2026-01-01T00:00:00Z',size:String(bytes.length),base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),text};});
  return {root,folder,files};
}
