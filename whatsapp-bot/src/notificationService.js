const {buildMessage}=require('./messageTemplates');
const log=require('./logger');
function createNotificationService(supabase,client){
 const workerId=process.env.WORKER_ID||'quality-whatsapp-windows';
 async function recover(){const {error}=await supabase.rpc('quality_whatsapp_recover_stale',{p_age_minutes:15});if(error)throw error;}
 async function processQueue(){
  const {data:rows,error}=await supabase.rpc('quality_whatsapp_claim_pending',{p_worker_id:workerId,p_limit:10});if(error)throw error;
  for(const row of rows||[]){
   try{
    await client.sendMessage(row.whatsapp_group_id,buildMessage(row));
    const {error:sentError}=await supabase.from('quality_whatsapp_notifications').update({delivery_status:'enviado',sent_at:new Date().toISOString(),locked_at:null,locked_by:null,updated_at:new Date().toISOString()}).eq('id',row.id);
    if(sentError)throw sentError;
    log.info('Notificação enviada.',{id:row.id,event:row.event_type,tool:row.tool});
   }catch(error){
    await supabase.from('quality_whatsapp_notifications').update({delivery_status:'erro',last_error:String(error.message||error).slice(0,1000),locked_at:null,locked_by:null,updated_at:new Date().toISOString()}).eq('id',row.id);
    log.error('Falha ao enviar notificação.',error.message);
   }
  }
 }
 return {recover,process:processQueue};
}
module.exports={createNotificationService};
