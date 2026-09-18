const path=require('path');
const qrcode=require('qrcode-terminal');
const {Client,LocalAuth}=require('whatsapp-web.js');
const log=require('./logger');
function createWhatsapp(){
 const client=new Client({authStrategy:new LocalAuth({clientId:'quality-notifier',dataPath:path.join(__dirname,'..','.session')}),puppeteer:{headless:true,args:['--no-sandbox','--disable-setuid-sandbox']}});
 client.on('qr',qr=>{log.info('Leia o QR Code abaixo com o número exclusivo do bot.');qrcode.generate(qr,{small:true});});
 client.on('ready',()=>log.info('WhatsApp conectado e pronto para enviar.'));
 client.on('authenticated',()=>log.info('Sessão do WhatsApp autenticada.'));
 client.on('auth_failure',message=>log.error('Falha de autenticação do WhatsApp.',message));
 client.on('disconnected',reason=>log.warn('WhatsApp desconectado.',reason));
 return client;
}
async function listGroups(client){const chats=await client.getChats();return chats.filter(chat=>chat.isGroup).map(chat=>({name:chat.name,id:chat.id._serialized})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));}
module.exports={createWhatsapp,listGroups};
