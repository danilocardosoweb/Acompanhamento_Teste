const {createClient}=require('@supabase/supabase-js');
function createSupabase(){
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw Error('Preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env.');
 return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}
module.exports={createSupabase};
