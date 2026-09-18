# Bot WhatsApp de Qualidade

1. Instale o Node.js 20 ou superior no computador Windows que ficará ligado.
2. Copie `.env.example` para `.env` e informe a URL e a chave `service_role` do Supabase.
3. Execute `start-bot.bat`. Na primeira vez, leia o QR Code com o número exclusivo do bot.
4. Execute `node src/index.js --listar-grupos`, copie o ID do grupo para `WHATSAPP_GROUP_ID` e reinicie o bot.
5. Execute `node src/index.js --teste` para enviar a mensagem de integração.

O diretório `.session` guarda somente a sessão local do WhatsApp e não deve ser versionado.
