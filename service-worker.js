const CACHE_NAME='qualidade-shell-20260921';
const APP_SHELL=['/','/index.html','/style.css','/app.js','/knowledge.js','/corrections.js','/drawing.js','/indicators.js','/fep.js','/preview.js','/revision-tools.js','/draw2data.js','/controle.js','/whatsapp-settings.js','/manifest.webmanifest','/app-icon.svg'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('qualidade-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>response).catch(()=>caches.match('/index.html')));
    return;
  }
  event.respondWith(fetch(request).then(response=>{
    if(response.ok&&APP_SHELL.includes(url.pathname)){
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(url.pathname,copy));
    }
    return response;
  }).catch(()=>caches.match(request,{ignoreSearch:true})));
});
