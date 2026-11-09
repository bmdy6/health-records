import { test } from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import { consentPage } from './consent.mjs';
test('consent never forwards a saved binding from a different WebDAV target',async()=>{
 const page=consentPage('A'.repeat(43),['food:read','food:write'],'/workbench-agent','https://owner.example/dav/');
 const elements=Object.fromEntries(['consent','allow','deny','error','username','password','binding'].map(id=>[id,{value:'',textContent:'',addEventListener(){}}]));
 let sent;const context={URL,document:{getElementById:id=>elements[id]},localStorage:{getItem:()=>JSON.stringify({url:'https://other.example/dav/',username:'other-owner',password:'must-not-forward'})},fetch:async(_url,init)=>{sent=JSON.parse(init.body);return {ok:false};},location:{assign(){}}};
 vm.runInNewContext(/<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(page.html)[1],context);
 await context.connect(true);
 assert.equal(sent.password,'');assert.ok(!JSON.stringify(sent).includes('must-not-forward'));
 assert.ok(!page.html.includes('must-not-forward'));assert.match(page.html,/role="alert"/);
});

test('consent labels distinguish independent health, food and read/write privileges',()=>{
 const health=consentPage('A'.repeat(43),['health:read'],'/workbench-agent','https://owner.example/dav/').html;
 assert.match(health,/查看你的实际训练、目标、体重和身体资料/);assert.ok(!health.includes('新增和修改你的实际训练'));assert.ok(!health.includes('查看你的饮食记录'));
 const food=consentPage('A'.repeat(43),['food:read'],'/workbench-agent','https://owner.example/dav/').html;assert.match(food,/查看你的饮食记录/);assert.ok(!food.includes('查看你的实际训练'));
 const all=consentPage('A'.repeat(43),['food:read','food:write','health:read','health:write'],'/workbench-agent','https://owner.example/dav/').html;assert.match(all,/新增和修改你的实际训练、目标和体重/);
});

const grouped = scopes => consentPage('A'.repeat(43), scopes, '/workbench-agent', 'https://owner.example/dav/', { client: '这个 AI 客户端', disconnect: '你可以随时在该客户端里断开连接。', grouped: true }).html;
test('workbench consent follows the approved grouped design for actual scopes only', () => {
 const read = grouped(['food:read']);
 assert.match(read, /允许这个 AI 客户端使用：/);
 assert.match(read, /<strong>饮食<\/strong>/);
 assert.match(read, /只能查看/);
 assert.ok(!read.includes('<strong>健康</strong>'));
 assert.ok(!read.includes('新增和修改记录'));
 assert.ok(!read.includes('ChatGPT 和 Dot'));
 const write = grouped(['food:write']);
 assert.match(write, /新增和修改记录/);
 assert.ok(!write.includes('查看、新增和修改记录'));
 const all = grouped(['food:read', 'food:write', 'health:read', 'health:write']);
 assert.match(all, /查看、新增和修改记录/);
 assert.match(all, /查看和修改训练、目标、体重/);
 assert.match(all, /AI 不能删除任何记录，未列出的权限不会开放/);
 assert.match(all, /你可以随时在该客户端里断开连接。/);
 assert.ok(!all.includes('<strong>计划</strong>'));
});

test('failed consent restores controls and cancellation still sends allow false', async () => {
 const page = grouped(['food:read']);
 const elements = Object.fromEntries(['consent','allow','deny','error','username','password','binding'].map(id => [id,{ value:'', textContent:'', addEventListener(){} }]));
 let sent;
 const context = { URL, document:{getElementById:id=>elements[id]}, localStorage:{getItem:()=>null}, fetch:async(_url,init)=>{sent=JSON.parse(init.body);return {ok:false};}, location:{assign(){}} };
 vm.runInNewContext(/<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(page)[1],context);
 await context.connect(true);
 assert.equal(elements.allow.disabled,false);assert.equal(elements.deny.disabled,false);
 assert.equal(elements.allow.textContent,'允许连接');assert.match(elements.error.textContent,/连接未完成/);
 await context.connect(false);assert.equal(sent.allow,false);
});
