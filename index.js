const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

const CHANNEL_SECRET = 'ce5aafad66d4ea009b1f9ae3046035dd';
const CHANNEL_ACCESS_TOKEN = 't7lUw3SX7cQVJpH5NthljqiLL5mBWCK9bFL1fam+ow99XRyrRK/2rw+5zxQtV3CmVn5jHGe8wsJFQ8cwHLOi2YAGENNR33yth7rIX6D6qSNDZbt2OcsO/opT1aIXhSS4f4qfx1k+uI5t8SjRxk9S2QdB04t89/1O/w1cDnyilFU=';

// ── 儲存：當天訂單（key=訂單編號, value=訂單資料）──
// 格式: { [date]: { [orderId]: orderObj | null(取消) } }
const dailyOrders = {};

// ── 計時器：5分鐘後發簡表 ──
const pendingTimers = {}; // key=groupId+date

// ── 是否有異動（取消/改派/拉回）──
const hasChanges = {}; // key=date, value=true/false

// ── 23:50 定時發送 ──
let lastScheduledDate = '';

// ════════════════════════════════════════
// 地點解析（完整版）
// ════════════════════════════════════════
const CITY_MAP = {
  '台北市':'台北','臺北市':'台北','新北市':'新北','桃園市':'桃園',
  '台中市':'台中','臺中市':'台中','台南市':'台南','臺南市':'台南',
  '高雄市':'高雄','新竹市':'新竹','新竹縣':'新竹','基隆市':'基隆',
  '嘉義市':'嘉義','嘉義縣':'嘉義','宜蘭縣':'宜蘭','花蓮縣':'花蓮',
  '台東縣':'台東','臺東縣':'台東','苗栗縣':'苗栗','彰化縣':'彰化',
  '南投縣':'南投','雲林縣':'雲林','屏東縣':'屏東','澎湖縣':'澎湖',
  '台北':'台北','臺北':'台北','新北':'新北','桃園':'桃園',
  '台中':'台中','臺中':'台中','台南':'台南','臺南':'台南',
  '高雄':'高雄','新竹':'新竹','基隆':'基隆','嘉義':'嘉義',
  '宜蘭':'宜蘭','花蓮':'花蓮','台東':'台東','臺東':'台東',
  '苗栗':'苗栗','彰化':'彰化','南投':'南投','雲林':'雲林','屏東':'屏東',
};

const DIST_MAP = {
  '中正區':'中正','大同區':'大同','中山區':'中山','松山區':'松山','大安區':'大安',
  '萬華區':'萬華','信義區':'信義','士林區':'士林','北投區':'北投','內湖區':'內湖',
  '南港區':'南港','文山區':'文山',
  '板橋區':'板橋','三重區':'三重','中和區':'中和','永和區':'永和','新莊區':'新莊',
  '新店區':'新店','樹林區':'樹林','鶯歌區':'鶯歌','三峽區':'三峽','淡水區':'淡水',
  '汐止區':'汐止','瑞芳區':'瑞芳','土城區':'土城','蘆洲區':'蘆洲','五股區':'五股',
  '泰山區':'泰山','林口區':'林口','深坑區':'深坑','三芝區':'三芝','八里區':'八里',
  '金山區':'金山','萬里區':'萬里','烏來區':'烏來',
  '桃園區':'桃園','中壢區':'中壢','大溪區':'大溪','楊梅區':'楊梅','蘆竹區':'蘆竹',
  '大園區':'大園','龜山區':'龜山','八德區':'八德','龍潭區':'龍潭','平鎮區':'平鎮',
  '新屋區':'新屋','觀音區':'觀音','復興區':'復興',
  '西屯區':'西屯','南屯區':'南屯','北屯區':'北屯','豐原區':'豐原','東勢區':'東勢',
  '大甲區':'大甲','清水區':'清水','沙鹿區':'沙鹿','梧棲區':'梧棲','后里區':'后里',
  '神岡區':'神岡','潭子區':'潭子','大雅區':'大雅','烏日區':'烏日','大肚區':'大肚',
  '龍井區':'龍井','霧峰區':'霧峰','太平區':'太平','大里區':'大里','和平區':'和平',
  '永康區':'永康','歸仁區':'歸仁','新化區':'新化','仁德區':'仁德','安平區':'安平',
  '安南區':'安南','新營區':'新營','後壁區':'後壁','白河區':'白河','善化區':'善化',
  '新市區':'新市','麻豆區':'麻豆','佳里區':'佳里','官田區':'官田',
  '新興區':'新興','前金區':'前金','苓雅區':'苓雅','鹽埕區':'鹽埕','鼓山區':'鼓山',
  '旗津區':'旗津','前鎮區':'前鎮','三民區':'三民','楠梓區':'楠梓','小港區':'小港',
  '左營區':'左營','仁武區':'仁武','大社區':'大社','岡山區':'岡山','路竹區':'路竹',
  '燕巢區':'燕巢','橋頭區':'橋頭','鳳山區':'鳳山','大寮區':'大寮','林園區':'林園',
  '鳥松區':'鳥松','大樹區':'大樹','旗山區':'旗山','美濃區':'美濃','茄萣區':'茄萣',
  '香山區':'香山',
  '竹北市':'竹北','湖口鄉':'湖口','新豐鄉':'新豐','新埔鎮':'新埔','關西鎮':'關西',
  '竹東鎮':'竹東','橫山鄉':'橫山','北埔鄉':'北埔','峨眉鄉':'峨眉','寶山鄉':'寶山',
  '暖暖區':'暖暖','七堵區':'七堵',
  '礁溪鄉':'礁溪','羅東鎮':'羅東','頭城鎮':'頭城','蘇澳鎮':'蘇澳','冬山鄉':'冬山',
  '五結鄉':'五結','員山鄉':'員山','壯圍鄉':'壯圍','南澳鄉':'南澳',
  '花蓮市':'花蓮市','吉安鄉':'吉安','壽豐鄉':'壽豐','鳳林鎮':'鳳林','玉里鎮':'玉里',
  '台東市':'台東市','臺東市':'台東市','成功鎮':'成功','關山鎮':'關山',
  '鹿野鄉':'鹿野','池上鄉':'池上',
  '苗栗市':'苗栗市','竹南鎮':'竹南','頭份市':'頭份','苑裡鎮':'苑裡','三義鄉':'三義',
  '彰化市':'彰化市','鹿港鎮':'鹿港','和美鎮':'和美','員林市':'員林','溪湖鎮':'溪湖',
  '南投市':'南投市','草屯鎮':'草屯','埔里鎮':'埔里','竹山鎮':'竹山',
  '斗六市':'斗六','虎尾鎮':'虎尾','西螺鎮':'西螺','北港鎮':'北港',
  '朴子市':'朴子','民雄鄉':'民雄','大林鎮':'大林',
  '屏東市':'屏東市','潮州鎮':'潮州','東港鎮':'東港','恆春鎮':'恆春',
};

const REMARK_RULES = [
  { keys: ['舉牌','举牌','sign','placard'], label: '舉牌' },
  { keys: ['兒童安全座椅','兒童座椅','安全座椅','嬰兒座椅','child seat','carseat'], label: '兒童座椅' },
  { keys: ['增高墊','增高垫','booster'], label: '增高墊' },
];

function getCity(addr) {
  const keys = Object.keys(CITY_MAP).sort((a,b) => b.length - a.length);
  for (const k of keys) { if (addr.includes(k)) return CITY_MAP[k]; }
  return null;
}

function parseAddr(addr) {
  if (!addr || addr.match(/^桃園機場|^桃機|^機場/i)) return null;
  const city = getCity(addr);
  const distKeys = Object.keys(DIST_MAP).sort((a,b) => b.length - a.length);
  for (const k of distKeys) {
    if (addr.includes(k)) return (city || '台北') + DIST_MAP[k];
  }
  const m = addr.match(/[市縣]([^\s市縣，,\/\d]{2,3})[區鄉鎮市]/);
  if (m && !m[1].match(/機場|桃機/)) return (city || '台北') + m[1];
  return city || null;
}

function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    const t = l.trim().replace(/^["""「]/, '');
    // 新訂單開頭：車型（九座送機）或 純訂單編號行（NFZ515768）
    const isNewBlock =
      t.match(/^([一二三四五六七八九十\d]+座|經五|商務|轎車|休旅|廂型)\s*(送機|接機)/) ||
      (t.match(/^[A-Z0-9]{6,15}$/) && cur.length > 0 && !cur.join('').includes('結算價'));
    if (isNewBlock && cur.length > 0) {
      blocks.push(cur.join('\n'));
      cur = [l];
    } else { cur.push(l); }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.filter(b => b.match(/結算價/));
}

function extractOrderId(block) {
  // 抓訂單編號（英數字組合，通常在第二行）
  const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const l of lines) {
    const m = l.match(/^([A-Z]{2,3}\d{6,9}|[A-Z0-9]{8,12})$/);
    if (m) return m[1];
  }
  return null;
}

function extractTime(block) {
  let m = block.match(/出發日期[：:]\s*[\d/]+\s+(\d{1,2}:\d{2})/);
  if (m) return m[1];
  m = block.match(/【(\d{1,2}:\d{2})】/);
  if (m) return m[1];
  m = block.match(/\((\d{1,2}:\d{2})\)/);
  if (m) return m[1];
  return null;
}

function extractDate(block) {
  const m = block.match(/出發日期[：:]\s*([\d/]+)/);
  return m ? m[1] : null;
}

function extractPrice(block) {
  const m = block.match(/結算價[：:\s]*([\d,]+\.?\d*)/);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ''));
}

function extractType(block) {
  const lines = block.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  // 先從第一行找車型
  const first = lines[0] || '';
  if (first.includes('接機')) return '接';
  if (first.includes('送機')) return '送';
  // 從任何一行找接機/送機關鍵字
  for (const l of lines) {
    if (l.includes('接機')) return '接';
    if (l.includes('送機')) return '送';
  }
  // 從下車地點判斷
  const toM = block.match(/下車地點[：:]\s*(.+)/);
  if (toM && toM[1].match(/機場|桃機/)) return '送';
  const fromM = block.match(/上車地點[：:]\s*(.+)/);
  if (fromM && fromM[1].match(/機場|桃機/)) return '接';
  return '接';
}

function extractLocation(block, type) {
  const main = type === '接' ? '下車地點' : '上車地點';
  const alt  = type === '接' ? '上車地點' : '下車地點';
  const m1 = block.match(new RegExp(main + '[：:]\\s*(.+)'));
  let addr = m1 ? m1[1].trim() : '';
  if (!addr || addr.match(/桃園機場|桃機|機場t/i)) {
    const m2 = block.match(new RegExp(alt + '[：:]\\s*(.+)'));
    addr = m2 ? m2[1].trim() : '';
  }
  return parseAddr(addr) || '';
}

function detectRemarks(block) {
  const found = [];
  const kesuM = block.match(/客收\s*(\d+)/);
  if (kesuM) found.push('客收' + kesuM[1]);
  const rLine = block.match(/其他備註[：:]\s*(.+)/);
  if (rLine) {
    const note = rLine[1].trim().toLowerCase();
    if (note && note !== '-' && note !== '無') {
      for (const rule of REMARK_RULES) {
        if (rule.keys.some(k => note.includes(k.toLowerCase()))) found.push(rule.label);
      }
    }
  }
  return found;
}

function parseOrders(text) {
  const blocks = splitBlocks(text);
  const results = [];
  const seen = new Set();
  blocks.forEach(b => {
    const time  = extractTime(b);
    const price = extractPrice(b);
    const orderId = extractOrderId(b);
    if (!time || !price) return;
    const key = orderId || `${time}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);
    const paxM = b.match(/乘車人數[：:]\s*(\d+)/);
    const pax  = paxM ? parseInt(paxM[1]) : 1;
    const type = extractType(b);
    const loc  = extractLocation(b, type);
    const remarks = detectRemarks(b);
    const date = extractDate(b);
    results.push({ orderId, time, pax, price, loc, type, remarks, date });
  });
  return results;
}

function toMin(t) { const [h,m]=t.split(':').map(Number); return h*60+m; }
function fmtP(p) { return p%1===0 ? String(p) : p.toFixed(1); }

function buildSummary(date, orders) {
  const active = Object.values(orders).filter(o => o !== null);
  if (!active.length) return null;
  active.sort((a,b) => toMin(a.time) - toMin(b.time));

  const kesuList = [];
  const otherCount = {};
  active.forEach(o => o.remarks.forEach(r => {
    if (r.startsWith('客收')) kesuList.push(r);
    else otherCount[r] = (otherCount[r]||0) + 1;
  }));

  let total = 0;
  const lines = [date + (hasChanges[date] ? '（更新）' : '')];
  active.forEach((o, i) => {
    total += o.price;
    const rStr = o.remarks.length ? o.remarks.join('、')+'，' : '';
    const locStr = o.type === '接' ? `接${o.loc}` : `${o.loc}送`;
    lines.push(`${i+1}。${o.time}，${locStr}，${rStr}${o.pax}人，${fmtP(o.price)}`);
  });
  const parts = [];
  if (kesuList.length) parts.push(kesuList.join('、'));
  Object.entries(otherCount).forEach(([k,v]) => parts.push(k+'*'+v));
  lines.push('結：' + fmtP(total) + (parts.length ? '，'+parts.join('、') : ''));
  return lines.join('\n');
}

// ════════════════════════════════════════
// LINE API
// ════════════════════════════════════════
async function pushMessage(groupId, text) {
  await axios.post('https://api.line.me/v2/bot/message/push', {
    to: groupId,
    messages: [{ type: 'text', text }]
  }, {
    headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
  });
}

async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: [{ type: 'text', text }]
  }, {
    headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
  });
}

// 5分鐘後發簡表
function scheduleFlush(groupId, date) {
  const key = groupId + '|' + date;
  if (pendingTimers[key]) clearTimeout(pendingTimers[key]);
  pendingTimers[key] = setTimeout(async () => {
    delete pendingTimers[key];
    const orders = dailyOrders[date];
    if (!orders) return;
    const summary = buildSummary(date, orders);
    if (summary) await pushMessage(groupId, summary);
  }, 5 * 60 * 1000); // 5分鐘
}

// ════════════════════════════════════════
// Webhook
// ════════════════════════════════════════
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function verifySignature(req) {
  const sig = req.headers['x-line-signature'];
  if (!sig) return false;
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(req.rawBody).digest('base64');
  return hash === sig;
}

// 每分鐘檢查是否到23:50
setInterval(async () => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const dateStr = `${now.getMonth()+1}/${now.getDate()}`;
  if (h === 23 && m === 50 && lastScheduledDate !== dateStr) {
    lastScheduledDate = dateStr;
    // 發當天有異動的簡表
    if (hasChanges[dateStr] && dailyOrders[dateStr]) {
      for (const groupId of Object.keys(groupIds)) {
        const summary = buildSummary(dateStr, dailyOrders[dateStr]);
        if (summary) await pushMessage(groupId, summary);
      }
    }
  }
}, 60 * 1000);

// 記錄群組ID
const groupIds = {};

app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.status(403).send('Forbidden');
  res.sendStatus(200);

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text.trim();
    const sourceId = event.source.groupId || event.source.userId;
    if (!sourceId) continue;
    groupIds[sourceId] = true;

    // ── 1. 取消：「XXX 訂單取消」或「XXX 取消」──
    const cancelM = text.match(/([A-Z0-9]{6,12})\s*(訂單取消|取消)/);
    if (cancelM) {
      const orderId = cancelM[1];
      for (const date of Object.keys(dailyOrders)) {
        if (dailyOrders[date][orderId] !== undefined) {
          dailyOrders[date][orderId] = null;
          hasChanges[date] = true;
          scheduleFlush(sourceId, date);
          break;
        }
      }
      continue;
    }

    // ── 2. 拉回改派：「拉回改派 XXXX」→ 先移除，等新訂單進來 ──
    const pullReassignM = text.match(/拉回改派\s*([A-Z0-9]{6,12})/);
    if (pullReassignM) {
      const orderId = pullReassignM[1];
      for (const date of Object.keys(dailyOrders)) {
        if (dailyOrders[date][orderId] !== undefined) {
          dailyOrders[date][orderId] = null;
          hasChanges[date] = true;
          scheduleFlush(sourceId, date);
          break;
        }
      }
      continue;
    }

    // ── 3. 改派：「XXX 改派」+ 新訂單內容 ──
    const reassignM = text.match(/([A-Z0-9]{6,12})\s*改派/);
    if (reassignM) {
      const oldId = reassignM[1];
      for (const date of Object.keys(dailyOrders)) {
        if (dailyOrders[date][oldId] !== undefined) {
          dailyOrders[date][oldId] = null;
          hasChanges[date] = true;
          break;
        }
      }
      const newOrders = parseOrders(text);
      for (const o of newOrders) {
        const date = o.date || getTodayStr();
        if (!dailyOrders[date]) dailyOrders[date] = {};
        const key = o.orderId || `${o.time}|${o.price}`;
        dailyOrders[date][key] = o;
        hasChanges[date] = true;
      }
      const date = newOrders[0]?.date || getTodayStr();
      scheduleFlush(sourceId, date);
      continue;
    }

    // ── 4. 拉回：「XXX 拉回」或「XXX ...拉回」或「我先拉回」──
    const pullbackM = text.match(/([A-Z0-9]{6,12})[^\n]*拉回/) || text.match(/拉回/);
    if (pullbackM) {
      if (pullbackM[1]) {
        const orderId = pullbackM[1];
        for (const date of Object.keys(dailyOrders)) {
          if (dailyOrders[date][orderId] !== undefined) {
            dailyOrders[date][orderId] = null;
            hasChanges[date] = true;
            scheduleFlush(sourceId, date);
            break;
          }
        }
      }
      continue;
    }

    // ── 5. 航班通知（忽略，不影響簡表）──
    if (text.match(/([A-Z0-9]{6,12})\s*航班/) || text.match(/航班預計|航班延誤|航班取消/)) {
      continue;
    }

    // ── 6. 新訂單 ──
    if (text.match(/結算價/) && text.match(/出發日期/)) {
      const newOrders = parseOrders(text);
      for (const o of newOrders) {
        const date = o.date || getTodayStr();
        if (!dailyOrders[date]) dailyOrders[date] = {};
        const key = o.orderId || `${o.time}|${o.price}`;
        dailyOrders[date][key] = o;
      }
      const date = newOrders[0]?.date || getTodayStr();
      scheduleFlush(sourceId, date);
    }
  }
});

function getTodayStr() {
  const now = new Date();
  return `${now.getMonth()+1}/${now.getDate()}`;
}

app.get('/', (req, res) => res.send('訂單簡表 Bot 運行中 ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
