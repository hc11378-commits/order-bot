process.env.NODE_ENV='test';
process.env.LINE_CHANNEL_SECRET='unsend-test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN='unsend-test-token';
process.env.MONGO_URI='mongodb://not-used';
process.env.TEST_MODE=process.env.UNSEND_TEST_MODE || 'true';
process.env.UNSEND_AUTO_PUSH='true';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const axios=require('axios');
const bot=require('./index');
let sequence=0;
async function scenario(fn,{multi=false,last=false}={}){
 const groupId='unsend-auto-'+(++sequence);
 const base={groupId,serviceYear:2026,date:'11/3',lineMessageId:'old-message',key:'ORDER001',orderId:'ORDER001',time:'09:00',type:'接',loc:'新北市板橋區',pax:1,price:700,remarks:[],cancelled:false};
 const records=[{...base},{...base,groupId:'another-group'}];
 if(!last)records.push({...base,key:'ORDER002',orderId:'ORDER002',lineMessageId:'keep-message',time:'10:00',price:800});
 if(multi)records.push({...base,key:'ORDER003',orderId:'ORDER003',date:'11/4'});
 let failWrite=false,failRead=false,failPush=false,failAck=false,conflict=false;
 const matches=(r,q)=>Object.entries(q).every(([k,v])=>r[k]===v);
 bot.__setOrdersCollectionForTests({
  find(q){if(failRead&&q.lineMessageId===undefined)throw Error('read failed');return {sort(){return this;},async toArray(){return structuredClone(records.filter(r=>matches(r,q)));}};},
  async updateMany(q,u){if(failWrite||failAck&&u.$set.unsendNotificationPending===false)throw Error('write failed');const found=records.filter(r=>matches(r,q));found.forEach(r=>Object.assign(r,u.$set));return {matchedCount:found.length,acknowledged:true};},
 });
 const pushes=[];const original=axios.post;
 axios.post=async(url,payload,options)=>{
  assert.match(url,/\/push$/);assert.equal(payload.to,groupId);
  pushes.push({text:payload.messages.map(m=>m.text).join('\n'),key:options.headers['X-Line-Retry-Key']});
  if(failPush)throw Error('LINE timeout');
  if(conflict)throw {response:{status:409,headers:{'x-line-accepted-request-id':'accepted'}}};
 };
 const server=bot.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const post=async(messageId='old-message')=>{
  const body=JSON.stringify({events:[{type:'unsend',source:{type:'group',groupId},unsend:{messageId}}]});
  const signature=crypto.createHmac('sha256',process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
  return (await fetch(`http://127.0.0.1:${server.address().port}/webhook`,{method:'POST',body,headers:{'content-type':'application/json','x-line-signature':signature}})).status;
 };
 try{await fn({records,pushes,post,groupId,setFailure(options){({failWrite=failWrite,failRead=failRead,failPush=failPush,failAck=failAck,conflict=conflict}=options);}});}
 finally{axios.post=original;bot.__setOrdersCollectionForTests(null);await new Promise(resolve=>server.close(resolve));}
}
test('TEST_MODE 收回後立即 Push 最新簡表，不需手動查詢或 replyToken',()=>scenario(async({post,records,pushes})=>{
 assert.equal(await post(),200);assert.equal(pushes.length,1);assert.match(pushes[0].text,/11\/3（更新）/);assert.match(pushes[0].text,/結算價合計：800/);assert.doesNotMatch(pushes[0].text,/09:00/);assert.equal(records[0].cancelled,true);assert.equal(records[1].cancelled,false);assert.equal(records[0].unsendNotificationPending,false);assert.match(pushes[0].key,/^[0-9a-f-]{36}$/);
 assert.equal(await post(),200);assert.equal(pushes.length,1);
}));
test('最後一筆收回也自動發送零筆簡表',()=>scenario(async({post,pushes})=>{assert.equal(await post(),200);assert.match(pushes[0].text,/目前無有效訂單/);assert.match(pushes[0].text,/業績合計：0/);},{last:true}));
test('一則訊息多日期全部更新',()=>scenario(async({post,pushes})=>{assert.equal(await post(),200);assert.equal(pushes.length,2);assert.match(pushes[1].text,/11\/4（更新）/);},{multi:true}));
test('資料庫取消失敗回傳500，重送後正常處理',()=>scenario(async({post,pushes,records,setFailure})=>{
 setFailure({failWrite:true});assert.equal(await post(),500);assert.equal(pushes.length,0);assert.equal(records[0].cancelled,false);
 setFailure({failWrite:false});assert.equal(await post(),200);assert.equal(pushes.length,1);
}));
test('完整簡表同步失敗不發錯誤總額，重送會補送',()=>scenario(async({post,pushes,records,setFailure})=>{
 setFailure({failRead:true});assert.equal(await post(),500);assert.equal(pushes.length,0);assert.equal(records[0].unsendNotificationPending,true);
 setFailure({failRead:false});assert.equal(await post(),200);assert.equal(pushes.length,1);
}));
test('Push失敗後，即使原單已取消仍能補送；重試鍵固定',()=>scenario(async({post,pushes,records,setFailure})=>{
 setFailure({failPush:true});assert.equal(await post(),500);assert.equal(records[0].cancelled,true);assert.equal(records[0].unsendNotificationPending,true);
 setFailure({failPush:false});assert.equal(await post(),200);assert.equal(pushes.length,2);assert.equal(pushes[0].key,pushes[1].key);assert.equal(records[0].unsendNotificationPending,false);
}));
test('推送已接受但回寫失敗，以409確認成功並清除待通知狀態',()=>scenario(async({post,pushes,records,setFailure})=>{
 setFailure({failAck:true});assert.equal(await post(),500);assert.equal(records[0].unsendNotificationPending,true);
 setFailure({failAck:false,conflict:true});assert.equal(await post(),200);assert.equal(pushes[0].key,pushes[1].key);assert.equal(records[0].unsendNotificationPending,false);
}));
test('未知訊息不推送；收回舊訊息不刪除相同訂單的新版',()=>scenario(async({post,pushes,records})=>{
 assert.equal(await post('unknown-message'),200);assert.equal(pushes.length,0);
 records[0].lineMessageId='new-message';assert.equal(await post(),200);assert.equal(records[0].cancelled,false);assert.equal(pushes.length,0);
}));
