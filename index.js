const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();

// ── 機密資訊：一律從環境變數讀取，不寫死在程式碼裡 ──
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET?.trim();
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
const MONGO_URI = process.env.MONGO_URI?.trim(); // MongoDB Atlas 連線字串僅存在 Render 環境變數
const TEST_MODE = process.env.TEST_MODE?.trim().toLowerCase() === 'true';
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test';
const BUSINESS_TIME_ZONE = 'Asia/Taipei';
const BOT_VERSION = '1.3.1-withdrawal-lock';

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
    const collection = db.collection('orders');
    await collection.createIndex({ groupId: 1, serviceYear: 1, date: 1, cancelled: 1 });
    await collection.createIndex({ groupId: 1, key: 1, cancelled: 1 });
    await collection.createIndex({ groupId: 1, lineMessageId: 1, cancelled: 1 });
    // 舊資料沒有年份；以實際寫入時間補上，避免日後跨年度月結混在一起。
    await collection.updateMany(
      { serviceYear: { $exists: false }, updatedAt: { $type: 'date' } },
      [{ $set: { serviceYear: { $year: '$updatedAt' } } }]
    );
    ordersCollection = collection;
    console.log('✅ MongoDB 連線成功');
  } catch (err) {
    console.error('❌ MongoDB 連線失敗:', err.message);
  }
}
if (!IS_TEST_RUNTIME) connectMongo();

// 寫入一筆訂單紀錄到 MongoDB（供月結統計使用）；失敗不影響當天簡表功能
function anonymizeId(value) {
  if (!value) return 'unknown';
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function getOrderStorageKey(order, messageId = '', index = 0) {
  if (order.orderId) return String(order.orderId).replace(/\s/g, '');
  // 沒有業務訂單編號時使用 LINE 訊息 ID：同一個 webhook 重送仍是同一筆，
  // 但兩筆時間、金額、地點完全相同的合法訂單不會互相覆蓋。
  if (messageId) return `line:${messageId}:${index}`;
  return `legacy:${order.time}|${order.price ?? '?'}|${order.loc || '?'}|${index}`;
}

function dedupeOrderRecords(records) {
  const unique = new Map();
  records.forEach((record, index) => {
    const identity = record.key || record.orderId || record._id || `unkeyed:${index}`;
    const scopeKey = `${record.groupId || '?'}|${record.serviceYear || '?'}|${record.date || '?'}|${identity}`;
    const previous = unique.get(scopeKey);
    const currentTime = record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
    const previousTime = previous?.updatedAt ? new Date(previous.updatedAt).getTime() : 0;
    if (!previous || currentTime >= previousTime) unique.set(scopeKey, record);
  });
  return [...unique.values()];
}

async function saveOrderToMongo(groupId, date, key, order, audit = {}) {
  if (!ordersCollection) return false;
  try {
    const canonicalDate = normalizeDate(date);
    if (!canonicalDate) throw new Error(`無效的服務日期：${date}`);
    const serviceYear = extractServiceYear(order.date);
    // 已由客服明確取消、拉回、改派或收回的訂單，留下永久封鎖標記。
    // 即使 LINE 重送舊 webhook 或有人再次貼上原單，也不能把 cancelled 改回 false。
    if (typeof ordersCollection.findOne === 'function') {
      const suppression = await ordersCollection.findOne({
        groupId,
        key,
        cancelled: true,
        preventReactivation: true,
      });
      if (suppression) return 'suppressed';
    }
    await ordersCollection.updateOne(
      { groupId, serviceYear, date: canonicalDate, key },
      { $set: {
        ...order,
        groupId,
        date: canonicalDate,
        serviceYear,
        key,
        ...(audit.senderId ? { senderKey: anonymizeId(audit.senderId) } : {}),
        ...(audit.conversationType ? { conversationType: audit.conversationType } : {}),
        ...(audit.messageId ? { lineMessageId: String(audit.messageId) } : {}),
        cancelled: false,
        updatedAt: new Date(),
      } },
      { upsert: true }
    );
    // 同一訂單編號若改到其他服務日，新日期先寫入成功後，
    // 再將舊日期記錄標記取消，避免月結重複計算。
    if (order.orderId && typeof ordersCollection.updateMany === 'function') {
      try {
        await ordersCollection.updateMany({
          groupId,
          key,
          cancelled: false,
          $or: [
            { serviceYear: { $ne: serviceYear } },
            { date: { $ne: canonicalDate } },
          ],
        }, { $set: { cancelled: true, updatedAt: new Date() } });
      } catch (cleanupErr) {
        console.error('MongoDB 舊日期訂單清理失敗:', cleanupErr.message);
      }
    }
    return true;
  } catch (err) {
    console.error('MongoDB 寫入失敗:', err.message);
    return false;
  }
}

// 標記一筆訂單為已取消（月結統計時會排除）
async function markOrderCancelledInMongo(groupId, date, key, reason = '訂單已取消') {
  if (!ordersCollection) return;
  try {
    const filter = { groupId, key, cancelled: false };
    const update = { $set: {
      cancelled: true,
      cancellationReason: reason,
      preventReactivation: true,
      updatedAt: new Date(),
    } };
    // 舊資料可能曾因歷史版本產生相同 key 的重複紀錄，正式資料庫一次全部排除。
    if (typeof ordersCollection.updateMany === 'function') {
      const result = await ordersCollection.updateMany(filter, update);
      if (typeof result?.matchedCount === 'number' && result.matchedCount > 0) return;
    }
    // 簡化的測試替身或舊環境沒有回傳 matchedCount 時，仍保留單筆相容路徑。
    await ordersCollection.updateOne(filter, update);
  } catch (err) {
    console.error('MongoDB 更新失敗:', err.message);
  }
}

// 即使撤回指令比原訂單先送達，仍先建立封鎖紀錄；日後同群組、同訂單編號
// 再次出現時會被拒絕，不會回到簡表或月結。
async function blockOrderReactivation(groupId, key, reason, audit = {}) {
  if (!ordersCollection || !groupId || !key) return false;
  try {
    await ordersCollection.updateOne(
      { groupId, key, suppressionOnly: true },
      { $set: {
        groupId,
        key,
        orderId: key,
        suppressionOnly: true,
        cancelled: true,
        preventReactivation: true,
        cancellationReason: reason,
        ...(audit.senderId ? { senderKey: anonymizeId(audit.senderId) } : {}),
        ...(audit.conversationType ? { conversationType: audit.conversationType } : {}),
        updatedAt: new Date(),
      } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error('MongoDB 撤回封鎖寫入失敗:', err.message);
    return false;
  }
}

// ── 儲存：依 LINE 群組隔離的當天訂單 ──
// 格式: { [groupId]: { [date]: { [orderId]: orderObj | null(取消) } } }
// 不可只用日期當第一層，否則不同工作群組在同一天的訂單會互相看見或誤取消。
const dailyOrders = {};

// ── 計時器：2分鐘後發簡表 ──
const pendingTimers = {}; // key=groupId+date

// ── 是否有異動（取消/改派/拉回），同樣依群組隔離 ──
const hasChanges = {}; // 格式: { [groupId]: { [date]: true/false } }

// ── 記錄每個群組最近一次訂單的日期，供無日期訊息（補單/交通車）歸類 ──
const lastActiveDate = {}; // key=groupId, value=date string

function ensureGroupState(groupId) {
  if (!dailyOrders[groupId]) dailyOrders[groupId] = {};
  if (!hasChanges[groupId]) hasChanges[groupId] = {};
}

function getDateOrders(groupId, date, create = false) {
  if (create) ensureGroupState(groupId);
  if (!dailyOrders[groupId]) return null;
  if (create && !dailyOrders[groupId][date]) dailyOrders[groupId][date] = {};
  return dailyOrders[groupId][date] || null;
}

// Render 重啟後記憶體會清空。每次產生簡表前，從 MongoDB 重新載入
// 「目前群組 + 目前服務日」的全部訂單，不可只顯示重啟後新貼的那一筆。
async function refreshDateOrdersFromMongo(groupId, date, serviceYear = getBusinessDateParts().year) {
  const current = getDateOrders(groupId, date, true);
  if (!ordersCollection) return current;
  try {
    const records = dedupeOrderRecords(await ordersCollection.find({
      groupId,
      serviceYear,
      date,
      cancelled: false,
    }).sort({ updatedAt: 1 }).toArray());

    const refreshed = {};
    for (const record of records) {
      const recordKey = record.key || record.orderId ||
        `${record.time || '?'}|${record.price ?? '?'}|${record.loc || '?'}`;
      refreshed[recordKey] = record; // 若舊資料重複，保留 updatedAt 較新的一筆。
    }
    // 補單占位與交通車通知不寫 MongoDB，同步時仍需保留。
    for (const [key, order] of Object.entries(current)) {
      if (order?.isPlaceholder || order?.isShuttle) refreshed[key] = order;
    }
    dailyOrders[groupId][date] = refreshed;
    return refreshed;
  } catch (err) {
    console.error('MongoDB 完整簡表同步失敗:', err.message);
    return current;
  }
}

// LINE 「收回訊息」會傳送 unsend 事件。依群組與原訊息 ID 精準取消，
// 不使用日期或內容猜測，避免影響其他司機群組。
async function handleLineUnsend(groupId, messageId) {
  if (!groupId || !messageId) return [];
  const affectedDates = new Set();

  if (ordersCollection) {
    try {
      const records = await ordersCollection.find({
        groupId,
        lineMessageId: String(messageId),
        cancelled: false,
      }).toArray();
      records.forEach(record => {
        const date = normalizeDate(record.date);
        if (date) affectedDates.add(date);
      });
      if (records.length) {
        await ordersCollection.updateMany({
          groupId,
          lineMessageId: String(messageId),
          cancelled: false,
        }, { $set: {
          cancelled: true,
          cancellationReason: 'LINE訊息已收回',
          preventReactivation: true,
          unsentAt: new Date(),
          updatedAt: new Date(),
        } });
      }
    } catch (err) {
      console.error('LINE 收回訊息處理失敗:', err.message);
      return [];
    }
  }

  const groupOrders = dailyOrders[groupId] || {};
  for (const [date, dateOrders] of Object.entries(groupOrders)) {
    for (const [key, order] of Object.entries(dateOrders)) {
      if (order?.lineMessageId === String(messageId)) {
        dateOrders[key] = null;
        affectedDates.add(date);
      }
    }
  }
  for (const date of affectedDates) {
    setChanged(groupId, date);
    if (!TEST_MODE) scheduleFlush(groupId, date);
  }
  return [...affectedDates];
}

function setChanged(groupId, date) {
  ensureGroupState(groupId);
  hasChanges[groupId][date] = true;
}

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

// 全台 22 縣市、368 個鄉鎮市區。摘要統一顯示「縣市＋行政區」，
// 例如「新北土城」「台中西屯」，避免只顯示區名或把未知區域誤判為台北。
const REGIONS_BY_CITY = {
  基隆: ['仁愛','信義','中正','中山','安樂','暖暖','七堵'],
  台北: ['松山','信義','大安','中山','中正','大同','萬華','文山','南港','內湖','士林','北投'],
  新北: ['萬里','金山','板橋','汐止','深坑','石碇','瑞芳','平溪','雙溪','貢寮','新店','坪林','烏來','永和','中和','土城','三峽','樹林','鶯歌','三重','新莊','泰山','林口','蘆洲','五股','八里','淡水','三芝','石門'],
  桃園: ['桃園','中壢','平鎮','八德','楊梅','蘆竹','大溪','龜山','龍潭','新屋','觀音','復興','大園'],
  新竹市: ['東','北','香山'],
  新竹縣: ['竹北','關西','新埔','竹東','湖口','橫山','新豐','芎林','寶山','北埔','峨眉','尖石','五峰'],
  苗栗: ['苗栗','苑裡','通霄','竹南','頭份','後龍','卓蘭','大湖','公館','銅鑼','南庄','頭屋','三義','西湖','造橋','三灣','獅潭','泰安'],
  台中: ['中','東','南','西','北','西屯','南屯','北屯','豐原','東勢','大甲','清水','沙鹿','梧棲','后里','神岡','潭子','大雅','新社','石岡','外埔','大安','烏日','大肚','龍井','霧峰','太平','大里','和平'],
  彰化: ['彰化','鹿港','和美','線西','伸港','福興','秀水','花壇','芬園','員林','溪湖','田中','大村','埔鹽','埔心','永靖','社頭','二水','北斗','二林','田尾','埤頭','芳苑','大城','竹塘','溪州'],
  南投: ['南投','埔里','草屯','竹山','集集','名間','鹿谷','中寮','魚池','國姓','水里','信義','仁愛'],
  雲林: ['斗六','斗南','虎尾','西螺','土庫','北港','古坑','大埤','莿桐','林內','二崙','崙背','麥寮','東勢','褒忠','台西','元長','四湖','口湖','水林'],
  嘉義市: ['東','西'],
  嘉義縣: ['太保','朴子','布袋','大林','民雄','溪口','新港','六腳','東石','義竹','鹿草','水上','中埔','竹崎','梅山','番路','大埔','阿里山'],
  台南: ['中西','東','南','北','安平','安南','永康','歸仁','新化','左鎮','玉井','楠西','南化','仁德','關廟','龍崎','官田','麻豆','佳里','西港','七股','將軍','學甲','北門','新營','後壁','白河','東山','六甲','下營','柳營','鹽水','善化','大內','山上','新市','安定'],
  高雄: ['鹽埕','鼓山','左營','楠梓','三民','新興','前金','苓雅','前鎮','旗津','小港','鳳山','林園','大寮','大樹','大社','仁武','鳥松','岡山','橋頭','燕巢','田寮','阿蓮','路竹','湖內','茄萣','永安','彌陀','梓官','旗山','美濃','六龜','甲仙','杉林','內門','茂林','桃源','那瑪夏'],
  屏東: ['屏東','潮州','東港','恆春','萬丹','長治','麟洛','九如','里港','鹽埔','高樹','萬巒','內埔','竹田','新埤','枋寮','新園','崁頂','林邊','南州','佳冬','琉球','車城','滿州','枋山','三地門','霧台','瑪家','泰武','來義','春日','獅子','牡丹'],
  宜蘭: ['宜蘭','羅東','蘇澳','頭城','礁溪','壯圍','員山','冬山','五結','三星','大同','南澳'],
  花蓮: ['花蓮','鳳林','玉里','新城','吉安','壽豐','光復','豐濱','瑞穗','富里','秀林','萬榮','卓溪'],
  台東: ['台東','成功','關山','卑南','鹿野','池上','東河','長濱','太麻里','大武','綠島','海端','延平','金峰','達仁','蘭嶼'],
  澎湖: ['馬公','湖西','白沙','西嶼','望安','七美'],
  金門: ['金城','金沙','金湖','金寧','烈嶼','烏坵'],
  連江: ['南竿','北竿','莒光','東引'],
};

const CITY_ALIASES = {
  '基隆市':'基隆','基隆':'基隆',
  '臺北市':'台北','台北市':'台北','臺北':'台北','台北':'台北',
  '新北市':'新北','新北':'新北','桃園市':'桃園','桃園':'桃園',
  '新竹市':'新竹市','新竹縣':'新竹縣',
  '苗栗縣':'苗栗','苗栗':'苗栗',
  '臺中市':'台中','台中市':'台中','臺中':'台中','台中':'台中',
  '彰化縣':'彰化','彰化':'彰化','南投縣':'南投','南投':'南投',
  '雲林縣':'雲林','雲林':'雲林','嘉義市':'嘉義市','嘉義縣':'嘉義縣',
  '臺南市':'台南','台南市':'台南','臺南':'台南','台南':'台南',
  '高雄市':'高雄','高雄':'高雄','屏東縣':'屏東','屏東':'屏東',
  '宜蘭縣':'宜蘭','宜蘭':'宜蘭','花蓮縣':'花蓮','花蓮':'花蓮',
  '臺東縣':'台東','台東縣':'台東','臺東':'台東','台東':'台東',
  '澎湖縣':'澎湖','澎湖':'澎湖','金門縣':'金門','金門':'金門',
  '連江縣':'連江','連江':'連江',
};

const CITY_FULL_NAMES = {
  基隆: '基隆市', 台北: '台北市', 新北: '新北市', 桃園: '桃園市',
  新竹市: '新竹市', 新竹縣: '新竹縣', 苗栗: '苗栗縣', 台中: '台中市',
  彰化: '彰化縣', 南投: '南投縣', 雲林: '雲林縣', 嘉義市: '嘉義市',
  嘉義縣: '嘉義縣', 台南: '台南市', 高雄: '高雄市', 屏東: '屏東縣',
  宜蘭: '宜蘭縣', 花蓮: '花蓮縣', 台東: '台東縣', 澎湖: '澎湖縣',
  金門: '金門縣', 連江: '連江縣',
};

const REMARK_RULES = [
  { keys: ['舉牌','举牌','sign','placard'], label: '舉牌' },
  // 增高墊需在安椅之前判斷，因「前向式安全座椅（增高）」要優先歸類為增高墊
  { keys: ['增高墊','增高垫','兒童增高墊','前向式安全座椅（增高）','前向式安全座椅(增高)','booster'], label: '增高墊' },
  { keys: ['兒童安全座椅','兒童座椅','安全座椅','嬰兒座椅','前向式安全座椅','向後式嬰兒安全座椅','向後式座椅','child seat','carseat'], label: '安椅' },
];

function getCityMatch(addr) {
  if (!addr) return null;
  const aliases = Object.keys(CITY_ALIASES).sort((a,b) => b.length - a.length);
  for (const alias of aliases) {
    if (addr.includes(alias)) return { city: CITY_ALIASES[alias], alias };
  }
  return null;
}

function getCity(addr) {
  return getCityMatch(addr)?.city || null;
}

function findRegionInCity(addr, city) {
  const regions = REGIONS_BY_CITY[city] || [];
  for (const region of [...regions].sort((a, b) => b.length - a.length)) {
    const matched = addr.match(new RegExp(`${region}([區鄉鎮市])`));
    if (matched) return { region, suffix: matched[1] };
  }
  return null;
}

function findRegionWithoutCity(addr) {
  // 先比對完整的官方行政區名稱，不能用任意「某某區」猜測縣市。
  const candidates = [];
  for (const [city, regions] of Object.entries(REGIONS_BY_CITY)) {
    for (const region of regions) {
      const matched = addr.match(new RegExp(`${region}([區鄉鎮市])`));
      if (matched) candidates.push({ city, region, suffix: matched[1] });
    }
  }
  if (!candidates.length) return null;

  // 同名行政區（例如中正區、信義區）在地址缺少縣市時不可武斷猜測。
  const firstRegion = candidates[0].region;
  const sameRegion = candidates.filter(item => item.region === firstRegion);
  return sameRegion.length === 1
    ? sameRegion[0]
    : { city: null, region: firstRegion, suffix: sameRegion[0].suffix };
}

function parseAddr(addr) {
  if (!addr || addr.match(/^桃園機場|^桃機|^機場|^松山機場/i)) return null;
  const normalized = addr.replace(/臺/g, '台');
  const cityMatch = getCityMatch(normalized);
  if (cityMatch) {
    const { city, alias } = cityMatch;
    // 先移除縣市名稱再找行政區，避免「桃園市蘆竹區」把前面的桃園市
    // 誤當成「桃園區」，同理也適用苗栗縣苗栗市等同名情況。
    const regionText = normalized.replace(alias, '');
    const matched = findRegionInCity(regionText, city);
    return matched
      ? `${CITY_FULL_NAMES[city]}${matched.region}${matched.suffix}`
      : CITY_FULL_NAMES[city];
  }

  const inferred = findRegionWithoutCity(normalized);
  if (!inferred) return null;
  if (!inferred.city) return `縣市待確認：${inferred.region}${inferred.suffix}`;
  return `${CITY_FULL_NAMES[inferred.city]}${inferred.region}${inferred.suffix}`;
}

// 交通趟也必須清楚顯示縣市；無法判斷時直接標示待確認，不隱藏問題。
function parseAddrNoDefault(addr) {
  if (!addr) return null;
  return parseAddr(addr) || `地址待確認：${addr.trim().substring(0, 12)}`;
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
    const t = lines[i].trim().replace(/^["'“”「」『』]+/, '');
    const isVehicleHeader = t.match(/^([一二三四五六七八九十\d]+座|經五|經七|休五|休旅|高五|高七|高九|假七|七座|阿法|Alphard|保母車|商務|轎車|廂型)\s*(送機|接機)/i);
    const isOrderIdLine = t.match(/^[A-Z0-9]{6,15}$/);

    if (isVehicleHeader) {
      startIndices.push(i);
      // 檢查下一行是否為訂單編號行，若是，視為同一筆訂單的一部分，跳過不再判斷
      const nextT = (i + 1 < n) ? lines[i + 1].trim().replace(/^["'“”「」『』]+/, '') : '';
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

  return blocks.filter(b =>
    b.match(/結(?:算|單)價|客收[：:]?\s*\d+/) ||
    (b.match(/出發日期/) && b.match(/上車地點|下車地點/))
  );
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
  const m = block.match(/結(?:算|單)價[：:\s]*([\d,]+\.?\d*)/);
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
  const kesuM = block.match(/客收[：:]?\s*([\d,]+(?:\.\d+)?)/);
  if (kesuM) found.push('客收' + kesuM[1].replace(/,/g, ''));
  // 只讀取「其他備註」同一行；空白備註不可跨行把聯絡人或電話讀進來。
  const rLine = block.match(/其他備註[：:][ \t]*([^\r\n]*)/);
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

      // 保留其他營運上有用的備註；已轉成標準標籤的內容不重複顯示。
      // 只取同一行並限制長度，避免把後續電話、姓名等個資誤當備註。
      if (!matchedLabels.size) {
        const safeNote = rLine[1].trim().replace(/["'“”]+$/g, '').slice(0, 40);
        if (safeNote) found.push(safeNote);
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
  const priceM = text.match(/需付車資[：:]\s*([\d,]+\.?\d*)/);
  if (!timeM) return null;

  const fromLoc = fromM ? parseAddrNoDefault(fromM[1].trim()) : null;
  const toLoc   = toM ? parseAddrNoDefault(toM[1].trim()) : null;
  const pax = paxM ? paxM[1].trim().replace(/\s/g,'') : '1人';
  const price = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null;

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
  const dateM = text.match(/時間[：:]\s*(\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}\/\d{1,2})/);
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
    date: dateM ? dateM[1] : null,
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
  const m = block.match(/結(?:算|單)價[：:\s]*([\d,]+\.?\d*)\s*\$?/);
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
  blocks.forEach((b, blockIndex) => {
    const time  = extractTimeV2(b);
    const price = extractPriceV2(b);
    const orderId = extractOrderId(b);
    if (!time) return;
    const key = orderId || `${time}|${price}|${blockIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    const paxM = b.match(/乘車人數[：:]\s*(\d+(?:\s*[-~～〜]\s*\d+)?)/);
    const paxRaw = paxM ? paxM[1].replace(/[~～〜]/g, '-').replace(/\s/g, '') : '1';
    const pax = paxRaw.includes('-') ? paxRaw : parseInt(paxRaw);
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

function getCustomerCollectionTotal(order) {
  return (order?.remarks || []).reduce((sum, remark) => {
    const match = String(remark).match(/^客收\s*([\d,]+(?:\.\d+)?)/);
    return sum + (match ? Number(match[1].replace(/,/g, '')) : 0);
  }, 0);
}

function buildSummary(groupId, date, orders) {
  const active = Object.values(orders).filter(o => o !== null);
  if (!active.length) return null;
  active.sort((a,b) => toMin(a.time) - toMin(b.time));

  let customerCollectionTotal = 0;
  const otherCount = {};
  active.forEach(o => {
    if (o.isPlaceholder || o.isShuttle) return;
    o.remarks.forEach(r => {
      if (!r.startsWith('客收') && ['舉牌','安椅','增高墊'].includes(r)) {
        otherCount[r] = (otherCount[r]||0) + 1;
      }
    });
    customerCollectionTotal += getCustomerCollectionTotal(o);
  });

  let total = 0;
  let hasUnconfirmed = false;
  const lines = [date + (hasChanges[groupId]?.[date] ? '（更新）' : '')];
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

    const orderCustomerCollection = getCustomerCollectionTotal(o);
    const hasSettlementPrice = typeof o.price === 'number';
    const priceStr = hasSettlementPrice
      ? fmtP(o.price)
      : (orderCustomerCollection > 0 ? '客收計價' : '待確認金額');
    if (!hasSettlementPrice && orderCustomerCollection <= 0) hasUnconfirmed = true;
    else if (hasSettlementPrice) total += o.price;

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
  const performanceTotal = total + customerCollectionTotal;
  const pendingSuffix = hasUnconfirmed ? '+待確認' : '';
  lines.push(`結算價合計：${fmtP(total)}${pendingSuffix}`);
  lines.push(`客收合計：${fmtP(customerCollectionTotal)}`);
  lines.push(`業績合計：${fmtP(performanceTotal)}${pendingSuffix}`);
  const otherParts = [];
  Object.entries(otherCount).forEach(([k,v]) => otherParts.push(k+'*'+v));
  if (otherParts.length) lines.push(`其他備註統計：${otherParts.join('、')}`);
  return lines.join('\n');
}

// ════════════════════════════════════════
// LINE API
// ════════════════════════════════════════
function toLineMessages(text) {
  const maxLength = 4900; // LINE 單則文字上限 5000，預留安全空間
  const chunks = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
    while (current.length > maxLength) {
      chunks.push(current.slice(0, maxLength));
      current = current.slice(maxLength);
    }
  }
  if (current) chunks.push(current);
  if (chunks.length <= 5) return chunks.map(chunk => ({ type: 'text', text: chunk }));
  return [
    ...chunks.slice(0, 4).map(chunk => ({ type: 'text', text: chunk })),
    { type: 'text', text: `${chunks[4].slice(0, 4800)}\n（內容過長，後續資料已省略，請分日期查詢）` },
  ];
}

async function pushMessage(groupId, text) {
  await axios.post('https://api.line.me/v2/bot/message/push', {
    to: groupId,
    messages: toLineMessages(text)
  }, {
    headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    timeout: 8000,
  });
}

async function replyMessage(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: toLineMessages(text)
  }, {
    headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    timeout: 8000,
  });
}

// 尋找訂單所在日期：先精準比對key，找不到再用「去除所有空白後比對」寬鬆比對，
// 避免因為訂單編號夾帶不可見字元或空白差異導致完全比對失敗
async function findOrderDate(groupId, orderId) {
  const normalizedTarget = orderId.replace(/\s/g, '');
  const groupOrders = dailyOrders[groupId] || {};
  for (const date of Object.keys(groupOrders)) {
    if (groupOrders[date][orderId] !== undefined && groupOrders[date][orderId] !== null) {
      return { date, key: orderId };
    }
  }
  // 寬鬆比對：去除空白後比較
  for (const date of Object.keys(groupOrders)) {
    for (const key of Object.keys(groupOrders[date])) {
      if (groupOrders[date][key] === null) continue;
      if (key.replace(/\s/g, '') === normalizedTarget) {
        return { date, key };
      }
    }
  }

  // Render 重新部署後記憶體會清空，改從 MongoDB 找回同群組的訂單。
  if (ordersCollection) {
    try {
      const record = await ordersCollection.findOne({
        groupId,
        cancelled: false,
        $or: [{ key: orderId }, { orderId }],
      }, { sort: { updatedAt: -1 } });
      if (record) {
        const date = normalizeDate(record.date);
        if (!date) return null;
        const orders = getDateOrders(groupId, date, true);
        orders[record.key] = record;
        return { date, key: record.key };
      }
    } catch (err) {
      console.error('MongoDB 訂單查找失敗:', err.message);
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
    const orders = await refreshDateOrdersFromMongo(groupId, date);
    if (!orders) return;
    const summary = buildSummary(groupId, date, orders) || `${date}（更新）\n目前無有效訂單\n結算價合計：0\n客收合計：0\n業績合計：0`;
    try {
      await pushMessage(groupId, summary);
    } catch (err) {
      console.error('LINE 定時簡表推送失敗:', err.response?.data || err.message);
    }
  }, 5 * 60 * 1000); // 5分鐘
}

// 測試模式使用 replyToken 即時回覆，不消耗 LINE 每月 Push 訊息額度。
// 正式模式則維持原本的 5 分鐘彙整後 Push。
async function sendOrScheduleSummary(replyToken, groupId, date) {
  if (!TEST_MODE) {
    scheduleFlush(groupId, date);
    return;
  }

  const orders = await refreshDateOrdersFromMongo(groupId, date);
  if (!orders) return;
  const summary = buildSummary(groupId, date, orders) || `${date}（更新）\n目前無有效訂單\n結算價合計：0\n客收合計：0\n業績合計：0`;
  await replyMessage(replyToken, summary);
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
async function runDailyScheduler(now = new Date()) {
  if (TEST_MODE) return; // 測試模式全面停用 Push，避免消耗每月額度
  const businessNow = getBusinessDateParts(now);
  const dateStr = `${businessNow.month}/${businessNow.day}`;
  if (businessNow.hour === 23 && businessNow.minute === 50 && lastScheduledDate !== dateStr) {
    lastScheduledDate = dateStr;
    // 發當天有異動的簡表
    for (const groupId of Object.keys(groupIds)) {
      if (hasChanges[groupId]?.[dateStr] && dailyOrders[groupId]?.[dateStr]) {
        const summary = buildSummary(groupId, dateStr, dailyOrders[groupId][dateStr]);
        if (summary) {
          try {
            await pushMessage(groupId, summary);
          } catch (err) {
            console.error('LINE 每日更新推送失敗:', err.response?.data || err.message);
          }
        }
      }
    }
  }
}

if (!IS_TEST_RUNTIME) {
  setInterval(() => runDailyScheduler().catch(err => {
    console.error('每日排程執行失敗:', err.message);
  }), 60 * 1000);
}

// 記錄群組ID
const groupIds = {};
const sourceQueues = new Map();

async function acquireSourceQueue(sourceId) {
  const previous = (sourceQueues.get(sourceId) || Promise.resolve()).catch(() => {});
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  sourceQueues.set(sourceId, tail);
  await previous;
  return () => {
    releaseGate();
    if (sourceQueues.get(sourceId) === tail) sourceQueues.delete(sourceId);
  };
}

app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.status(403).send('Forbidden');
  try {
    const events = req.body.events || [];
    for (const event of events) {
    const sourceId = event.source?.groupId || event.source?.roomId || event.source?.userId;
    if (!sourceId) continue;

    // 客服在 LINE 收回原訂單訊息時，立即依原訊息 ID 將該訂單標記取消。
    if (event.type === 'unsend') {
      const releaseSourceQueue = await acquireSourceQueue(sourceId);
      try {
        groupIds[sourceId] = true;
        await handleLineUnsend(sourceId, event.unsend?.messageId);
      } finally {
        releaseSourceQueue();
      }
      continue;
    }

    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const rawText = event.message.text.trim();
    // 移除零寬字元、BOM等不可見字元，避免破壞正則比對（常見於手機輸入法/轉發訊息）
    const text = rawText.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, (ch) => ch === '\u00A0' ? ' ' : '');
    const auditContext = {
      senderId: event.source.userId,
      conversationType: event.source.type || (event.source.groupId ? 'group' : event.source.roomId ? 'room' : 'user'),
      messageId: event.message.id,
    };
    const releaseSourceQueue = await acquireSourceQueue(sourceId);
    try {
      groupIds[sourceId] = true;

    // ── 測試指令：使用 Reply API，不計入每月 Push 訊息額度 ──
    if (text === '測試') {
      await replyMessage(event.replyToken, `BOT 測試成功 ✅\n版本：${BOT_VERSION}`);
      continue;
    }

    // 只讀診斷：可指定服務日，例如「群組診斷 9/10」。
    // 不新增、不取消、不修改任何訂單。
    const diagnosticMatch = text.match(/^群組診斷(?:\s*(\d{1,2}\/\d{1,2}))?$/);
    if (diagnosticMatch) {
      const report = await buildGroupDiagnostic(sourceId, auditContext, new Date(), diagnosticMatch[1] || null);
      await replyMessage(event.replyToken, report);
      continue;
    }

    // 舊式日期修正指令全面停用。修正前必須先執行當下台灣日期的只讀診斷，
    // 再由管理者確認實際正確訂單，避免把其他群組或合法訂單誤取消。
    if (/^修正\s*\d{1,2}\/\d{1,2}$/.test(text)) {
      await replyMessage(event.replyToken,
        `安全保護：舊式「${text}」指令已停用，沒有修改任何資料。\n請先輸入「群組診斷」。`
      );
      continue;
    }

    // ── 0. 月結查詢：「月結」或「月結 8月」──
    const monthCmd = parseMonthCommand(text);
    if (monthCmd !== null) {
      const report = await buildMonthlyReport(sourceId, monthCmd);
      await replyMessage(event.replyToken, report);
      continue;
    }

    // ── 明確撤回：支援「編號 拉回改派／改派／收回」及動作在前的寫法 ──
    // 這類只有指令、沒有新訂單內容的訊息，一律移除原單並留下禁止復活標記。
    const withdrawSuffixM = text.match(/^([A-Z0-9]{6,15})\s*(?:[+＋]\s*)?(拉回改派|改派|收回)$/);
    const withdrawPrefixM = text.match(/^(拉回改派|改派|收回)\s*(?:[+＋]\s*)?([A-Z0-9]{6,15})$/);
    if (withdrawSuffixM || withdrawPrefixM) {
      const orderId = withdrawSuffixM ? withdrawSuffixM[1] : withdrawPrefixM[2];
      const action = withdrawSuffixM ? withdrawSuffixM[2] : withdrawPrefixM[1];
      const reason = `客服${action}`;
      const found = await findOrderDate(sourceId, orderId);
      if (found) {
        // 清除記憶體內同編號的所有日期版本，避免舊版留下的重複紀錄進入排程簡表。
        const normalizedId = orderId.replace(/\s/g, '');
        for (const [date, dateOrders] of Object.entries(dailyOrders[sourceId] || {})) {
          for (const [key, order] of Object.entries(dateOrders)) {
            const sameKey = key.replace(/\s/g, '') === normalizedId;
            const sameOrderId = order?.orderId && String(order.orderId).replace(/\s/g, '') === normalizedId;
            if (sameKey || sameOrderId) {
              dateOrders[key] = null;
              setChanged(sourceId, date);
            }
          }
        }
        await markOrderCancelledInMongo(sourceId, found.date, found.key, reason);
      }
      const blocked = await blockOrderReactivation(sourceId, orderId, reason, auditContext);
      if (!blocked) {
        await replyMessage(event.replyToken,
          `處理失敗：無法在資料庫保存 ${orderId} 的${action}狀態，請聯繫管理員查看 Render Logs。`);
      } else if (found) {
        await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
      } else {
        await replyMessage(event.replyToken,
          `${orderId} 已標記為${action}；即使原訂單稍後再次送達，也不會加入簡表或月結。`);
      }
      continue;
    }

    // ── 1. 取消：「XXX 訂單取消」或「XXX 取消」──
    const cancelM = text.match(/([A-Z0-9]{6,15})\s*(訂單取消|取消)/);
    if (cancelM) {
      const orderId = cancelM[1];
      const found = await findOrderDate(sourceId, orderId);
      if (found) {
        getDateOrders(sourceId, found.date, true)[found.key] = null;
        setChanged(sourceId, found.date);
        await markOrderCancelledInMongo(sourceId, found.date, found.key, '客服取消');
        await blockOrderReactivation(sourceId, orderId, '客服取消', auditContext);
        await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
      } else {
        await replyMessage(event.replyToken, `找不到訂單 ${orderId}，沒有取消任何資料。`);
      }
      continue;
    }

    // ── 2. 拉回改派：「拉回改派 XXXX」→ 先移除，等新訂單進來 ──
    const pullReassignM = text.match(/拉回改派\s*([A-Z0-9]{6,15})/);
    if (pullReassignM) {
      const orderId = pullReassignM[1];
      const found = await findOrderDate(sourceId, orderId);
      if (found) {
        getDateOrders(sourceId, found.date, true)[found.key] = null;
        setChanged(sourceId, found.date);
        await markOrderCancelledInMongo(sourceId, found.date, found.key, '客服拉回改派');
        await blockOrderReactivation(sourceId, orderId, '客服拉回改派', auditContext);
        await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
      } else {
        await replyMessage(event.replyToken, `找不到訂單 ${orderId}，沒有拉回或改派任何資料。`);
      }
      continue;
    }

    // ── 3. 改派：「XXX 改派」+ 新訂單內容 ──
    const reassignM = text.match(/([A-Z0-9]{6,15})\s*改派/);
    if (reassignM) {
      const oldId = reassignM[1];
      const newOrders = parseOrders(text);
      // 必須先確認新訂單完整可辨識，才取消舊訂單，避免改派訊息格式錯誤造成原單遺失。
      if (!newOrders.length || newOrders.some(order => !normalizeDate(order.date))) {
        await replyMessage(event.replyToken, `改派停止：無法辨識新訂單內容，舊訂單 ${oldId} 未變更。`);
        continue;
      }
      const found = await findOrderDate(sourceId, oldId);
      if (!found) {
        await replyMessage(event.replyToken, `改派停止：找不到舊訂單 ${oldId}，沒有變更任何資料。`);
        continue;
      }
      const stagedOrders = [];
      let writeFailed = false;
      const suppressedOrders = [];
      for (const [orderIndex, o] of newOrders.entries()) {
        const date = normalizeDate(o.date);
        o.lineMessageId = String(event.message.id);
        const key = getOrderStorageKey(o, event.message.id, orderIndex);
        const saved = await saveOrderToMongo(sourceId, date, key, o, auditContext);
        if (saved === 'suppressed') suppressedOrders.push(key);
        else if (!saved) writeFailed = true;
        else stagedOrders.push({ o, date, key });
      }
      if (suppressedOrders.length) {
        await replyMessage(event.replyToken,
          `改派停止：新訂單 ${suppressedOrders.join('、')} 已被標記為拉回、改派或收回，不會重新加入簡表。`);
        continue;
      }
      if (writeFailed) {
        await replyMessage(event.replyToken,
          `改派停止：新訂單無法完整寫入資料庫，舊訂單 ${oldId} 保留。\n請勿重複操作，先聯繫管理員查看 Render Logs。`);
        continue;
      }
      for (const { o, date, key } of stagedOrders) {
        getDateOrders(sourceId, date, true)[key] = o;
        setChanged(sourceId, date);
      }
      const replacementKeys = new Set(stagedOrders.map(item => `${item.date}|${item.key}`));
      if (!replacementKeys.has(`${found.date}|${found.key}`)) {
        getDateOrders(sourceId, found.date, true)[found.key] = null;
        setChanged(sourceId, found.date);
        await markOrderCancelledInMongo(sourceId, found.date, found.key, '改派原單');
        await blockOrderReactivation(sourceId, found.key, '改派原單', auditContext);
      }
      const date = normalizeDate(newOrders[0]?.date);
      await sendOrScheduleSummary(event.replyToken, sourceId, date);
      continue;
    }

    // ── 4. 拉回：「XXX 拉回」或「XXX ...拉回」或「我先拉回」──
    const pullbackM = text.match(/([A-Z0-9]{6,15})[^\n]*拉回/) || text.match(/拉回/);
    if (pullbackM) {
      if (pullbackM[1]) {
        const orderId = pullbackM[1];
        const found = await findOrderDate(sourceId, orderId);
        if (found) {
          getDateOrders(sourceId, found.date, true)[found.key] = null;
          setChanged(sourceId, found.date);
          await markOrderCancelledInMongo(sourceId, found.date, found.key, '客服拉回');
          await blockOrderReactivation(sourceId, orderId, '客服拉回', auditContext);
          await sendOrScheduleSummary(event.replyToken, sourceId, found.date);
        } else {
          await replyMessage(event.replyToken, `找不到訂單 ${orderId}，沒有拉回任何資料。`);
        }
      } else {
        await replyMessage(event.replyToken, '拉回停止：訊息中沒有訂單編號，請輸入「訂單編號 拉回」。');
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
      const orders = getDateOrders(sourceId, date, true);
      const key = `placeholder|${hour}|${type}`;
      orders[key] = {
        isPlaceholder: true,
        hour, type,
        time: `${String(hour).padStart(2,'0')}:00`,
        display: `補${hour}${type}`,
      };
      setChanged(sourceId, date);
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
      const orders = getDateOrders(sourceId, date, true);
      const key = `shuttle|${time}|${label}`;
      orders[key] = {
        isShuttle: true,
        time,
        display: paxNote ? `${label}，${paxNote}` : label,
      };
      setChanged(sourceId, date);
      await sendOrScheduleSummary(event.replyToken, sourceId, date);
      continue;
    }

    // ── 6. 新訂單（一般訂單、外車格式一二三四五）──
    const coreOrderFieldCount = [
      /出發日期/, /乘車人數/, /行李數量/, /航班編號/,
      /上車地點/, /中間點/, /下車地點/, /其他備註/,
      /聯絡人/, /(?:^|\n)\s*(?:電話|手機)[：:]/,
      /客收\s*[：:]?\s*[\d,]+/, /結(?:算|單)價\s*[：:]?\s*[\d,]+/,
    ].filter(pattern => pattern.test(text)).length;
    const looksLikeOrder =
      (coreOrderFieldCount >= 4 && /出發日期|上車地點|下車地點/.test(text)) || // 一般訂單、無標題自客單、格式不完整的疑似訂單
      (text.match(/用車日期/) && text.match(/搭車地區/)) ||  // 外車格式二
      (text.match(/時間[：:]/) && text.match(/貴賓[：:]/)) || // 外車格式三
      (text.includes('\t') && text.split('\t').length >= 15); // 外車格式四五

    if (looksLikeOrder) {
      const newOrders = parseOrders(text);
      if (!newOrders.length || newOrders.some(order => !normalizeDate(order.date))) {
        await replyMessage(event.replyToken, '訂單格式無法完整辨識，沒有儲存任何資料。請檢查日期、時間及上下車地點；只有客收也可以儲存。');
        continue;
      }
      const stagedOrders = [];
      let writeFailed = false;
      const suppressedOrders = [];
      for (const [orderIndex, o] of newOrders.entries()) {
        const date = normalizeDate(o.date);
        lastActiveDate[sourceId] = date; // 記錄最近使用的日期
        o.lineMessageId = String(event.message.id);
        const key = getOrderStorageKey(o, event.message.id, orderIndex);
        const saved = await saveOrderToMongo(sourceId, date, key, o, auditContext);
        if (saved === 'suppressed') suppressedOrders.push(key);
        else if (!saved) writeFailed = true;
        else stagedOrders.push({ o, date, key });
      }
      if (writeFailed) {
        await replyMessage(event.replyToken,
          '訂單儲存失敗：資料庫未連線或寫入失敗，本次不回覆成功簡表。\n可稍後安全重貼原訂單，同一訂單編號不會重複計算。'
        );
        continue;
      }
      if (!stagedOrders.length && suppressedOrders.length) {
        await replyMessage(event.replyToken,
          `已忽略訂單 ${suppressedOrders.join('、')}：該訂單已標記為拉回、改派或收回，不會重新加入簡表或月結。`);
        continue;
      }
      for (const { o, date, key } of stagedOrders) {
        const orders = getDateOrders(sourceId, date, true);
        // 檢查是否能取代某個補單佔位（同方向 + 同整點時段）
        const oHour = parseInt(o.time.split(':')[0]);
        const oType = o.type === '接' ? '接' : '送';
        const placeholderKey = `placeholder|${oHour}|${oType}`;
        if (orders[placeholderKey]?.isPlaceholder) delete orders[placeholderKey];
        orders[key] = o;
      }
      const date = normalizeDate(newOrders[0]?.date);
      if (newOrders.length) await sendOrScheduleSummary(event.replyToken, sourceId, date);
    }
    } finally {
      releaseSourceQueue();
    }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook 處理失敗:', err.response?.data || err.message);
    // 回傳 500 讓 LINE 可以重送；MongoDB 寫入採 upsert，重送不會重複累加。
    return res.status(500).send('Webhook processing failed');
  }
});

function getBusinessDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function getTodayStr(date = new Date()) {
  const now = getBusinessDateParts(date);
  return `${now.month}/${now.day}`;
}

function extractServiceYear(dateStr) {
  if (dateStr) {
    const fullDate = String(dateStr).match(/(\d{4})[-\/]\d{1,2}[-\/]\d{1,2}/);
    if (fullDate) return Number(fullDate[1]);
  }
  return getBusinessDateParts().year;
}

// 統一日期格式為 M/D（處理 2026-06-27、2026/07/23、7/21 等格式）
function normalizeDate(dateStr) {
  // 訂單缺少服務日時不可偷偷改成今天，否則預派單會被存到錯誤日期。
  if (!dateStr) return null;
  const m = String(dateStr).match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    return isValidCalendarDate(year, month, day) ? `${month}/${day}` : null;
  }
  const m2 = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m2) {
    const { year } = getBusinessDateParts();
    const month = Number(m2[1]);
    const day = Number(m2[2]);
    return isValidCalendarDate(year, month, day) ? `${month}/${day}` : null;
  }
  return null;
}

function isValidCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

// ════════════════════════════════════════
// 月結統計
// ════════════════════════════════════════

// 中文數字/阿拉伯數字月份解析：「月結」「月結 8月」「月結8」
function parseMonthCommand(text) {
  const m = text.match(/^月結\s*(\d{1,2})\s*月?$/);
  if (m) {
    const month = parseInt(m[1]);
    return month >= 1 && month <= 12 ? month : null;
  }
  if (text.trim() === '月結') {
    return getBusinessDateParts().month; // 台灣時間的當月
  }
  return null;
}

// 群組隔離診斷：只讀取執行指令的群組。
// 訂單通常會提前調派，因此「執行時間」與「檢查服務日」必須分開顯示。
async function buildGroupDiagnostic(groupId, auditContext = {}, now = new Date(), requestedDate = null) {
  const businessNow = getBusinessDateParts(now);
  const executionDate = `${businessNow.month}/${businessNow.day}`;
  let date = requestedDate
    ? normalizeDate(requestedDate)
    : (lastActiveDate[groupId] ? normalizeDate(lastActiveDate[groupId]) : null);
  let serviceYear = businessNow.year;
  const groupCode = anonymizeId(groupId);
  const senderCode = anonymizeId(auditContext.senderId);

  if (requestedDate && !date) {
    return `群組診斷停止：「${requestedDate}」不是有效日期，沒有修改任何資料。\n請使用例如「群組診斷 9/10」。`;
  }

  // 沒指定日期且本機沒有該群組的最近日期時，從 MongoDB 只找該群組最近更新的有效訂單。
  if (!requestedDate && !date && ordersCollection) {
    try {
      const latest = await ordersCollection.find({ groupId, cancelled: false })
        .sort({ updatedAt: -1 }).limit(1).toArray();
      if (latest[0]) {
        date = normalizeDate(latest[0].date);
        serviceYear = Number(latest[0].serviceYear) || businessNow.year;
      }
    } catch (err) {
      console.error('群組最近服務日查詢失敗:', err.message);
    }
  }

  if (!date) date = executionDate;
  const memoryOrders = Object.values(getDateOrders(groupId, date) || {})
    .filter(order => order && !order.isPlaceholder && !order.isShuttle);

  if (!ordersCollection) {
    return [
      '群組診斷（只讀）',
      `Bot版本：${BOT_VERSION}`,
      `執行時間：${executionDate} ${String(businessNow.hour).padStart(2, '0')}:${String(businessNow.minute).padStart(2, '0')}`,
      `檢查服務日：${date}`,
      `群組代碼：${groupCode}`,
      `發送者代碼：${senderCode}`,
      `群組類型：${auditContext.conversationType || 'unknown'}`,
      `記憶體有效訂單：${memoryOrders.length} 筆`,
      'MongoDB：未連線（沒有修改任何資料）',
    ].join('\n');
  }

  try {
    const records = dedupeOrderRecords(await ordersCollection.find({
      groupId,
      serviceYear,
      date,
      cancelled: false,
    }).sort({ time: 1, updatedAt: 1 }).toArray());
    const activeOrders = records.filter(record => !record.isPlaceholder && !record.isShuttle);
    const validOrders = activeOrders.filter(record => typeof record.price === 'number');
    const pendingPriceCount = activeOrders.filter(record =>
      typeof record.price !== 'number' && getCustomerCollectionTotal(record) <= 0
    ).length;
    const settlementTotal = validOrders.reduce((sum, record) => sum + record.price, 0);
    const customerCollectionTotal = activeOrders.reduce(
      (sum, record) => sum + getCustomerCollectionTotal(record), 0
    );
    const performanceTotal = settlementTotal + customerCollectionTotal;
    const senderKeys = new Set(records.map(record => record.senderKey || '舊資料').filter(Boolean));
    const orderLines = activeOrders.slice(0, 25).map((record, index) => {
      const location = record.type === '接' ? `接${record.loc || '?'}` : `${record.loc || '?'}送`;
      const price = typeof record.price === 'number'
        ? fmtP(record.price)
        : (getCustomerCollectionTotal(record) > 0 ? '客收計價' : '待確認金額');
      const remarks = Array.isArray(record.remarks) && record.remarks.length
        ? `，${record.remarks.join('、')}` : '';
      return `${index + 1}。${record.time || '時間待確認'}，${location}，${price}${remarks}`;
    });
    if (activeOrders.length > 25) orderLines.push(`其餘 ${activeOrders.length - 25} 筆省略`);

    return [
      '群組診斷（只讀，未修改資料）',
      `Bot版本：${BOT_VERSION}`,
      `執行時間：${executionDate} ${String(businessNow.hour).padStart(2, '0')}:${String(businessNow.minute).padStart(2, '0')}`,
      `檢查服務日：${date}`,
      `群組代碼：${groupCode}`,
      `發送者代碼：${senderCode}`,
      `群組類型：${auditContext.conversationType || 'unknown'}`,
      `記憶體有效訂單：${memoryOrders.length} 筆`,
      `MongoDB有效訂單：${activeOrders.length} 筆`,
      `結算價總額：${fmtP(settlementTotal)}`,
      `客收總額：${fmtP(customerCollectionTotal)}`,
      `業績總額：${fmtP(performanceTotal)}${pendingPriceCount ? '+待確認' : ''}`,
      ...(pendingPriceCount ? [`待確認金額：${pendingPriceCount} 筆`] : []),
      `資料內發單者：${senderKeys.size} 種（舊資料可能沒有發送者代碼）`,
      '服務日訂單：',
      ...(orderLines.length ? orderLines : ['無']),
    ].join('\n');
  } catch (err) {
    console.error('群組診斷失敗:', err.message);
    return `群組診斷失敗：${date} 的資料無法讀取，沒有修改任何資料。`;
  }
}

// 一次性修正 9/7 資料：
// 1. 限測試模式使用。
// 2. 必須完整找到以下 8 趟，任何一趟不吻合便整批停止。
// 3. 多餘紀錄只標記為取消，不永久刪除，保留回復可能。
async function repairSeptember7(groupId) {
  if (!TEST_MODE) {
    return '安全保護：只有 TEST_MODE=true 時才能執行「修正9/7」。';
  }
  if (!ordersCollection) {
    return '修正停止：資料庫目前未連線，沒有變更任何資料。';
  }

  const expectedOrders = [
    { time: '00:10', type: '接', loc: ['台北土城','新北土城','新北市土城區'], pax: 2, price: 866 },
    { time: '02:15', type: '接', loc: ['新北中和','新北市中和區'], pax: 1, price: 637 },
    { time: '05:00', type: '送', loc: ['新北新店','新北市新店區'], pax: 1, price: 983 },
    { time: '08:30', type: '送', loc: ['新北板橋','新北市板橋區'], pax: 1, price: 665 },
    { time: '10:30', type: '送', loc: ['台北萬華','台北市萬華區'], pax: 4, price: 650 },
    { time: '11:00', type: '接', loc: ['台北中正','台北市中正區'], pax: 1, price: 637 },
    { time: '14:00', type: '送', loc: ['台北中正','台北市中正區'], pax: 1, price: 530 },
    { time: '15:20', type: '接', loc: ['台北北投','台北市北投區'], pax: 1, price: 750 },
  ];

  try {
    const records = await ordersCollection.find({
      groupId,
      serviceYear: 2026,
      cancelled: false,
      date: { $regex: /^0?9\/0?7$/ },
    }).sort({ updatedAt: -1 }).toArray();

    const usedIds = new Set();
    const keptRecords = [];
    const missing = [];

    for (const expected of expectedOrders) {
      const matched = records.find(record => {
        const recordId = String(record._id);
        if (usedIds.has(recordId)) return false;
        return String(record.time || '').trim() === expected.time &&
          record.type === expected.type &&
          expected.loc.includes(String(record.loc || '').trim()) &&
          parseInt(String(record.pax), 10) === expected.pax &&
          Number(record.price) === expected.price;
      });

      if (!matched) {
        missing.push(`${expected.time} ${expected.type}${expected.loc[expected.loc.length - 1]} ${expected.pax}人 ${fmtP(expected.price)}`);
        continue;
      }

      usedIds.add(String(matched._id));
      keptRecords.push(matched);
    }

    if (missing.length) {
      return [
        '修正停止：資料庫中的資料無法完整對上正確的 8 趟，因此沒有變更任何資料。',
        '未找到：',
        ...missing.map(item => `・${item}`),
      ].join('\n');
    }

    const extraRecords = records.filter(record => !usedIds.has(String(record._id)));
    const correctedAt = new Date();
    const operations = [
      ...keptRecords.map(record => ({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: {
              date: '9/7',
              serviceYear: 2026,
              cancelled: false,
              verifiedByCorrection: true,
              correctedAt,
            },
          },
        },
      })),
      ...extraRecords.map(record => ({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: {
              cancelled: true,
              correctionReason: '9/7人工核對：不在正確8趟名單內',
              correctedAt,
            },
          },
        },
      })),
    ];

    if (operations.length) {
      // MongoDB Atlas 支援交易：正式環境整批成功或整批回復，避免只修到一半。
      const session = mongoClient?.startSession ? mongoClient.startSession() : null;
      if (session) {
        try {
          await session.withTransaction(async () => {
            await ordersCollection.bulkWrite(operations, { ordered: true, session });
          });
        } finally {
          await session.endSession();
        }
      } else {
        // 自動化測試使用的假資料庫沒有 session。
        await ordersCollection.bulkWrite(operations, { ordered: true });
      }
    }

    const report = await buildMonthlyReport(groupId, 9, 2026);
    return [
      '9/7 修正完成 ✅',
      `保留：${keptRecords.length} 趟`,
      `排除多餘紀錄：${extraRecords.length} 筆（僅標記取消，未永久刪除）`,
      '',
      report,
    ].join('\n');
  } catch (err) {
    console.error('9/7 資料修正失敗:', err.message);
    return '修正失敗：資料庫操作發生錯誤，請查看 Render Logs；請勿重複輸入，先聯繫管理員確認。';
  }
}

// 從 MongoDB 撈出指定月份「未取消」的訂單，計算統計數據
async function buildMonthlyReport(groupId, month, year = getBusinessDateParts().year) {
  if (!ordersCollection) {
    return '月結功能目前無法使用（資料庫未連線），請聯繫管理員確認設定。';
  }

  // date 欄位格式為 M/D（無年份），用正則篩選「月份/」開頭的資料
  const datePattern = new RegExp(`^${month}/\\d{1,2}$`);

  let records;
  try {
    records = dedupeOrderRecords(await ordersCollection.find({
      groupId,
      serviceYear: year,
      cancelled: false,
      date: { $regex: datePattern },
    }).toArray());
  } catch (err) {
    console.error('月結查詢失敗:', err.message);
    return '月結查詢時發生錯誤，請稍後再試。';
  }

  const activeOrders = records.filter(r => !r.isPlaceholder && !r.isShuttle);
  if (!activeOrders.length) {
    return `${year}年${month}月尚無有效訂單紀錄，無法產生月結報表。`;
  }

  let settlementTotal = 0;
  let customerCollectionTotal = 0;
  let pendingPriceCount = 0;
  const kesuCount = { count: 0 };
  const remarkCount = { 舉牌: 0, 安椅: 0, 增高墊: 0 };
  const dailyStats = {};

  activeOrders.forEach(o => {
    if (!dailyStats[o.date]) {
      dailyStats[o.date] = { count: 0, settlement: 0, customerCollection: 0, pending: 0 };
    }
    const stats = dailyStats[o.date];
    stats.count++;
    if (typeof o.price === 'number') {
      settlementTotal += o.price;
      stats.settlement += o.price;
    } else if (getCustomerCollectionTotal(o) <= 0) {
      pendingPriceCount++;
      stats.pending++;
    }
    const orderCustomerCollection = getCustomerCollectionTotal(o);
    customerCollectionTotal += orderCustomerCollection;
    stats.customerCollection += orderCustomerCollection;
    (o.remarks || []).forEach(r => {
      if (r.startsWith('客收')) {
        kesuCount.count++;
      } else if (remarkCount[r] !== undefined) {
        remarkCount[r]++;
      }
    });
  });

  const tripCount = activeOrders.length;
  const performanceTotal = settlementTotal + customerCollectionTotal;
  const avgPerTrip = performanceTotal / tripCount;
  const pendingSuffix = pendingPriceCount ? '+待確認' : '';
  const sortedDates = Object.keys(dailyStats).sort((a, b) => {
    const [aMonth, aDay] = a.split('/').map(Number);
    const [bMonth, bDay] = b.split('/').map(Number);
    return (aMonth * 100 + aDay) - (bMonth * 100 + bDay);
  });
  const firstDate = sortedDates[0];
  const lastDate = sortedDates[sortedDates.length - 1];

  const lines = [];
  lines.push(`${year}年${month}月結算報表`);
  lines.push(`資料涵蓋：${firstDate}${firstDate === lastDate ? '' : `～${lastDate}`}`);
  lines.push('統計口徑：未取消；業績＝結算價＋客收');
  lines.push(`總趟數：${tripCount} 趟`);
  lines.push(`結算價總額：${fmtP(settlementTotal)}${pendingSuffix}`);
  lines.push(`客收總額：${fmtP(customerCollectionTotal)}（共${kesuCount.count}筆）`);
  lines.push(`業績總額：${fmtP(performanceTotal)}${pendingSuffix}`);
  if (pendingPriceCount) {
    lines.push(`待確認結算價：${pendingPriceCount} 筆（已知客收仍納入業績）`);
  }
  lines.push(`平均每趟業績：${fmtP(Math.round(avgPerTrip * 10) / 10)}${pendingSuffix}`);
  if (remarkCount.舉牌 > 0) lines.push(`舉牌次數：${remarkCount.舉牌}`);
  if (remarkCount.安椅 > 0) lines.push(`安椅次數：${remarkCount.安椅}`);
  if (remarkCount.增高墊 > 0) lines.push(`增高墊次數：${remarkCount.增高墊}`);
  lines.push('每日明細：');
  sortedDates.forEach(date => {
    const stats = dailyStats[date];
    const dailyPerformance = stats.settlement + stats.customerCollection;
    const dailyPendingSuffix = stats.pending ? '+待確認' : '';
    lines.push(`${date}：${stats.count} 趟，結算價${fmtP(stats.settlement)}${dailyPendingSuffix}，客收${fmtP(stats.customerCollection)}，業績${fmtP(dailyPerformance)}${dailyPendingSuffix}`);
  });

  return lines.join('\n');
}

app.get('/', (req, res) => res.send('訂單簡表 Bot 運行中 ✅'));
app.get('/health', (req, res) => {
  const databaseReady = Boolean(ordersCollection);
  const status = databaseReady ? 200 : 503;
  res.status(status).json({
    status: databaseReady ? 'ok' : 'degraded',
    version: BOT_VERSION,
    lineConfigured: Boolean(CHANNEL_SECRET && CHANNEL_ACCESS_TOKEN),
    databaseReady,
    testMode: TEST_MODE,
    timeZone: BUSINESS_TIME_ZONE,
  });
});

// 每天檢查是否為月底最後一天 23:50，自動發送當月月結
let lastMonthlyReportSent = ''; // 記錄格式 'YYYY-MM'，避免同月重複發送
async function getKnownGroupIds() {
  const ids = new Set(Object.keys(groupIds));
  if (ordersCollection) {
    try {
      const persistedIds = await ordersCollection.distinct('groupId');
      persistedIds.filter(Boolean).forEach(id => ids.add(id));
    } catch (err) {
      console.error('MongoDB 群組清單查詢失敗:', err.message);
    }
  }
  return [...ids];
}

async function runMonthlyScheduler(now = new Date()) {
  if (TEST_MODE) return; // 月結仍可手動輸入「月結」以 Reply API 查詢
  const businessNow = getBusinessDateParts(now);
  if (businessNow.hour !== 23 || businessNow.minute !== 50) return;

  const lastDay = new Date(Date.UTC(businessNow.year, businessNow.month, 0)).getUTCDate();
  if (businessNow.day !== lastDay) return;

  const monthKey = `${businessNow.year}-${businessNow.month}`;
  if (lastMonthlyReportSent === monthKey) return;
  lastMonthlyReportSent = monthKey;

  for (const groupId of await getKnownGroupIds()) {
    const report = await buildMonthlyReport(groupId, businessNow.month, businessNow.year);
    try {
      await pushMessage(groupId, report);
    } catch (err) {
      console.error('LINE 月結推送失敗:', err.response?.data || err.message);
    }
  }
}

if (!IS_TEST_RUNTIME) {
  setInterval(() => runMonthlyScheduler().catch(err => {
    console.error('月結排程執行失敗:', err.message);
  }), 60 * 1000);
}

// ── 防止 Render 免費方案休眠：每 13 分鐘自我 ping 一次 ──
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://order-bot-45x0.onrender.com';
if (!IS_TEST_RUNTIME) {
  setInterval(() => {
    axios.get(SELF_URL).catch(() => {}); // 失敗也沒關係，純粹是為了保持喚醒
  }, 13 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
if (!IS_TEST_RUNTIME) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// 只供自動化測試使用；正式執行時不影響 Bot 行為。
module.exports = {
  app,
  REGIONS_BY_CITY,
  parseAddr,
  parseAddrNoDefault,
  parseOrders,
  parseTransferOrder,
  parseDriverReportOrder,
  parseTableOrder,
  toLineMessages,
  buildSummary,
  normalizeDate,
  extractServiceYear,
  getBusinessDateParts,
  getTodayStr,
  parseMonthCommand,
  verifySignature,
  getDateOrders,
  setChanged,
  findOrderDate,
  runDailyScheduler,
  runMonthlyScheduler,
  acquireSourceQueue,
  saveOrderToMongo,
  markOrderCancelledInMongo,
  blockOrderReactivation,
  handleLineUnsend,
  buildMonthlyReport,
  buildGroupDiagnostic,
  anonymizeId,
  getOrderStorageKey,
  dedupeOrderRecords,
  repairSeptember7,
  __setOrdersCollectionForTests(collection) {
    if (!IS_TEST_RUNTIME) throw new Error('僅限測試環境');
    ordersCollection = collection;
  },
  __state: { dailyOrders, hasChanges, lastActiveDate, groupIds },
};
