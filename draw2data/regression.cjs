const assert=require('node:assert/strict');
const fs=require('fs');
const {processDrawing}=require('./processing.cjs');
const {extractPdf}=require('./reader.cjs');
const {buildWorkbook}=require('./exporter.cjs');
const XLSX=require('xlsx');
(async()=>{
 const source=process.argv[2];if(!source)throw Error('Informe o caminho do desenho TP-8377.pdf original.');
 const bytes=fs.readFileSync(source),pdf=await extractPdf(bytes);
 assert.equal(pdf.pages[0].items.length,47,'Usar o desenho, não o relatório dimensional.');
 const result=await processDrawing('TP-8377.pdf',bytes);
 assert.equal(result.method,'OCR');assert.equal(result.dimensions.length,12);
 assert.deepEqual(result.dimensions.map(d=>d.nominal).sort((a,b)=>a-b),[1.4,1.9,2.1,3,4.9,5.8,10,10.5,13.2,50,100,132]);
 for(const d of result.dimensions){assert.equal(d.status,'REVISAR');assert(d.width>0&&d.height>0);assert.equal(d.source,'OCR');}
 assert.equal(result.dimensions.find(d=>d.nominal===132).tolerancePlus,.86);
 assert.equal(result.dimensions.find(d=>d.nominal===50).tolerancePlus,.36);
 assert.equal(result.dimensions.find(d=>d.nominal===5.8).tolerancePlus,null);
 assert.equal(result.dimensions.find(d=>d.nominal===3).tolerancePlus,.15,'Corrigir dígito extra criado pela seta.');
 const book=XLSX.read(XLSX.write(buildWorkbook(result),{type:'buffer',bookType:'xlsx'}));
 const rows=XLSX.utils.sheet_to_json(book.Sheets.Cotas);assert.equal(rows.length,12);
 assert.equal(rows.find(d=>d['Valor Nominal']===3)['Tolerância +'],.15);
 console.log('OK: desenho original, 12 nominais, rotação, tolerâncias incertas e Excel.');
})().catch(e=>{console.error(e);process.exitCode=1});
