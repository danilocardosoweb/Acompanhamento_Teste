require('dotenv').config();
const fs=require('fs');
const path=require('path');
const QRCode=require('qrcode');
const {createSupabase}=require('./supabase');
const {createWhatsapp,listGroups}=require('./whatsapp');
const {createNotificationService}=require('./notificationService');
const log=require('./logger');
const mode=process.argv[2],groupId=process.env.WHATSAPP_GROUP_ID;
const client=createWhatsapp();
const qrPath=path.join(__dirname,'..','whatsapp-qr.png');
client.on('qr',qr=>{QRCode.toFile(qrPath,qr,{width:420,margin:2}).catch(error=>log.error('Não foi possível gerar a imagem do QR Code.',error.message));});
client.on('ready',async()=>{
 try{if(fs.existsSync(qrPath))fs.unlinkSync(qrPath);}catch{}
 try{
  if(mode==='--listar-grupos'){for(const group of await listGroups(client))console.log(`${group.name}\n  ${group.id}`);await client.destroy();return;}
  if(mode==='--teste'){if(!groupId)throw Error('Defina WHATSAPP_GROUP_ID no .env antes do teste.');await client.sendMessage(groupId,'Teste de integração - Sistema de Ferramentas');log.info('Mensagem de teste enviada.');await client.destroy();return;}
  const service=createNotificationService(createSupabase(),client);await service.recover();await service.process();setInterval(()=>service.process().catch(error=>log.error('Falha no ciclo de notificações.',error.message)),Math.max(1000,Number(process.env.CHECK_INTERVAL)||5000));
 }catch(error){log.error('Bot interrompido.',error.message);await client.destroy();process.exitCode=1;}
});
client.initialize();
