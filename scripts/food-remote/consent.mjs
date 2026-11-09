// First-party, one-time connection page. Runtime secrets never appear in this HTML.
import { randomBytes } from 'node:crypto';
export function consentPage(ticket, scopes, basePath, expectedDavUrl, { client = 'ChatGPT 和 Dot', disconnect = '你可以随时在 ChatGPT 插件设置中断开连接。', grouped = false } = {}) {
  const expectedTarget = JSON.stringify(new URL(expectedDavUrl).href.replace(/\/$/, '')).replaceAll('<', '\\u003c');
  const nonce = randomBytes(16).toString('base64');
  const rights = [scopes.includes('food:read') ? '查看你的饮食记录' : '', scopes.includes('food:write') ? '新增和修改你的饮食记录' : '', scopes.includes('health:read') ? '查看你的实际训练、目标、体重和身体资料' : '', scopes.includes('health:write') ? '新增和修改你的实际训练、目标和体重' : ''].filter(Boolean).join('；');
  const rows = [
    ['food', '饮食', '查看、新增和修改记录', '新增和修改记录'],
    ['health', '健康', '查看和修改训练、目标、体重', '修改训练、目标、体重'],
  ].filter(([scope]) => scopes.includes(scope + ':read') || scopes.includes(scope + ':write'))
    .map(([scope, label, both, write]) => `<li><strong>${label}</strong><span>${scopes.includes(scope + ':write') ? (scopes.includes(scope + ':read') ? both : write) : '只能查看'}</span></li>`).join('');
  const permissions = grouped ? `<p>允许${client}使用：</p><ul class="permissions" aria-label="本次授权权限">${rows}</ul><p class="explanation">健康记录展示同一份记录。AI 不能删除任何记录，未列出的权限不会开放。</p>` : `<p>允许${client} ${rights}。</p><p>健康记录展示同一份记录。健康与饮食权限分别授权；未列出的权限不会开放。</p>`;
  return { nonce, html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接Health Records</title>
<style>body{font:16px system-ui;background:#f6f6f3;color:#171717;margin:0;padding:24px}main{max-width:400px;margin:48px auto;background:white;border:1px solid #e5e5e5;border-radius:20px;padding:24px}h1{font-size:24px}p{line-height:1.7;color:#525252}label{display:block;margin-top:16px}input,button{box-sizing:border-box;width:100%;min-height:44px;border-radius:10px;font:inherit}input{border:1px solid #d4d4d4;padding:10px;margin-top:6px}button{border:0;background:#171717;color:white;margin-top:20px;padding:10px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.cancel{background:#f5f5f5;color:#404040;margin-top:8px}a{color:inherit}#error{color:#b91c1c}small{color:#737373}${grouped ? '.permissions{list-style:none;padding:0;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden}.permissions li{display:flex;gap:12px;padding:10px 12px;line-height:1.7}.permissions li+li{border-top:1px solid #f0f0f0}.permissions strong{flex-shrink:0}.permissions span{color:#525252}.explanation{font-size:14px}' : ''}</style>
<main data-ticket="${ticket}"><h1>连接Health Records</h1>${permissions}
<form id="consent"><label for="username">健康记录账号</label><input id="username" autocomplete="username" required><label for="password">密码</label><input id="password" type="password" autocomplete="current-password"><p id="binding" hidden>将使用这个浏览器已绑定的健康记录账号。</p><p id="error" role="alert" aria-live="polite"></p><button id="allow" type="submit">允许连接</button><button id="deny" class="cancel" type="button">取消</button></form><p><small>本次仅开放上面列出的权限。${disconnect}</small></p><a href="/settings" target="_blank" rel="noopener">打开健康记录设置</a></main>
<script nonce="${nonce}">
const form=document.getElementById('consent'),allow=document.getElementById('allow'),deny=document.getElementById('deny'),error=document.getElementById('error'),user=document.getElementById('username'),password=document.getElementById('password');
let binding;try{binding=JSON.parse(localStorage.getItem('webdav-config'));if(!binding?.url||new URL(binding.url).href.replace(/\\/$/,'')!==${expectedTarget})binding=undefined;if(binding?.username&&binding?.password){user.value=binding.username;document.getElementById('binding').hidden=false;}}catch{binding=undefined;}
async function connect(approved){allow.disabled=deny.disabled=true;allow.textContent='正在连接…';error.textContent='';try{
const body={ticket:'${ticket}',allow:approved,username:user.value,password:password.value||(binding?.username===user.value?binding.password:'')};
const result=await fetch('${basePath}/confirm',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',body:JSON.stringify(body)});
if(!result.ok)throw Error('连接未完成，请核对健康记录账号和密码，或重新发起授权。');
const data=await result.json();location.assign(data.redirect);
}catch(e){error.textContent='连接未完成，请核对健康记录账号和密码，或重新发起授权。';allow.disabled=deny.disabled=false;allow.textContent='允许连接';}}
form.addEventListener('submit',e=>{e.preventDefault();connect(true);});deny.addEventListener('click',()=>connect(false));
</script></html>` };
}
