import { useEffect, useState } from 'react';
import BodyPage from './features/body';
import BodySettings from './features/settings/body/BodySettings';
import { NarrationProvider } from './features/body/NarrationProvider';
import { getConfig, saveConfig, clearConfig, subscribeConfigChanges, type WebDavConfig } from './lib/webdav';
import { loadFoodLibrary, saveFoodLibrary } from './lib/food-library';

export default function App() {
 const [page,setPage]=useState(location.pathname.startsWith('/settings')?'settings':'records');
 const [binding,setBinding]=useState(getConfig);
 useEffect(()=>subscribeConfigChanges(()=>setBinding(getConfig())),[]);
 useEffect(()=>{loadFoodLibrary();const pop=()=>setPage(location.pathname.startsWith('/settings')?'settings':'records');window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[]);
 const navigate=(next:string)=>{history.pushState(null,'',next==='settings'?'/settings':'/');setPage(next);};
 return <NarrationProvider><div className="mx-auto max-w-3xl px-4 pb-16">
  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 py-5"><div><span className="text-lg font-semibold">Health Records</span><p className="text-xs text-neutral-500">饮食 · 实际训练 · 体重 · 目标</p></div><nav aria-label="主要导航" className="flex gap-2"><button className={page==='records'?'btn-primary':'btn-secondary'} onClick={()=>navigate('records')}>健康记录</button><button className={page==='settings'?'btn-primary':'btn-secondary'} onClick={()=>navigate('settings')}>设置</button></nav></header>
  <main className="py-6">{page==='settings'||!binding?<Settings binding={binding}/>:<><p className="mb-4 rounded-lg border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-600">名称查询需要食物库；未命中时需要配置识别服务。离线记录可先在设置导入包装营养数据。<a href="/settings" className="ml-1 underline">配置食物库</a></p><BodyPage/></>}</main>
  <footer className="border-t border-neutral-200 pt-4 text-xs leading-5 text-neutral-500">记录与估算供个人回顾。模型结果、食品库和目标推算需要核对，不能替代医疗或个体化营养建议。数据保存在你配置的 WebDAV。</footer>
 </div></NarrationProvider>;
}
function Settings({binding}:{binding:WebDavConfig|null}) {
 const [url,setUrl]=useState(binding?.url??'http://127.0.0.1:18740/dav/');
 const [username,setUsername]=useState(binding?.username??'demo');const [password,setPassword]=useState('');
 const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
 const [library,setLibrary]=useState(loadFoodLibrary);
 async function connect(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage('');
  try{const endpoint=new URL(url);if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('请输入不含凭据的 WebDAV URL');
   if(endpoint.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw new Error('外部 WebDAV 必须使用 HTTPS');
   if(!/^[a-zA-Z0-9_-]+$/.test(username)||username==='shared-viewer')throw new Error('用户名只支持字母、数字、下划线和短横线');
   const secret=password||(binding?.url===url&&binding.username===username?binding.password:'');if(!secret)throw new Error('请输入密码');
   const response=await fetch(endpoint.href.replace(/\/$/,'')+'/bills/_settings.json',{headers:{Authorization:'Basic '+btoa(username+':'+secret)},signal:AbortSignal.timeout(15000)});
   if(!response.ok&&response.status!==404)throw new Error('连接失败，请核对地址、凭据和 CORS 设置');
   saveConfig({url:endpoint.href,username,password:secret});setPassword('');setMessage('连接已保存。可返回健康记录。');
  }catch(e){setMessage(e instanceof Error?e.message:'连接失败');}finally{setBusy(false);}}
 return <div><h1 className="page-title">设置</h1><p className="page-sub">连接你自己的 WebDAV；MCP 使用相同地址与账号。</p>
 <form onSubmit={connect} className="card mt-5 space-y-4 p-5"><h2 className="font-semibold">数据连接</h2><label className="block text-sm">WebDAV URL<input required className="input mt-1" value={url} onChange={e=>setUrl(e.target.value)} type="url"/></label><label className="block text-sm">用户名<input required className="input mt-1" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username"/></label><label className="block text-sm">密码<input className="input mt-1" value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="current-password" placeholder={binding?'留空保留当前密码':''}/></label><p className="text-xs leading-5 text-neutral-500">凭据保存在此浏览器 localStorage，请使用独立最小权限账号。首次本地开发使用 demo / demo-only；仅限回环地址，非生产账号。外部 DAV 请先创建 personal/用户名/body 与 bills 目录。</p><div className="flex gap-3"><button disabled={busy} className="btn-primary">{busy?'连接中…':'保存连接'}</button>{binding&&<button type="button" className="btn-secondary" onClick={()=>{clearConfig();setMessage('已断开此浏览器连接，服务器数据保留。');}}>断开连接</button>}</div>{message&&<p role="status" className="text-sm">{message}</p>}</form>
 <section className="card mt-5 space-y-3 p-5"><h2 className="font-semibold">食物营养库</h2><p className="text-sm text-neutral-600">{library?`已载入 ${library.foods.length} 项。来源：${library.source}`:'默认不附带第三方营养表。可导入你有权使用的每 100g 食品数据；没有库时可通过识别服务估算并核对。'}</p><label className="block text-sm">导入 JSON 食物库<input type="file" accept="application/json,.json" className="mt-2 block w-full text-sm" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{setLibrary(saveFoodLibrary(await file.text()));setMessage('食物库已导入。请核对来源和数值。');}catch(error){setMessage(error instanceof Error?error.message:'导入失败');}e.target.value='';}}/></label><p className="text-xs text-neutral-500"><a href="/food-library-template.json" download className="underline">下载待填写模板</a>（先填来源与每 100g 数值，空值会被拒绝）。当前库只存此浏览器。</p></section>
 {binding&&<section id="body"><BodySettings binding={binding}/></section>}
 </div>;
}
