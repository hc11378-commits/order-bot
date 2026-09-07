const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();

// ── 機密資訊：一律從環境變數讀取，不寫死在程式碼裡 ──
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET?.trim();
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
const MONGO_URI = process.env.MONGO_URI?.trim(); // 例如 mongodb+srv://user:pass@cluster.xxx.mongodb.net/
const TEST_MODE = process.env.TEST_MODE?.trim().toLowerCase() === 'true';

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) {
  throw new Error('缺少 LINE_CHANNEL_SECRET 或 LINE_CHANNEL_ACCESS_TOKEN 環境變數，請在 Render 後台設定');
}
if (!MONGO_URI) {
  console.error('⚠️ 缺少 MONGO_URI 環境變數，月結統計功能將無法使用（當日簡表功能不受影響）');
}

// ── MongoDB 連線（月結統計用，永久保存每筆訂單紀錄）──
let mongoClient = null;
let ordersCollection = null;

async function connectMongo() {
  if (!MONGO_URI) return;
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db('orderbot');
    ordersCollection = db.collection('orders');
    console.log('✅ MongoDB 連線成功');
  } catch (err) {
    console.error('❌ MongoDB 連線失敗:', err.message);
  }
}
connectMongo();

// 寫入一筆訂單紀錄到 MongoDB（供月結統計使用）；失敗不影響當天簡表功能
async function saveOrderToMongo(groupId, date, key, order) {
  if (!ordersCollection) return;
  try {
    await ordersCollection.updateOne(
      { groupId, date, key },
      { $set: { groupId, date, key, ...order, cancelled: false, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('MongoDB 寫入失敗:', err.message);
  }
}

// 標記一筆訂單為已取消（月結統計時會排除）
async function markOrderCancelledInMongo(groupId, date, key) {
  if (!ordersCollection) return;
  try {
    await ordersCollection.updateOne(
      { groupId, date, key },
      { $set: { cancelled: true, updatedAt: new Date() } }
    );
  } catch (err) {
    console.error('MongoDB 更新失敗:', err.message);
  }
}

// ── 儲存：當天訂單（key=訂單編號, value=訂單資料）──
// 格式: { [date]: { [orderId]: orderObj | null(取消) } }
const dailyOrders = {};

// ── 計時器：2分鐘後發簡表 ──
const pendingTimers = {}; // key=groupId+date

// ── 是否有異動（取消/改派/拉回）──
const hasChanges = {}; // key=date, value=true/false

// ── 記錄每個群組最近一次訂單的日期，供無日期訊息（補單/交通車）歸類 ──
const lastActiveDate = {}; // key=groupId, value=date string

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
  // 增高墊需在安椅之前判斷，因「前向式安全座椅（增高）」要優先歸類為增高墊
  { keys: ['增高墊','增高垫','兒童增高墊','前向式安全座椅（增高）','前向式安全座椅(增高)','booster'], label: '增高墊' },
  { keys: ['兒童安全座椅','兒童座椅','安全座椅','嬰兒座椅','前向式安全座椅','向後式嬰兒安全座椅','向後式座椅','child seat','carseat'], label: '安椅' },
];

function getCity(addr) {
  const keys = Object.keys(CITY_MAP).sort((a,b) => b.length - a.length);
  for (const k of keys) { if (addr.includes(k)) return CITY_MAP[k]; }
  return null;
}

function parseAddr(addr) {
  if (!addr || addr.match(/^桃園機場|^桃機|^機場|^松山機場/i)) return null;
  const city = getCity(addr);
  const distKeys = Object.keys(DIST_MAP).sort((a,b) => b.length - a.length);
  for (const k of distKeys) {
    if (addr.includes(k)) return (city || '台北') + DIST_MAP[k];
  }
  const m = addr.match(/[市縣]([^\s市縣，,\/\d]{2,3})[區鄉鎮市]/);
  if (m && !m[1].match(/機場|桃機/)) return (city || '台北') + m[1];
  return city || null;
}

// 用於交通趟：沒有明確城市時，不強加「台北」，只回傳區名
function parseAddrNoDefault(addr) {
  if (!addr) return null;
  const city = getCity(addr);
  const distKeys = Object.keys(DIST_MAP).sort((a,b) => b.length - a.length);
  for (const k of distKeys) {
    if (addr.includes(k)) return (city || '') + DIST_MAP[k];
  }
  const m = addr.match(/[市縣]([^\s市縣，,\/\d]{2,3})[區鄉鎮市]/);
  if (m) return (city || '') + m[1];
  return city || addr.substring(0, 6);
}

function splitBlocks(text) {
  const lines = text.split('\n');
  const n = lines.length;

  // 第一步：找出所有「新訂單起始點」的行號
  // 起始點可能是：(a) 車型標題行 (b) 訂單編號行（但緊接在車型標題後的編號行不算獨立起點，屬於同一筆）
  const startIndices = [];
  let skipNext = false;
  for (let i = 0; i < n; i++) {
    if (skipNext) { skipNext = false; continue; }
    const t = lines[i].trim().replace(/^["""「]/, '');
    const isVehicleHeader = t.match(/^([一二三四五六七八九十\d]+座|經五|經七|休五|休旅|高五|高七|高九|假七|七座|阿法|Alphard|保母車|商務|轎車|廂型)\s*(送機|接機)/i);
    const isOrderIdLine = t.match(/^[A-Z0-9]{6,15}$/);

    if (isVehicleHeader) {
      startIndices.push(i);
      // 檢查下一行是否為訂單編號行，若是，視為同一筆訂單的一部分，跳過不再判斷
      const nextT = (i + 1 < n) ? lines[i + 1].trim().replace(/^["""「]/, '') : '';
      if (nextT.match(/^[A-Z0-9]{6,15}$/)) {
        skipNext = true;
      }
      continue;
    }
    if (isOrderIdLine) {
      startIndices.push(i);
    }
  }

  // 第二步：依起始點切割成區塊
  const blocks = [];
  for (let k = 0; k < startIndices.length; k++) {
    const start = startIndices[k];
    const end = (k + 1 < startIndices.length) ? startIndices[k + 1] : n;
    blocks.push(lines.slice(start, end).join('\n'));
  }
  // 若完全沒有起始點被偵測到（例如整段只有一筆且無明顯標頭），把全文當一筆
  if (!blocks.length && text.trim()) {
    blocks.push(text);
  }

  return blocks.filter(b => b.match(/結算價/));
}

function extractOrderId(block) {
  // 抓訂單編號（英數字組合，通常在第二行）
  const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const l of lines) {
    const m = l.match(/^([A-Z]{2,3}\d{6,9}|[A-Z0-9]{6,15})$/);
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
  if (toM && toM[1].match(/機場|桃機|松山機場/)) return '送';
  const fromM = block.match(/上車地點[：:]\s*(.+)/);
  if (fromM && fromM[1].match(/機場|桃機|松山機場/)) return '接';
  return '接';
}

function extractLocation(block, type) {
  const main = type === '接' ? '下車地點' : '上車地點';
  const alt  = type === '接' ? '上車地點' : '下車地點';
  const m1 = block.match(new RegExp(main + '[：:]\\s*(.+)'));
  let addr = m1 ? m1[1].trim() : '';
  if (!addr || addr.match(/桃園機場|桃機|機場t|松山機場|松山機/i)) {
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
      // 先扣掉「前向式安全座椅（增高）/(增高)」這個重疊片語，避免它被安椅規則的
      // 「前向式安全座椅」子字串誤判為安椅；扣除後再逐一比對兩個規則
      const noteForSeatCheck = note
        .replace(/前向式安全座椅（增高）/g, '')
        .replace(/前向式安全座椅\(增高\)/g, '');

      const matchedLabels = new Set();
      for (const rule of REMARK_RULES) {
        const target = (rule.label === '安椅') ? noteForSeatCheck : note;
        if (rule.keys.some(k => target.includes(k.toLowerCase()))) {
          matchedLabels.add(rule.label);
          found.push(rule.label);
        }
      }
    }
  }
  return found;
}

// ════════════════════════════════════════
// 外車格式二：S99交通趟（非機場，兩地之間）
// ════════════════════════════════════════
function parseTransferOrder(text) {
  if (!text.match(/用車日期/) || !text.match(/搭車地區/)) return null;
  const dateM = text.match(/用車日期[：:]\s*([\d/]+)/);
  const timeM = text.match(/出發時間[：:]\s*(\d{1,2}:\d{2})/);
  const fromM = text.match(/搭車地區[：:]\s*(.+)/);
  const toM   = text.match(/下車地區[：:]\s*(.+)/);
  const paxM  = text.match(/乘車人數[：:]\s*(.+)/);
  const priceM = text.match(/需付車資[：:]\s*(\d+)/);
  if (!timeM) return null;

  const fromLoc = fromM ? parseAddrNoDefault(fromM[1].trim()) : null;
  const toLoc   = toM ? parseAddrNoDefault(toM[1].trim()) : null;
  const pax = paxM ? paxM[1].trim().replace(/\s/g,'') : '1人';
  const price = priceM ? parseFloat(priceM[1]) : null;

  return {
    orderId: null,
    time: timeM[1],
    pax: pax,
    price: price,
    loc: `${fromLoc||'?'}→${toLoc||'?'}`,
    type: 'transfer',
    remarks: [],
    date: dateM ? dateM[1] : null,
  };
}

// ════════════════════════════════════════
// 外車格式三：送機_桃園機場（駕駛回報格式）
// ════════════════════════════════════════
function parseDriverReportOrder(text) {
  if (!text.match(/時間[：:]/) || !text.match(/貴賓[：:]/)) return null;
  const timeM = text.match(/時間[：:]\s*[\d\/]+_(\d{1,2}:\d{2})/) || text.match(/時間[：:].*?(\d{1,2}:\d{2})/);
  const addrM = text.match(/地址[：:]\s*(.+)/);
  const paxM  = text.match(/人數行李[：:]\s*(\d+)\s*位/);
  const isReturn = text.match(/送機/);

  if (!timeM) return null;
  const loc = addrM ? parseAddr(addrM[1].trim()) : null;
  const pax = paxM ? parseInt(paxM[1]) : 1;

  // 備注：優先抓括號內容（若不會太長），否則抓整段
  const remarkM = text.match(/備註[：:]\s*(.+)/);
  const remarks = [];
  if (remarkM && remarkM[1].trim() && remarkM[1].trim() !== '-') {
    const raw = remarkM[1].trim();
    const bracketM = raw.match(/\(([^)]+)\)/);
    if (bracketM && bracketM[1].length <= 12) {
      remarks.push(bracketM[1]);
    } else {
      // 取括號前的文字，或整段（若無括號）
      const beforeBracket = raw.split('(')[0].trim();
      remarks.push(beforeBracket || raw);
    }
  }

  return {
    orderId: null,
    time: timeM[1],
    pax: pax,
    price: null, // 待確認金額
    loc: loc || '',
    type: isReturn ? '送' : '接',
    remarks,
    date: null,
  };
}

// ════════════════════════════════════════
// 外車格式四/五：Tab分隔表格（平安鑫）
// ════════════════════════════════════════
function parseTableOrder(text) {
  if (!text.includes('\t')) return null;
  let cols = text.split('\t').map(c => c.trim());
  if (cols.length < 14) return null;

  // 若第一欄是空的（信用卡趟格式多一個空白欄），往後位移
  // 用「TRUE」欄位當錨點定位，因為它固定存在且獨特
  const trueIdx = cols.findIndex(c => c === 'TRUE');
  if (trueIdx === -1) return null;

  // 錨點前：找金額（往前找第一個含數字的非空欄位）
  let price = null;
  for (let i = trueIdx - 1; i >= 0; i--) {
    const c = cols[i];
    if (c && c.match(/\d/)) {
      const num = c.replace(/[^\d.]/g, '');
      if (num) { price = parseFloat(num); break; }
    }
  }
  // 錨點後：日期, 訂單編號, 送機/接機, 時間, 車型, 縣, 區, 地址, 目的地, 客戶姓名, 人數...
  const dateStr   = cols[trueIdx + 1];
  const orderId   = cols[trueIdx + 2];
  const typeRaw   = cols[trueIdx + 3];
  const time      = cols[trueIdx + 4];
  const county    = cols[trueIdx + 6];
  const district  = cols[trueIdx + 7];
  const address   = cols[trueIdx + 8];
  const paxRaw    = cols[trueIdx + 11];

  if (!time || !time.match(/\d{1,2}:\d{2}/)) return null;

  const pax = parseInt(paxRaw) || 1;
  const type = typeRaw.includes('接') ? '接' : '送';
  const addrFull = (county||'') + (district||'') + (address||'');
  const loc = parseAddr(addrFull) || ((county||'') + (district||'')).replace(/[市縣]/g,'').replace(/區$/,'');

  // 備注：找表格尾端括號內容，排除固定安全宣導語
  const remarks = [];
  const tailText = cols.slice(trueIdx + 12).join(' ');
  const noteM = tailText.match(/\(([^)]+)\)/);
  if (noteM) remarks.push(noteM[1]);

  return {
    orderId,
    time,
    pax,
    price,
    loc,
    type,
    remarks,
    date: dateStr,
  };
}

// ════════════════════════════════════════
// 外車格式一：xxx接機/送機（欄位與一般訂單相同，日期格式不同）
// 共用 extractType / extractLocation / extractPrice / detectRemarks
// 差異：日期可能是 2026/07/23 格式，時間需從航班編號抓
// ════════════════════════════════════════
function extractTimeV2(block) {
  // 先試原本邏輯
  const t1 = extractTime(block);
  if (t1) return t1;
  // 【CX565】18:15 這種格式：時間在】後面
  const m = block.match(/【[^】]+】\s*(\d{1,2}:\d{2})/);
  if (m) return m[1];
  return null;
}

function extractPriceV2(block) {
  const p1 = extractPrice(block);
  if (p1 !== null) return p1;
  // 結算價 ：1800$ 這種格式
  const m = block.match(/結算價[：:\s]*([\d,]+\.?\d*)\s*\$?/);
  if (m) return parseFloat(m[1].replace(/,/g,''));
  return null;
}

function parseOrders(text) {
  // 先偵測特殊格式
  const transferOrder = parseTransferOrder(text);
  if (transferOrder) return [transferOrder];

  const driverReportOrder = parseDriverReportOrder(text);
  if (driverReportOrder) return [driverReportOrder];

  const tableOrder = parseTableOrder(text);
  if (tableOrder) return [tableOrder];

  // 一般訂單 / 外車格式一（共用邏輯）
  const blocks = splitBlocks(text);
  const results = [];
  const seen = new Set();
  blocks.forEach(b => {
    const time  = extractTimeV2(b);
    const price = extractPriceV2(b);
    const orderId = extractOrderId(b);
    if (!time || price === null) return;
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
  active.forEach(o => {
    if (o.isPlaceholder || o.isShuttle) return;
    o.remarks.forEach(r => {
      if (r.startsWith('客收')) kesuList.push(r);
      else if (['舉牌','安椅','增高墊'].includes(r)) otherCount[r] = (otherCount[r]||0) + 1;
    });
  });

  let total = 0;
  let hasUnconfirmed = false;
  const lines = [date + (hasChanges[date] ? '（更新）' : '')];
  active.forEach((o, i) => {
    // 補單佔位
    if (o.isPlaceholder) {
      lines.push(`${i+1}。${o.display}`);
      return;
    }
    // 交通車
    if (o.isShuttle) {
      lines.push(`${i+1}。${o.time}，${o.display}`);
      return;
    }

    const priceStr = (o.price === null || o.price === undefined) ? '待確認金額' : fmtP(o.price);
    if (o.price === null || o.price === undefined) hasUnconfirmed = true;
    else total += o.price;

    const rStr = o.remarks.length ? o.remarks.join('、')+'，' : '';

    let locStr;
    if (o.type === 'transfer') {
      locStr = `交通趟，${o.loc}`;
    } else if (o.type === '接') {
      locStr = `接${o.loc}`;
    } else {
      locStr = `${o.loc}送`;
    }

    lines.push(`${i+1}。${o.time}，${locStr}，${rStr}${o.pax}${typeof o.pax === 'string' && o.pax.includes('人') ? '' : '人'}，${priceStr}`);
  });
  const parts = [];
  if (kesuList.length) parts.push(kesuList.join('、'));
  Object.entries(otherCount).forEach(([k,v]) => parts.push(k+'*'+v));
  const totalStr = fmtP(total) + (hasUnconfirmed ? '+待確認' : '');
  lines.push('結：' + totalStr + (parts.length ? '，'+parts.join('、') : ''));
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

// 尋找訂單所在日期：先精準比對key，找不到再用「去除所有空白後比對」寬鬆比對，
// 避免因為訂單編號夾帶不可見字元或空白差異導致完全比對失敗
function findOrderDate(orderId) {
  const normalizedTarget = orderId.replace(/\s/g, '');
  for (const date of Object.keys(dailyOrders)) {
    if (dailyOrders[date][orderId] !== undefined && dailyOrders[date][orderId] !== null) {
      return { date, key: orderId };
    }
  }
  // 寬鬆比對：去除空白後比較
  for (const date of Object.keys(dailyOrders)) {
    for (const key of Object.keys(dailyOrders[date])) {
      if (dailyOrders[date][key] === null) continue;
      if (key.replace(/\s/g, '') === normalizedTarget) {
        return { date, key };
      }
    }
  }
  return null;
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

// 測試模式使用 replyToken 即時回覆，不消耗 LINE 每月 Push 訊息額度。
// 正式模式則維持原本的 5 分鐘彙整後 Push。
async function sendOrScheduleSummary(replyToken, groupId, date) {
  if (!TEST_MODE) {
    scheduleFlush(groupId, date);
    return;
  }

  const orders = dailyOrders[date];
  if (!orders) return;
  const summary = buildSummary(date, orders);
  if (summary) await replyMessage(replyToken, summary);
}

// ════════════════════════════════════════
// Webhook
// ════════════════════════════════════════
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function verifySignature(req) {
  const sig = req.headers['x-line-signature'];
  if (!sig || !req.rawBody) return false;

  const expected = crypto
    .createHmac('sha256', CHANNEL_SECRET)
    .update(req.rawBody)
    .digest();
  const received = Buffer.from(sig, 'base64');

  return received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
}

// 每分鐘檢查是否到23:50；記錄當天是否已執行，避免同一分鐘重複推送
let lastScheduledDate = '';
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

    const rawText = event.message.text.trim();
    // 移除零寬字元、BOM等不可見字元，避免破壞正則比對（常見於手機輸入法/轉發訊息）
    const text = rawText.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, (ch) => ch === '\u00A0' ? ' ' : '');
    const sourceId = event.source.groupId || event.source.userId;
    if (!sourceId) continue;
    groupIds[sourceId] = true;

    // ── 測試指令：使用 Reply API，不計入每月 Push 訊息額度 ──
    if (text === '測試') {
      await replyMessage(event.replyToken, 'BOT 測試成功 ✅');
      continue;
    }

    // ── 0. 月結查詢：「月結」或「月結 8月」──
    const monthCmd = parseMonthCommand(text);
    if (monthCmd !== null) {
      const report = await buildMonthlyReport(sourceId, monthCmd);
      await replyMessage(event.replyToken, report);
      continue;
    }

    // ── 1. 取消：「XXX 訂單取消」或「XXX 取消」──
    const cancelM = text.match(/([A-Z0-9]{6,15})\s*(訂單取消|取消)/);
    if (cancelM) {
      const orderId = cancelM[1];
      const found = findOrderDate(orderId);
      if (found) {
        dailyOrders[found.date][found.key] = null;
        hasChanges[found.date] = true;
        await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
        markOrderCancelledInMongo(sourceId, found.date, found.key);
      }
      continue;
    }

    // ── 2. 拉回改派：「拉回改派 XXXX」→ 先移除，等新訂單進來 ──
    const pullReassignM = text.match(/拉回改派\s*([A-Z0-9]{6,15})/);
    if (pullReassignM) {
      const orderId = pullReassignM[1];
      const found = findOrderDate(orderId);
      if (found) {
        dailyOrders[found.date][found.key] = null;
        hasChanges[found.date] = true;
        await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
        markOrderCancelledInMongo(sourceId, found.date, found.key);
      }
      continue;
    }

    // ── 3. 改派：「XXX 改派」+ 新訂單內容 ──
    const reassignM = text.match(/([A-Z0-9]{6,15})\s*改派/);
    if (reassignM) {
      const oldId = reassignM[1];
      const found = findOrderDate(oldId);
      if (found) {
        dailyOrders[found.date][found.key] = null;
        hasChanges[found.date] = true;
        markOrderCancelledInMongo(sourceId, found.date, found.key);
      }
      const newOrders = parseOrders(text);
      for (const o of newOrders) {
        const date = normalizeDate(o.date);
        if (!dailyOrders[date]) dailyOrders[date] = {};
        const key = o.orderId || `${o.time}|${o.price}|${o.loc}`;
        dailyOrders[date][key] = o;
        hasChanges[date] = true;
        saveOrderToMongo(sourceId, date, key, o);
      }
      const date = found ? found.date : normalizeDate(newOrders[0]?.date);
      await sendOrScheduleSummary(event.replyToken, sourceId, date);
      continue;
    }

    // ── 4. 拉回：「XXX 拉回」或「XXX ...拉回」或「我先拉回」──
    const pullbackM = text.match(/([A-Z0-9]{6,15})[^\n]*拉回/) || text.match(/拉回/);
    if (pullbackM) {
      if (pullbackM[1]) {
        const orderId = pullbackM[1];
        const found = findOrderDate(orderId);
        if (found) {
          dailyOrders[found.date][found.key] = null;
          hasChanges[found.date] = true;
          await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
          markOrderCancelledInMongo(sourceId, found.date, found.key);
        }
      }
      continue;
    }

    // ── 5. 航班通知（忽略，不影響簡表）──
    if (text.match(/([A-Z0-9]{6,15})\s*航班/) || text.match(/航班預計|航班延誤|航班取消/)) {
      continue;
    }

    // ── 5.5 補單提示：「補12送」「補09接」→ 先佔位，等實際訂單自動取代 ──
    const placeholderM = text.match(/^補\s*(\d{1,2})\s*(送|接)$/);
    if (placeholderM) {
      const hour = parseInt(placeholderM[1]);
      const type = placeholderM[2];
      const date = lastActiveDate[sourceId] || getTodayStr();
      if (!dailyOrders[date]) dailyOrders[date] = {};
      const key = `placeholder|${hour}|${type}`;
      dailyOrders[date][key] = {
        isPlaceholder: true,
        hour, type,
        time: `${String(hour).padStart(2,'0')}:00`,
        display: `補${hour}${type}`,
      };
      hasChanges[date] = true;
      await sendOrScheduleSummary(event.replyToken, sourceId, date);
      continue;
    }

    // ── 5.6 交通車通知：「0740 蘆竹交通車」→ 顯示時間+地點，無金額無人數（除非有標註人數）──
    const shuttleM = text.match(/^(\d{3,4})\s*(.+?交通車)\s*(\d+人)?$/);
    if (shuttleM) {
      const timeRaw = shuttleM[1].padStart(4, '0');
      const time = `${timeRaw.slice(0,2)}:${timeRaw.slice(2)}`;
      const label = shuttleM[2];
      const paxNote = shuttleM[3] || '';
      const date = lastActiveDate[sourceId] || getTodayStr();
      if (!dailyOrders[date]) dailyOrders[date] = {};
      const key = `shuttle|${time}|${label}`;
      dailyOrders[date][key] = {
        isShuttle: true,
        time,
        display: paxNote ? `${label}，${paxNote}` : label,
      };
      hasChanges[date] = true;
      await sendOrScheduleSummary(event.replyToken, sourceId, date);
      continue;
    }

    // ── 6. 新訂單（一般訂單、外車格式一二三四五）──
    const looksLikeOrder =
      (text.match(/結算價/) && text.match(/出發日期/)) ||   // 一般訂單/外車格式一
      (text.match(/用車日期/) && text.match(/搭車地區/)) ||  // 外車格式二
      (text.match(/時間[：:]/) && text.match(/貴賓[：:]/)) || // 外車格式三
      (text.includes('\t') && text.split('\t').length >= 15); // 外車格式四五

    if (looksLikeOrder) {
      const newOrders = parseOrders(text);
      for (const o of newOrders) {
        const date = normalizeDate(o.date);
        lastActiveDate[sourceId] = date; // 記錄最近使用的日期
        if (!dailyOrders[date]) dailyOrders[date] = {};

        // 檢查是否能取代某個補單佔位（同方向 + 同整點時段）
        const oHour = parseInt(o.time.split(':')[0]);
        const oType = o.type === '接' ? '接' : '送';
        const placeholderKey = `placeholder|${oHour}|${oType}`;
        if (dailyOrders[date][placeholderKey] && dailyOrders[date][placeholderKey].isPlaceholder) {
          delete dailyOrders[date][placeholderKey];
        }

        const key = o.orderId || `${o.time}|${o.price}|${o.loc}`;
        dailyOrders[date][key] = o;
        saveOrderToMongo(sourceId, date, key, o);
      }
      const date = normalizeDate(newOrders[0]?.date);
      if (newOrders.length) await sendOrScheduleSummary(event.replyToken, sourceId, date);
    }
  }
});

function getTodayStr() {
  const now = new Date();
  return `${now.getMonth()+1}/${now.getDate()}`;
}

// 統一日期格式為 M/D（處理 2026-06-27、2026/07/23、7/21 等格式）
function normalizeDate(dateStr) {
  if (!dateStr) return getTodayStr();
  const m = dateStr.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${parseInt(m[2])}/${parseInt(m[3])}`;
  const m2 = dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m2) return dateStr;
  return getTodayStr();
}

// ════════════════════════════════════════
// 月結統計
// ════════════════════════════════════════

// 中文數字/阿拉伯數字月份解析：「月結」「月結 8月」「月結8」
function parseMonthCommand(text) {
  const m = text.match(/^月結\s*(\d{1,2})\s*月?$/);
  if (m) return parseInt(m[1]);
  if (text.trim() === '月結') {
    return new Date().getMonth() + 1; // 當月
  }
  return null;
}

// 從 MongoDB 撈出指定月份「未取消」的訂單，計算統計數據
async function buildMonthlyReport(groupId, month) {
  if (!ordersCollection) {
    return '月結功能目前無法使用（資料庫未連線），請聯繫管理員確認設定。';
  }

  // date 欄位格式為 M/D（無年份），用正則篩選「月份/」開頭的資料
  const datePattern = new RegExp(`^${month}/\\d{1,2}$`);

  let records;
  try {
    records = await ordersCollection.find({
      groupId,
      cancelled: false,
      date: { $regex: datePattern },
    }).toArray();
  } catch (err) {
    console.error('月結查詢失敗:', err.message);
    return '月結查詢時發生錯誤，請稍後再試。';
  }

  // 排除備注/交通車類的非訂單資料、以及沒有金額的待確認訂單
  const validOrders = records.filter(r => typeof r.price === 'number');

  if (!validOrders.length) {
    return `${month}月尚無有效訂單紀錄，無法產生月結報表。`;
  }

  let total = 0;
  let kesuTotal = 0;
  const kesuCount = { count: 0 };
  const remarkCount = { 舉牌: 0, 安椅: 0, 增高墊: 0 };

  validOrders.forEach(o => {
    total += o.price;
    (o.remarks || []).forEach(r => {
      if (r.startsWith('客收')) {
        const amt = parseFloat(r.replace('客收', '')) || 0;
        kesuTotal += amt;
        kesuCount.count++;
      } else if (remarkCount[r] !== undefined) {
        remarkCount[r]++;
      }
    });
  });

  const tripCount = validOrders.length;
  const avgPerTrip = tripCount ? (total / tripCount) : 0;

  const lines = [];
  lines.push(`${month}月結算報表`);
  lines.push(`總趟數：${tripCount} 趟`);
  lines.push(`總金額：${fmtP(total)}`);
  lines.push(`平均每趟：${fmtP(Math.round(avgPerTrip * 10) / 10)}`);
  if (kesuCount.count > 0) lines.push(`客收總額：${fmtP(kesuTotal)}（共${kesuCount.count}筆）`);
  if (remarkCount.舉牌 > 0) lines.push(`舉牌次數：${remarkCount.舉牌}`);
  if (remarkCount.安椅 > 0) lines.push(`安椅次數：${remarkCount.安椅}`);
  if (remarkCount.增高墊 > 0) lines.push(`增高墊次數：${remarkCount.增高墊}`);

  return lines.join('\n');
}

app.get('/', (req, res) => res.send('訂單簡表 Bot 運行中 ✅'));

// 每天檢查是否為月底最後一天 23:50，自動發送當月月結
let lastMonthlyReportSent = ''; // 記錄格式 'YYYY-MM'，避免同月重複發送
setInterval(async () => {
  const now = new Date();
  const h = now.getHours();
  const min = now.getMinutes();
  if (h !== 23 || min !== 50) return;

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isLastDayOfMonth = tomorrow.getMonth() !== now.getMonth();
  if (!isLastDayOfMonth) return;

  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  if (lastMonthlyReportSent === monthKey) return;
  lastMonthlyReportSent = monthKey;

  const month = now.getMonth() + 1;
  for (const groupId of Object.keys(groupIds)) {
    const report = await buildMonthlyReport(groupId, month);
    await pushMessage(groupId, report);
  }
}, 60 * 1000);

// ── 防止 Render 免費方案休眠：每 13 分鐘自我 ping 一次 ──
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://order-bot-45x0.onrender.com';
setInterval(() => {
  axios.get(SELF_URL).catch(() => {}); // 失敗也沒關係，純粹是為了保持喚醒
}, 13 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
