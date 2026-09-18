const stamp=()=>new Date().toLocaleString('pt-BR');
const log=(level,message,details)=>console.log(`[${stamp()}] ${level} ${message}`,details||'');
module.exports={info:(message,details)=>log('INFO',message,details),warn:(message,details)=>log('AVISO',message,details),error:(message,details)=>log('ERRO',message,details)};
