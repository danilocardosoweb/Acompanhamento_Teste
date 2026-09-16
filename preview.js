const viewer=document.createElement('dialog');
viewer.className='viewer';
viewer.setAttribute('aria-label','Visualizar documento');
viewer.innerHTML=`<div class="viewer-head"><div><strong id="viewer-title"></strong><p>Visualização do relatório · Arquivo original preservado</p></div><button id="viewer-close" aria-label="Fechar visualização">✕ Fechar</button></div><div id="viewer-tools"><div id="sheet-tabs" role="tablist" aria-label="Abas da planilha"></div><div class="zoom-tools"><button id="zoom-out" aria-label="Diminuir zoom">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="Aumentar zoom">+</button><button id="zoom-fit">Ajustar</button><a id="sheet-pdf" target="_blank" rel="noopener">Abrir PDF</a></div></div><div id="viewer-pages" role="tabpanel" tabindex="0"></div>`;
document.body.appendChild(viewer);
let previewRequest=0, previewData=null, previewSheet=0, previewZoom=100, trigger=null;
const ve=id=>document.getElementById(id);
ve('viewer-close').onclick=()=>viewer.close();
viewer.addEventListener('close',()=>{previewRequest++;trigger?.focus();});
function setPreviewZoom(value){previewZoom=Math.max(50,Math.min(250,value));ve('zoom-label').textContent=previewZoom+'%';ve('viewer-pages').style.setProperty('--page-width',previewZoom+'%');}
ve('zoom-in').onclick=()=>setPreviewZoom(previewZoom+25);
ve('zoom-out').onclick=()=>setPreviewZoom(previewZoom-25);
ve('zoom-fit').onclick=()=>setPreviewZoom(100);
function showSheet(index){
 previewSheet=index;
 const sheet=previewData.sheets[index];
 ve('sheet-tabs').innerHTML=previewData.sheets.map((s,i)=>`<button role="tab" aria-selected="${i===index}" data-sheet="${i}">${esc(s.name)}</button>`).join('');
 ve('sheet-tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>showSheet(Number(b.dataset.sheet)));
 ve('viewer-pages').setAttribute('aria-label',sheet.name);
 ve('viewer-pages').innerHTML=sheet.pages.map((page,i)=>`<figure><figcaption>${esc(sheet.name)} · Página ${i+1} de ${sheet.pages.length}</figcaption><img src="/preview/${previewData.key}/${encodeURIComponent(page)}" alt="${esc(sheet.name)} — página ${i+1}"></figure>`).join('');
 ve('sheet-pdf').href=`/preview/${previewData.key}/${encodeURIComponent(sheet.file)}`;
 ve('viewer-pages').scrollTop=0;
 setPreviewZoom(100);
}
document.addEventListener('click',async event=>{
 const button=event.target.closest('.preview-button');
 if(!button)return;
 trigger=button; const request=++previewRequest;
 ve('viewer-title').textContent=button.dataset.name;
 ve('viewer-tools').hidden=true;
 ve('viewer-pages').innerHTML='<div class="preview-loading" role="status">Preparando as páginas do documento…<p>A primeira abertura pode levar alguns segundos.</p></div>';
 viewer.showModal();
 try{
   const response=await fetch(`/api/preview?id=${encodeURIComponent(button.dataset.id)}&index=${button.dataset.index}`,{method:'POST',headers:{'X-Painel':'local'}});
   const result=await response.json();
   if(request!==previewRequest)return;
   if(!response.ok)throw Error(result.error||'Não foi possível abrir o documento.');
   previewData=result;
   if(!result.sheets.length)throw Error('Nenhuma aba visível encontrada.');
   ve('viewer-tools').hidden=false;showSheet(0);
 }catch(error){if(request===previewRequest)ve('viewer-pages').innerHTML=`<div class="preview-loading" role="alert">${esc(error.message)}<p>Você ainda pode baixar o arquivo original pelo painel.</p></div>`;}
});
