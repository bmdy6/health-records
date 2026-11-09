#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { foodModule } from './food-agent.mjs';
import { registerFoodTools } from './food-remote/food-tools.mjs';
const config={url:process.env.HEALTH_WEBDAV_URL,username:process.env.HEALTH_WEBDAV_USER,password:process.env.HEALTH_WEBDAV_PASSWORD};
try {
 const {createFoodStore}=await foodModule();const store=createFoodStore(config);
 const server=new McpServer({name:'health-records',version:'0.1.0'});
 const register=(name,description,inputSchema,write,run)=>server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:!write,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async args=>{
  try{const value=await run(args);const payload={ok:true,...value};return {isError:false,content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload};}
  catch(error){const known=['input','auth','network','http','data','conflict','version','uncertain','not_found'].includes(error.code);const payload={ok:false,error:{code:known?error.code:'runtime',message:known?error.message:'Operation failed.',write_may_have_succeeded:error.uncertain===true}};return {isError:true,content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload};}
 });
 await registerFoodTools(register,store,['food:read','food:write','health:read','health:write'],config,fetch);
 await server.connect(new StdioServerTransport());
}catch{console.error('Health Records MCP configuration or startup failed. Set HEALTH_WEBDAV_URL, HEALTH_WEBDAV_USER and HEALTH_WEBDAV_PASSWORD.');process.exitCode=1;}
