require('dotenv').config();
const fs=require('fs');
const path=require('path');
const QRCode=require('qrcode');
const {createSupabase}=require('./supabase');
const {createWhatsapp,listGroups}=require('./whatsapp');
const {createNotificationService}=require('./notificationService');
const {buildSummaryMessage}=require('./messageTemplates');
const log=require('./logger');
const mode=process.argv[2],groupId=process.env.WHATSAPP_GROUP_ID;
const client=createWhatsapp();
const qrPath=path.join(__dirname,'..','whatsapp-qr.png');
const statusPath=path.join(__dirname,'..','whatsapp-status.json');
let currentStatus={connected:false,state:'starting',message:'Iniciando o bot.'};
const writeStatus=(value)=>{currentStatus={...currentStatus,...value,pid:process.pid};try{fs.writeFileSync(statusPath,JSON.stringify({...currentStatus,updatedAt:new Date().toISOString()}));}catch{}};
const botRoot=path.join(__dirname,'..');let summaryBusy=false,cycleBusy=false;
async function processSummaryCommands(){
 if(summaryBusy)return;summaryBusy=true;
 try{
  const files=fs.readdirSync(botRoot).filter(name=>/^whatsapp-summary-command-[a-f0-9-]+\.json$/i.test(name)).sort();
  for(const file of files){
   const commandPath=path.join(botRoot,file),resultPath=path.join(botRoot,file.replace('command-','result-'));
   let command;try{command=JSON.parse(fs.readFileSync(commandPath,'utf8'));}catch{continue;}
   try{
    await client.sendMessage(command.groupId,buildSummaryMessage(command.summary||{},command.createdAt||new Date()));
    fs.writeFileSync(resultPath,JSON.stringify({id:command.id,state:'sent',message:'Resumo enviado ao grupo.',sentAt:new Date().toISOString()}));
   }catch(error){
    fs.writeFileSync(resultPath,JSON.stringify({id:command.id,state:'error',message:String(error.message||error),sentAt:new Date().toISOString()}));
   }finally{try{fs.unlinkSync(commandPath);}catch{}}
  }
 }finally{summaryBusy=false;}
}
async function processCycle(service){if(cycleBusy)return;cycleBusy=true;try{await service.process();await processSummaryCommands();}finally{cycleBusy=false;}}
writeStatus({connected:false,state:'starting',message:'Iniciando o bot.'});
const heartbeat=setInterval(()=>writeStatus({}),10000);heartbeat.unref();
process.on('uncaughtException',error=>{writeStatus({connected:false,state:'error',message:String(error.message||error)});log.error('Erro inesperado no bot.',error.message);process.exit(1);});
process.on('unhandledRejection',error=>{writeStatus({connected:false,state:'error',message:String(error?.message||error)});log.error('Falha inesperada no bot.',error?.message||error);});
client.on('auth_failure',message=>writeStatus({connected:false,state:'error',message:`Falha de autenticação do WhatsApp: ${message}`}));
client.on('disconnected',reason=>{writeStatus({connected:false,state:'disconnected',message:`WhatsApp desconectado: ${reason}`});if(!mode)setTimeout(()=>process.exit(1),2000).unref();});
client.on('qr',qr=>{writeStatus({connected:false,state:'qr',message:'Aguardando leitura do QR Code.'});QRCode.toFile(qrPath,qr,{width:420,margin:2}).catch(error=>log.error('Não foi possível gerar a imagem do QR Code.',error.message));});
client.on('ready',async()=>{
 writeStatus({connected:true,state:'ready',message:'WhatsApp conectado e pronto para enviar.'});
 try{if(fs.existsSync(qrPath))fs.unlinkSync(qrPath);}catch{}
 try{
  if(mode==='--listar-grupos'){for(const group of await listGroups(client))console.log(`${group.name}
  ${group.id}`);await client.destroy();return;}
  if(mode==='--teste'){if(!groupId)throw Error('Defina WHATSAPP_GROUP_ID no .env antes do teste.');await client.sendMessage(groupId,'Teste de integração - Sistema de Ferramentas');log.info('Mensagem de teste enviada.');await client.destroy();return;}
  const service=createNotificationService(createSupabase(),client);await service.recover();await processCycle(service);setInterval(()=>processCycle(service).catch(error=>log.error('Falha no ciclo de notificações e resumo.',error.message)),Math.max(1000,Number(process.env.CHECK_INTERVAL)||5000));
 }catch(error){writeStatus({connected:false,state:'error',message:String(error.message||error)});log.error('Bot interrompido.',error.message);await client.destroy();process.exitCode=1;}
});
client.initialize();
