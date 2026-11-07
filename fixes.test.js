process.env.NODE_ENV='test';
process.env.LINE_CHANNEL_SECRET='fix-test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN='test-token';
process.env.MONGO_URI='mongodb://not-used';
process.env.TEST_MODE='true';
process.env.UNSEND_AUTO_PUSH='false';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const axios=require('axios');const bot=require('./index');
const send='"休旅送機  WJP796330  出發日期：11/6 09:00  乘車人數：1  行李數量：  航班編號：--  上車地點：新竹東區東勢里東竹路51號  下車地點：桃園機場  其他備註：-  聯絡人：測試乘客  電話：0900000000  結算價：1000.0"';
const pickup='"經五接機  QNM340453  出發日期：11/6  乘車人數：1  行李數量：  航班編號：CI54【05:45】  上車地點：桃園機場  下車地點：新竹市東區光復路一段163巷4號  其他備註：LINE: 0900000000  聯絡人：測試乘客  電話：0900000000  結算價：1035"  司機資料：測試司機 電話：0900000000 車號：TEST-1234 車型：賓士Vito';
for(const [text,id,time,price]of [[send,'WJP796330','09:00',1000],[pickup,'QNM340453','05:45',1035]])test(`使用者整行訂單 ${id}`,()=>{const orders=bot.parseOrders(text);assert.equal(orders.length,1);assert.equal(orders[0].orderId,id);assert.equal(orders[0].loc,'新竹市東區');assert.equal(orders[0].time,time);assert.equal(orders[0].price,price);});
for(const [address,full]of [['新竹東區東勢里','新竹市東區'],['新竹北區','新竹市北區'],['新竹香山區','新竹市香山區'],['新竹竹北市','新竹縣竹北市'],['嘉義東區','嘉義市東區'],['嘉義民雄鄉','嘉義縣民雄鄉']])test(`省略縣市尾字 ${address}`,()=>assert.equal(bot.parseAddr(address),full));
test('未提供縣市的中正區仍不亂猜',()=>assert.equal(bot.parseAddr('中正區'), '縣市待確認：中正區'));
for(const [text,time,type]of [['22補','22:00','送'],['補0430的送','04:30','送'],['補0430送','04:30','送'],['補04:30送','04:30','送'],['補22送','22:00','送'],['0430補接','04:30','接'],['補４３０接','04:30','接']])test(`補單格式 ${text}`,()=>{const p=bot.parsePlaceholder(text);assert.equal(p.time,time);assert.equal(p.type,type);});
for(const text of ['補2460送','補24送','補1360送'])test(`補單無效時間 ${text}`,()=>assert.ok(bot.parsePlaceholder(text).error));
let seq=0;
function matches(r,q){return Object.entries(q).every(([k,v])=>k==='$or'?v.some(x=>matches(r,x)):v&&typeof v==='object'&&'$ne'in v?r[k]!==v.$ne:v&&typeof v==='object'&&'$regex'in v?v.$regex.test(r[k]):r[k]===v);}
async function harness(fn){
 const groupId='fix-'+(++seq),records=[];let fail=false;let counter=0;
 bot.__setOrdersCollectionForTests({
  async findOne(q){return structuredClone(records.find(r=>matches(r,q))||null);},
  find(q){let found=records.filter(r=>matches(r,q));return {sort(){found.sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));return this;},limit(n){found=found.slice(0,n);return this;},async toArray(){return structuredClone(found);}};},
  async updateOne(q,u,o={}){if(fail)throw Error('write failure');let r=records.find(r=>matches(r,q));if(!r&&o.upsert){r={...q};records.push(r);}if(r)Object.assign(r,u.$set);return {acknowledged:true,matchedCount:r?1:0};},
  async updateMany(q,u){if(fail)throw Error('write failure');const found=records.filter(r=>matches(r,q));found.forEach(r=>Object.assign(r,u.$set));return {acknowledged:true,matchedCount:found.length};},
 });
 const replies=[];const original=axios.post;axios.post=async(u,p)=>{replies.push(p.messages.map(m=>m.text).join('\n'));};
 const server=bot.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const post=async(text,id='msg-'+(++counter),redelivery=false,timestamp=Date.now()+(++counter)*10000)=>{
  const body=JSON.stringify({events:[{type:'message',timestamp,deliveryContext:{isRedelivery:redelivery},replyToken:'test',source:{type:'group',groupId},message:{type:'text',id,text}}]});const signature=crypto.createHmac('sha256',process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/webhook`,{method:'POST',body,headers:{'content-type':'application/json','x-line-signature':signature}})).status,200);return replies.at(-1);
 };
 try{await fn({post,records,groupId,failWrite(){fail=true;},restart(){delete bot.__state.dailyOrders[groupId];delete bot.__state.lastActiveDate[groupId];}});}finally{axios.post=original;bot.__setOrdersCollectionForTests(null);await new Promise(resolve=>server.close(resolve));}
}
for(const command of ['拉回','取消','拉回改派'])test(`誤${command}後新訊息可恢復，舊訊息重送不覆蓋`,()=>harness(async({post,records})=>{
 const text=send.replace('WJP796330','GTJ214193');await post(text,'original');await post(`GTJ214193 ${command}`,'cancel');
 assert.match(await post(text,'original',true),/已忽略/);
 assert.match(await post(text,'restored'),/送新竹東/);
 assert.equal(records.filter(r=>r.key==='GTJ214193'&&!r.cancelled).length,1);
 assert.match(await post(text.replace('1000.0','1.0'),'original',true),/已忽略/);
 assert.equal(records.find(r=>r.key==='GTJ214193'&&!r.cancelled).price,1000);
}));
test('LINE收回後重貼可恢復；重啟後也不接受原舊訊息',()=>harness(async({post,records,groupId,restart})=>{
 await post(send,'original');await bot.handleLineUnsend(groupId,'original');await post(send,'restored');restart();await post(send.replace('1000.0','2.0'),'original',true);
 assert.equal(records.filter(r=>!r.cancelled).length,1);assert.equal(records.find(r=>!r.cancelled).price,1000);
}));
test('補單持久化，重啟後同時段正式單會自動取代補單',()=>harness(async({post,records,restart})=>{
 await post(send);assert.match(await post('22補'),/補22送/);assert.match(await post('補0430的送'),/補04:30送/);restart();
 const summary=await post(pickup);assert.match(summary,/補22送/);assert.match(summary,/補04:30送/);assert.match(summary,/結算價合計：2035/);
 const next=await post(send.replace('WJP796330','NEW123456').replace('09:00','04:30'));assert.doesNotMatch(next,/補04:30送/);assert.match(next,/04:30/);assert.match(next,/補22送/);
 const cleared=await post('取消補0430送');assert.doesNotMatch(cleared,/補04:30送/);assert.match(cleared,/補22送/);restart();assert.doesNotMatch(await post(pickup),/補04:30送/);
 assert.equal(records.filter(r=>r.isPlaceholder&&!r.cancelled).length,1);
}));
test('補單寫入失敗不假裝成功',()=>harness(async({post,records,failWrite})=>{await post(send);failWrite();assert.match(await post('補22送'),/補單儲存失敗/);assert.equal(records.some(r=>r.isPlaceholder),false);}));
test('同一占位重貼不重複，月份總額不包含補單',()=>harness(async({post,records})=>{await post(send);await post('22補');await post('補22送');assert.equal(records.filter(r=>r.isPlaceholder&&!r.cancelled).length,1);const report=await post('月結11');assert.match(report,/總趟數：1 趟/);assert.match(report,/結算價總額：1000/);}));

test('使用者11/6七筆加補單仍維持6724結算與6924業績',()=>harness(async({post})=>{
 await post(send);await post(pickup);
 const extras=[['MORE00001','03:00',1279,'新北市汐止區'],['MORE00002','09:15',894,'中正區'],['MORE00003','11:30',637,'台北市中山區'],['MORE00004','11:30',1199,'台北市萬華區'],['MORE00005','14:30',680,'台北市中山區']];
 for(const [id,time,price,loc] of extras){let text=send.replace('WJP796330',id).replace('09:00',time).replace('1000.0',String(price)).replace('新竹東區東勢里東竹路51號',loc);if(id==='MORE00001')text+='\n客收：200';await post(text);}
 const summary=await post('22補');assert.match(summary,/結算價合計：6724/);assert.match(summary,/客收合計：200/);assert.match(summary,/業績合計：6924/);assert.match(summary,/補22送/);assert.match(summary,/縣市待確認：中正區/);assert.match(summary,/送新竹東/);
}));
test('重新派單寫入失敗時原取消狀態不被改動',()=>harness(async({post,records,failWrite})=>{await post(send,'old');await post('WJP796330 拉回');failWrite();assert.match(await post(send,'new'),/儲存失敗/);assert.equal(records.filter(r=>!r.cancelled).length,0);}));
test('同小時不同分鐘的補單各自保留',()=>harness(async({post,records})=>{await post(send);await post('補0430送');const summary=await post('補0445送');assert.match(summary,/補04:30送/);assert.match(summary,/補04:45送/);assert.equal(records.filter(r=>r.isPlaceholder&&!r.cancelled).length,2);}));
test('可指定補單日期，不誤用最近服務日',()=>harness(async({post,records})=>{await post(send);const summary=await post('11/7 22補');assert.match(summary,/11\/7/);assert.equal(records.find(r=>r.isPlaceholder).date,'11/7');}));
